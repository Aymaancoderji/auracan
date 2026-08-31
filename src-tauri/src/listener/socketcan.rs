use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use crossbeam_channel::Sender;
use socketcan::tokio::CanSocket;
use socketcan::{EmbeddedFrame, ExtendedId, Id, StandardId};

use crate::can::CanFrame;

/// `ARPHRD_CAN`, the Linux network device type reported by SocketCAN
/// interfaces in `/sys/class/net/<iface>/type`.
const ARPHRD_CAN: u16 = 280;

/// Lists SocketCAN-capable network interfaces currently present on the
/// system, so the UI can offer a picker instead of requiring the user to
/// know and type an interface name (e.g. `vcan0`, `can0`) by hand.
pub fn list_can_interfaces() -> Vec<String> {
    list_can_interfaces_under("/sys/class/net")
}

/// Same as [`list_can_interfaces`] but scanning an arbitrary directory
/// instead of the real `/sys/class/net`, so the filtering logic can be
/// exercised in tests without root or a real CAN interface.
fn list_can_interfaces_under(net_dir: &str) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(entries) = fs::read_dir(net_dir) else {
        return names;
    };
    for entry in entries.flatten() {
        let type_path = entry.path().join("type");
        if let Ok(contents) = fs::read_to_string(&type_path) {
            if contents.trim().parse::<u16>() == Ok(ARPHRD_CAN) {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    names
}

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
        self.record_frame_at(dlc, is_extended, now_us())
    }

    /// Same as [`Self::record_frame`] but with the current time passed in
    /// explicitly, so window-elapsed behavior can be tested deterministically
    /// instead of depending on wall-clock sleeps.
    fn record_frame_at(&mut self, dlc: u8, is_extended: bool, now: u64) -> Option<f64> {
        let overhead_bits: u64 = if is_extended { 67 } else { 47 };
        let payload_bits = dlc as u64 * 8;
        self.window_bits += overhead_bits + payload_bits;

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

/// Why [`poll_frames`] stopped reading.
pub enum StreamExit {
    /// The caller requested a clean stop via `cancel_rx`.
    Cancelled,
    /// The socket read failed — typically because the interface went down
    /// or was removed (e.g. `ip link del vcan0`, a USB-CAN adapter
    /// unplugged). The socket is not usable after this and must be
    /// rebound.
    Disconnected(String),
}

/// Continuously reads frames from the socket and forwards decoded
/// [`CanFrame`] values to `tx`, along with periodic bus-load samples sent
/// through `bus_load_tx`. Runs until the socket errors, the frame receiver
/// is dropped, or the task is cancelled.
pub async fn poll_frames(
    socket: CanSocket,
    tx: Sender<CanFrame>,
    bus_load_tx: Option<Sender<f64>>,
    baud_rate: u32,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> StreamExit {
    let mut monitor = BusLoadMonitor::new(baud_rate, 100_000);

    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return StreamExit::Cancelled;
                }
            }
            frame = socket.read_frame() => {
                match frame {
                    Ok(frame) => {
                        let (id, is_extended) = decode_id(&frame);
                        let data = frame.data();
                        let can_frame = CanFrame::new(id, is_extended, data, now_us());

                        if tx.send(can_frame).is_err() {
                            return StreamExit::Cancelled;
                        }

                        if let Some(load) = monitor.record_frame(can_frame.dlc, is_extended) {
                            if let Some(bl_tx) = &bus_load_tx {
                                let _ = bl_tx.send(load);
                            }
                        }
                    }
                    Err(e) => return StreamExit::Disconnected(e.to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a monitor with a fixed, known `window_start_us` (rather than
    /// `BusLoadMonitor::new`'s real wall-clock start) so window-elapsed
    /// behavior can be asserted exactly instead of racing the clock.
    fn monitor_at(baud_rate: u32, window_us: u64, start_us: u64) -> BusLoadMonitor {
        BusLoadMonitor {
            baud_rate,
            window_bits: 0,
            window_start_us: start_us,
            window_us,
        }
    }

    #[test]
    fn bus_load_monitor_waits_for_the_window_to_elapse() {
        let mut monitor = monitor_at(500_000, 1_000_000, 0);
        // Standard frame, 8-byte payload: 47 + 64 = 111 bits.
        assert_eq!(monitor.record_frame_at(8, false, 100_000), None);
        assert_eq!(monitor.record_frame_at(8, false, 500_000), None);
        // Third frame lands exactly on the 1s window boundary (measured from
        // the window's start, not the first recorded frame): 3 * 111 = 333
        // bits over 1s at 500,000 baud = 0.0666%.
        let load = monitor.record_frame_at(8, false, 1_000_000).expect("window elapsed");
        assert!((load - 0.0666).abs() < 0.001, "load was {load}");
    }

    #[test]
    fn bus_load_monitor_clamps_to_100_percent() {
        let mut monitor = monitor_at(10, 1_000_000, 0);
        assert_eq!(monitor.record_frame_at(8, true, 0), None);
        let load = monitor.record_frame_at(8, true, 1_000_000).expect("window elapsed");
        assert_eq!(load, 100.0);
    }

    #[test]
    fn bus_load_monitor_resets_after_reporting() {
        let mut monitor = monitor_at(500_000, 1_000_000, 0);
        monitor.record_frame_at(8, false, 0);
        monitor.record_frame_at(8, false, 1_000_000).expect("window elapsed");
        // A frame just after the reported window shouldn't immediately
        // report again (accumulated bits reset to zero).
        assert_eq!(monitor.record_frame_at(8, false, 1_000_100), None);
    }

    #[test]
    fn lists_only_can_type_interfaces() {
        let dir = tempfile::tempdir().expect("tempdir");

        let vcan0 = dir.path().join("vcan0");
        std::fs::create_dir(&vcan0).unwrap();
        std::fs::write(vcan0.join("type"), "280\n").unwrap();

        let eth0 = dir.path().join("eth0");
        std::fs::create_dir(&eth0).unwrap();
        std::fs::write(eth0.join("type"), "1\n").unwrap();

        let can1 = dir.path().join("can1");
        std::fs::create_dir(&can1).unwrap();
        std::fs::write(can1.join("type"), "280\n").unwrap();

        let names = list_can_interfaces_under(dir.path().to_str().unwrap());
        assert_eq!(names, vec!["can1".to_string(), "vcan0".to_string()]);
    }

    #[test]
    fn returns_empty_for_a_missing_directory() {
        assert!(list_can_interfaces_under("/nonexistent/path").is_empty());
    }
}
