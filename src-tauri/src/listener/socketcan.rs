use std::time::{SystemTime, UNIX_EPOCH};

use crossbeam_channel::Sender;
use socketcan::tokio::CanSocket;
use socketcan::{EmbeddedFrame, ExtendedId, Id, StandardId};

use crate::can::CanFrame;

/// Rolling bus-load estimate over a fixed sample window.
///
/// % Bus Load = bits_transmitted / (baud_rate * window_seconds)
pub struct BusLoadMonitor {
    baud_rate: u32,
    window_bits: u64,
    window_start_us: u64,
    window_us: u64,
}

impl BusLoadMonitor {
    pub fn new(baud_rate: u32, window_us: u64) -> Self {
        Self {
            baud_rate,
            window_bits: 0,
            window_start_us: now_us(),
            window_us,
        }
    }

    /// Records a frame's bit cost (11 or 29-bit header + stuffing overhead
    /// approximated as payload bits + fixed frame overhead) and returns the
    /// current bus load percentage once the window elapses.
    pub fn record_frame(&mut self, dlc: u8, is_extended: bool) -> Option<f64> {
        let overhead_bits: u64 = if is_extended { 67 } else { 47 };
        let payload_bits = dlc as u64 * 8;
        self.window_bits += overhead_bits + payload_bits;

        let now = now_us();
        let elapsed = now.saturating_sub(self.window_start_us);
        if elapsed >= self.window_us {
            let elapsed_secs = elapsed as f64 / 1_000_000.0;
            let load = (self.window_bits as f64) / (self.baud_rate as f64 * elapsed_secs);
            self.window_bits = 0;
            self.window_start_us = now;
            return Some((load * 100.0).min(100.0));
        }
        None
    }
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

/// Opens a non-blocking async SocketCAN socket bound to `interface`
/// (e.g. `vcan0` or `can0`).
pub fn bind_socket(interface: &str) -> Result<CanSocket, String> {
    CanSocket::open(interface).map_err(|e| format!("failed to open {interface}: {e}"))
}

/// Continuously reads frames from the socket and forwards decoded
/// [`CanFrame`] values to `tx`, along with periodic bus-load samples sent
/// through `bus_load_tx`. Runs until the socket errors or the task is
/// cancelled.
pub async fn poll_frames(
    socket: CanSocket,
    tx: Sender<CanFrame>,
    bus_load_tx: Option<Sender<f64>>,
    baud_rate: u32,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let mut monitor = BusLoadMonitor::new(baud_rate, 100_000);

    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    break;
                }
            }
            frame = socket.read_frame() => {
                match frame {
                    Ok(frame) => {
                        let (id, is_extended) = decode_id(&frame);
                        let data = frame.data();
                        let can_frame = CanFrame::new(id, is_extended, data, now_us());

                        if tx.send(can_frame).is_err() {
                            break;
                        }

                        if let Some(load) = monitor.record_frame(can_frame.dlc, is_extended) {
                            if let Some(bl_tx) = &bus_load_tx {
                                let _ = bl_tx.send(load);
                            }
                        }
                    }
                    Err(_) => continue,
                }
            }
        }
    }
}

fn decode_id(frame: &socketcan::CanFrame) -> (u32, bool) {
    match frame.id() {
        Id::Standard(id) => (id.as_raw() as u32, false),
        Id::Extended(id) => (id.as_raw(), true),
    }
}

/// Builds a raw CAN ID for outbound frames (used by test helpers / senders).
pub fn make_id(raw: u32, extended: bool) -> Option<Id> {
    if extended {
        ExtendedId::new(raw).map(Id::Extended)
    } else {
        StandardId::new(raw as u16).map(Id::Standard)
    }
}
