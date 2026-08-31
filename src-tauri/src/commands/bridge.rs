use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::unbounded;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex};

use crate::can::{CanFrame, DbcDatabase};
use crate::listener::socketcan::{bind_socket, poll_frames};
use crate::state::TelemetryStore;

/// Shared app state exposed to Tauri commands.
pub struct AppState {
    pub store: Arc<TelemetryStore>,
    pub dbc: Arc<Mutex<DbcDatabase>>,
    pub streaming: Arc<Mutex<bool>>,
    pub cancel: Arc<Mutex<Option<watch::Sender<bool>>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            store: Arc::new(TelemetryStore::default()),
            dbc: Arc::new(Mutex::new(DbcDatabase::default())),
            streaming: Arc::new(Mutex::new(false)),
            cancel: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize, Clone)]
struct TelemetryPayload {
    signals: std::collections::HashMap<String, f64>,
    bus_load_pct: f64,
    frame_count: u64,
    error_count: u64,
}

#[derive(Serialize, Clone)]
struct RawFramePayload {
    id: u32,
    is_extended: bool,
    dlc: u8,
    data: [u8; 8],
    timestamp_us: u64,
}

#[derive(Serialize, Clone)]
struct SignalInfo {
    name: String,
    unit: String,
    min: f64,
    max: f64,
    description: Option<String>,
    value_table: std::collections::HashMap<i64, String>,
}

#[derive(Serialize, Clone)]
struct MessageInfo {
    id: u32,
    name: String,
    description: Option<String>,
    signals: Vec<SignalInfo>,
}

#[derive(Serialize, Clone)]
pub struct DbcInfo {
    messages: Vec<MessageInfo>,
}

/// Loads a `.dbc` file into the shared signal database used to decode
/// incoming frames, and returns the parsed message/signal listing so the
/// frontend can let the user pick which signals to display.
#[tauri::command]
pub async fn load_dbc(state: State<'_, AppState>, path: String) -> Result<DbcInfo, String> {
    let db = DbcDatabase::load_from_file(&path).map_err(|e| e.to_string())?;

    let mut messages: Vec<MessageInfo> = db
        .messages
        .values()
        .map(|msg| MessageInfo {
            id: msg.id,
            name: msg.name.clone(),
            description: msg.description.clone(),
            signals: msg
                .signals
                .iter()
                .map(|sig| SignalInfo {
                    name: sig.name.clone(),
                    unit: sig.unit.clone(),
                    min: sig.min,
                    max: sig.max,
                    description: sig.description.clone(),
                    value_table: sig.value_table.clone(),
                })
                .collect(),
        })
        .collect();
    messages.sort_by_key(|m| m.id);

    *state.dbc.lock().await = db;
    Ok(DbcInfo { messages })
}

/// Opens the given SocketCAN interface, spawns the async reader task, and
/// streams decoded telemetry + raw frames to the frontend via Tauri events:
/// `telemetry-update` (aggregated signals, ~60Hz) and `can-frame` (raw
/// per-frame, for the live inspector table).
#[tauri::command]
pub async fn start_can_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    interface_name: String,
    baud_rate: u32,
) -> Result<(), String> {
    {
        let mut streaming = state.streaming.lock().await;
        if *streaming {
            return Err("stream already running".into());
        }
        *streaming = true;
    }

    let socket = bind_socket(&interface_name)?;
    let (frame_tx, frame_rx) = unbounded::<CanFrame>();
    let (bus_load_tx, bus_load_rx) = unbounded::<f64>();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    *state.cancel.lock().await = Some(cancel_tx);

    let store = state.store.clone();
    let dbc = state.dbc.clone();
    let streaming_flag = state.streaming.clone();

    // Reader task: pulls frames off the kernel socket non-blockingly.
    let reader_cancel_rx = cancel_rx.clone();
    tokio::spawn(async move {
        poll_frames(socket, frame_tx, Some(bus_load_tx), baud_rate, reader_cancel_rx).await;
        *streaming_flag.lock().await = false;
    });

    // Decode task: applies DBC signal definitions and updates shared state.
    let decode_store = store.clone();
    let decode_dbc = dbc.clone();
    let decode_app = app.clone();
    tokio::task::spawn_blocking(move || {
        while let Ok(frame) = frame_rx.recv() {
            let decoded = decode_dbc.blocking_lock().decode_frame(&frame);
            if !decoded.is_empty() {
                decode_store.update_signals(decoded);
            }
            let _ = decode_app.emit(
                "can-frame",
                RawFramePayload {
                    id: frame.id,
                    is_extended: frame.is_extended,
                    dlc: frame.dlc,
                    data: frame.data,
                    timestamp_us: frame.timestamp_us,
                },
            );
        }
    });

    // Bus-load sampler task.
    let bus_load_store = store.clone();
    tokio::task::spawn_blocking(move || {
        while let Ok(load) = bus_load_rx.recv() {
            bus_load_store.set_bus_load(load);
        }
    });

    // Emitter task: pushes an aggregated telemetry snapshot at ~60Hz.
    let emit_store = store.clone();
    let mut emit_cancel_rx = cancel_rx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(16));
        loop {
            tokio::select! {
                _ = emit_cancel_rx.changed() => {
                    if *emit_cancel_rx.borrow() {
                        break;
                    }
                }
                _ = interval.tick() => {
                    let payload = TelemetryPayload {
                        signals: emit_store.snapshot(),
                        bus_load_pct: emit_store.bus_load(),
                        frame_count: emit_store.frame_count(),
                        error_count: emit_store.error_count(),
                    };
                    if app.emit("telemetry-update", payload).is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_can_stream(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel_tx) = state.cancel.lock().await.take() {
        let _ = cancel_tx.send(true);
    }
    *state.streaming.lock().await = false;
    Ok(())
}
