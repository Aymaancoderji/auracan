# AuraCAN

Real-time SocketCAN telemetry engine. Rust/Tauri backend reads raw CAN
frames from a Linux SocketCAN interface, decodes them against a `.dbc`
signal database, and streams telemetry to a React/TypeScript dashboard.

## Layout

- `src-tauri/src/can/` — `CanFrame`, bit-level signal extraction, and the
  `.dbc` parser (`DbcDatabase`, `SignalDecoder`).
- `src-tauri/src/listener/` — async, non-blocking SocketCAN reader
  (`socketcan` crate, tokio) and a rolling bus-load monitor.
- `src-tauri/src/state/` — shared telemetry store (`TelemetryStore`).
- `src-tauri/src/commands/` — Tauri commands (`load_dbc`, `start_can_stream`,
  `stop_can_stream`) that wire the listener → decoder → store → 60Hz UI
  event emitter (`telemetry-update`, `can-frame`).
- `src/` — React dashboard: RPM/temp/current/bus-load gauges, live line
  charts, and a raw frame inspector table.
- `scripts/can_simulator.py` — broadcasts simulated `MotorStatus` frames on
  a virtual CAN interface for local testing.
- `scripts/motor.dbc` — sample DBC matching the simulator's frame layout.

## Prerequisites (Linux)

Tauri's webview needs GTK/WebKit dev headers to build:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
    libsoup-3.0-dev build-essential curl wget file
```

Rust (via rustup) and Node.js are also required.

> Note: this repo's `package.json` currently pulls in Vite 7, which wants
> Node >= 20.19. If you're on Node 18, either upgrade Node or pin Vite to a
> 5.x/6.x release compatible with your runtime.

## Virtual CAN setup (for local testing without real hardware)

```bash
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
```

## Running

```bash
npm install
npm run tauri dev
```

In a separate terminal, stream simulated frames:

```bash
cd scripts
python3 -m venv .venv && ./.venv/bin/pip install python-can
./.venv/bin/python can_simulator.py --interface vcan0
```

In the app, load `scripts/motor.dbc` (via `load_dbc`), then start the
stream on `vcan0` at 500000 baud.

## Testing the Rust logic

```bash
cd src-tauri
cargo test
```
