import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FrameLog from "./FrameLog";
import type { RawFramePayload } from "../lib/telemetry";

function frame(overrides: Partial<RawFramePayload>): RawFramePayload {
  return {
    id: 0x100,
    is_extended: false,
    dlc: 8,
    data: [1, 2, 3, 4, 5, 6, 7, 8],
    timestamp_us: 0,
    ...overrides,
  };
}

describe("FrameLog", () => {
  it("renders one row per frame with hex id, message name, and byte data", () => {
    const frames = [
      frame({ id: 0x100, timestamp_us: 1000, data: [1, 2, 3, 4, 5, 6, 7, 8] }),
      frame({ id: 0x200, timestamp_us: 2000, data: [0xa, 0xb, 0xc, 0xd, 0, 0, 0, 0] }),
    ];
    const messageNameById = new Map([[0x100, "MotorStatus"]]);
    render(<FrameLog frames={frames} messageNameById={messageNameById} />);

    expect(screen.getByText("0x100")).toBeInTheDocument();
    expect(screen.getByText("MotorStatus")).toBeInTheDocument();
    expect(screen.getByText("0x200")).toBeInTheDocument();
    expect(screen.getByText("01 02 03 04 05 06 07 08")).toBeInTheDocument();
    expect(screen.getByText("0A 0B 0C 0D 00 00 00 00")).toBeInTheDocument();
  });

  it("filters rows by hex id, decimal id, or message name", () => {
    const frames = [frame({ id: 0x100, timestamp_us: 1000 }), frame({ id: 0x200, timestamp_us: 2000 })];
    const messageNameById = new Map([
      [0x100, "MotorStatus"],
      [0x200, "BatteryStatus"],
    ]);
    render(<FrameLog frames={frames} messageNameById={messageNameById} />);

    fireEvent.change(screen.getByPlaceholderText(/filter by id or message name/i), {
      target: { value: "battery" },
    });

    expect(screen.getByText("0x200")).toBeInTheDocument();
    expect(screen.queryByText("0x100")).not.toBeInTheDocument();
  });
});
