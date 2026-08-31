use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use serde::Serialize;

/// Fault/diagnostic flags decoded from status frames.
#[derive(Debug, Default, Clone, Serialize)]
pub struct FaultFlags {
    pub bus_off: bool,
    pub thermal_throttle: bool,
    pub over_voltage: bool,
}

/// High-frequency telemetry state store.
///
/// Signal values are kept behind a `RwLock<HashMap>` for simplicity; reads
/// (UI polling at 60Hz) are cheap and writes (CAN frames at up to ~1kHz) are
/// short critical sections, so contention stays low without needing a fully
/// lock-free structure. Frame/error counters use atomics for hot-path
/// increments from the listener task.
pub struct TelemetryStore {
    signals: RwLock<HashMap<String, f64>>,
    faults: RwLock<FaultFlags>,
    frame_count: AtomicU64,
    error_count: AtomicU64,
    last_bus_load_pct: RwLock<f64>,
}

impl Default for TelemetryStore {
    fn default() -> Self {
        Self {
            signals: RwLock::new(HashMap::new()),
            faults: RwLock::new(FaultFlags::default()),
            frame_count: AtomicU64::new(0),
            error_count: AtomicU64::new(0),
            last_bus_load_pct: RwLock::new(0.0),
        }
    }
}

impl TelemetryStore {
    pub fn update_signals(&self, decoded: HashMap<String, f64>) {
        let mut guard = self.signals.write().unwrap();
        guard.extend(decoded);
        self.frame_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> HashMap<String, f64> {
        self.signals.read().unwrap().clone()
    }

    pub fn set_bus_load(&self, pct: f64) {
        *self.last_bus_load_pct.write().unwrap() = pct;
    }

    pub fn bus_load(&self) -> f64 {
        *self.last_bus_load_pct.read().unwrap()
    }

    pub fn set_faults(&self, faults: FaultFlags) {
        *self.faults.write().unwrap() = faults;
    }

    pub fn faults(&self) -> FaultFlags {
        self.faults.read().unwrap().clone()
    }

    pub fn record_error(&self) {
        self.error_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count.load(Ordering::Relaxed)
    }

    pub fn error_count(&self) -> u64 {
        self.error_count.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_signals_merges_and_counts_frames() {
        let store = TelemetryStore::default();
        store.update_signals(HashMap::from([("A".to_string(), 1.0)]));
        store.update_signals(HashMap::from([("B".to_string(), 2.0), ("A".to_string(), 3.0)]));

        let snap = store.snapshot();
        assert_eq!(snap.get("A").copied(), Some(3.0));
        assert_eq!(snap.get("B").copied(), Some(2.0));
        assert_eq!(store.frame_count(), 2);
    }

    #[test]
    fn bus_load_round_trips() {
        let store = TelemetryStore::default();
        assert_eq!(store.bus_load(), 0.0);
        store.set_bus_load(42.5);
        assert_eq!(store.bus_load(), 42.5);
    }

    #[test]
    fn faults_round_trip() {
        let store = TelemetryStore::default();
        assert!(!store.faults().bus_off);
        store.set_faults(FaultFlags {
            bus_off: true,
            thermal_throttle: false,
            over_voltage: true,
        });
        let faults = store.faults();
        assert!(faults.bus_off);
        assert!(!faults.thermal_throttle);
        assert!(faults.over_voltage);
    }

    #[test]
    fn record_error_increments_counter() {
        let store = TelemetryStore::default();
        assert_eq!(store.error_count(), 0);
        store.record_error();
        store.record_error();
        assert_eq!(store.error_count(), 2);
    }
}
