#!/usr/bin/env python3
"""Simulates a motor controller on a virtual CAN interface (vcan0) for
AuraCAN development/testing, broadcasting MotorStatus (0x100) frames with
sinusoidal RPM/current and a slowly drifting temperature.

Usage:
    sudo ip link add dev vcan0 type vcan   # once, if vcan0 doesn't exist
    sudo ip link set up vcan0
    ./.venv/bin/python can_simulator.py [--interface vcan0] [--hz 50]
"""
from __future__ import annotations

import argparse
import math
import struct
import subprocess
import sys
import time

import can

MOTOR_STATUS_ID = 0x100  # 256, matches BO_ 256 MotorStatus in motor.dbc


def ensure_vcan_interface(interface: str) -> None:
    """Best-effort creation of a vcan interface if it doesn't already exist.
    Requires root; falls back to a warning if it can't be created.
    """
    check = subprocess.run(["ip", "link", "show", interface], capture_output=True, text=True)
    if check.returncode == 0:
        return

    print(f"[sim] {interface} not found, attempting to create it (requires sudo)...")
    try:
        subprocess.run(["sudo", "ip", "link", "add", "dev", interface, "type", "vcan"], check=True)
        subprocess.run(["sudo", "ip", "link", "set", "up", interface], check=True)
        print(f"[sim] {interface} created and brought up.")
    except subprocess.CalledProcessError as exc:
        print(f"[sim] WARNING: could not auto-create {interface}: {exc}", file=sys.stderr)
        print("[sim] Run manually: sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0")


def encode_motor_status(rpm: float, temp_c: float, current_a: float) -> bytes:
    """Packs MotorRPM (int16 LE, signed), ControllerTemp (uint8, offset -40),
    OutputCurrent (uint16 LE, factor 0.1) to match motor.dbc's BO_ 256 layout.
    """
    rpm_raw = int(max(min(rpm, 32000), -32000))
    temp_raw = int(max(min(temp_c + 40, 255), 0))
    current_raw = int(max(min(current_a / 0.1, 65535), 0))
    return struct.pack("<hBH", rpm_raw, temp_raw, current_raw) + b"\x00\x00\x00"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", default="vcan0", help="SocketCAN interface name")
    parser.add_argument("--hz", type=float, default=50.0, help="Frame transmit rate")
    parser.add_argument("--skip-iface-setup", action="store_true", help="Don't try to auto-create the vcan interface")
    args = parser.parse_args()

    if not args.skip_iface_setup:
        ensure_vcan_interface(args.interface)

    bus = can.interface.Bus(channel=args.interface, interface="socketcan")
    period = 1.0 / args.hz
    t0 = time.monotonic()

    print(f"[sim] streaming MotorStatus (0x{MOTOR_STATUS_ID:X}) on {args.interface} at {args.hz} Hz. Ctrl+C to stop.")

    try:
        while True:
            t = time.monotonic() - t0
            rpm = 3500 + 2500 * math.sin(t * 0.4)
            current = 120 + 80 * math.sin(t * 0.4 + 0.5)
            temp = 45 + 20 * math.sin(t * 0.05) + (5 if current > 180 else 0)

            data = encode_motor_status(rpm, temp, current)
            msg = can.Message(arbitration_id=MOTOR_STATUS_ID, data=data, is_extended_id=False)
            bus.send(msg)

            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[sim] stopped.")
    finally:
        bus.shutdown()


if __name__ == "__main__":
    main()
