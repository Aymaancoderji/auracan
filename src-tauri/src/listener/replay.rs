use std::fs::File;
use std::io::{BufRead, BufReader};
use std::time::Duration;

use crossbeam_channel::Sender;
use tokio::sync::watch;

use super::candump::parse_line;
use super::socketcan::BusLoadMonitor;
use crate::can::CanFrame;

/// Why [`replay_frames`] stopped.
pub enum ReplayExit {
    /// The caller requested a clean stop.
    Cancelled,
    /// Reached the end of the log file.
    Finished,
    /// The file couldn't be opened.
    Failed(String),
}

/// Replays a `candump -l`-format log file (see [`super::candump`]) through
/// `tx`/`bus_load_tx`, pacing frames according to their recorded
/// timestamps scaled by `speed` (`speed <= 0.0` plays as fast as
/// possible). Feeds the same channels [`super::socketcan::poll_frames`]
/// does, so the rest of the pipeline (decode task, telemetry emitter)
/// doesn't need to know whether frames came from a live bus or a
/// recording. Malformed lines are skipped rather than aborting the replay.
pub async fn replay_frames(
    path: &str,
    tx: Sender<CanFrame>,
    bus_load_tx: Option<Sender<f64>>,
    baud_rate: u32,
    speed: f64,
    mut cancel_rx: watch::Receiver<bool>,
) -> ReplayExit {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => return ReplayExit::Failed(format!("failed to open {path}: {e}")),
    };
    let reader = BufReader::new(file);
    let mut monitor = BusLoadMonitor::new(baud_rate, 100_000);
    let mut prev_ts: Option<u64> = None;

    for line in reader.lines() {
        if *cancel_rx.borrow() {
            return ReplayExit::Cancelled;
        }

        let Ok(line) = line else { continue };
        let Some((timestamp_us, frame)) = parse_line(&line) else {
            continue;
        };

        if let Some(prev) = prev_ts {
            let delta_us = timestamp_us.saturating_sub(prev);
            if delta_us > 0 && speed > 0.0 {
                let scaled = Duration::from_micros((delta_us as f64 / speed) as u64);
                tokio::select! {
                    _ = tokio::time::sleep(scaled) => {}
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return ReplayExit::Cancelled;
                        }
                    }
                }
            }
        }
        prev_ts = Some(timestamp_us);

        if tx.send(frame).is_err() {
            return ReplayExit::Cancelled;
        }

        if let Some(load) = monitor.record_frame(frame.dlc, frame.is_extended) {
            if let Some(bl_tx) = &bus_load_tx {
                let _ = bl_tx.send(load);
            }
        }
    }

    ReplayExit::Finished
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[tokio::test]
    async fn replays_every_frame_and_reports_finished() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(file, "(1690000000.000000) vcan0 100#dc0500000000").unwrap();
        writeln!(file, "(1690000000.001000) vcan0 101#41").unwrap();
        writeln!(file, "not a candump line").unwrap(); // skipped
        writeln!(file, "(1690000000.002000) vcan0 102#0102").unwrap();

        let (tx, rx) = crossbeam_channel::unbounded();
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        // speed <= 0.0 plays back-to-back with no inter-frame sleeps, so the
        // test doesn't depend on wall-clock pacing.
        let exit = replay_frames(file.path().to_str().unwrap(), tx, None, 500_000, 0.0, cancel_rx).await;
        assert!(matches!(exit, ReplayExit::Finished));

        let frames: Vec<CanFrame> = rx.try_iter().collect();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].id, 0x100);
        assert_eq!(frames[1].id, 0x101);
        assert_eq!(frames[2].id, 0x102);
    }

    #[tokio::test]
    async fn reports_failure_for_a_missing_file() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let exit = replay_frames("/nonexistent/path.log", tx, None, 500_000, 1.0, cancel_rx).await;
        assert!(matches!(exit, ReplayExit::Failed(_)));
    }

    #[tokio::test]
    async fn cancellation_stops_replay_early() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        // A long inter-frame gap so cancellation fires during the sleep.
        writeln!(file, "(1690000000.000000) vcan0 100#00").unwrap();
        writeln!(file, "(1690000010.000000) vcan0 101#00").unwrap();

        let (tx, rx) = crossbeam_channel::unbounded();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let path = file.path().to_str().unwrap().to_string();
        let handle = tokio::spawn(async move { replay_frames(&path, tx, None, 500_000, 1.0, cancel_rx).await });

        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_tx.send(true).unwrap();

        let exit = handle.await.unwrap();
        assert!(matches!(exit, ReplayExit::Cancelled));
        assert_eq!(rx.try_iter().count(), 1); // only the first frame got through
    }
}
