import { describe, expect, it } from "vitest";
import { DbcInfo, flattenSignals, formatBytes, formatHex } from "./telemetry";

describe("formatHex", () => {
  it("pads standard IDs to 3 hex digits", () => {
    expect(formatHex(0x100, false)).toBe("0x100");
    expect(formatHex(1, false)).toBe("0x001");
  });

  it("pads extended IDs to 8 hex digits", () => {
    expect(formatHex(0x1abcdef, true)).toBe("0x01ABCDEF");
  });
});

describe("formatBytes", () => {
  it("formats only the first dlc bytes as space-separated uppercase hex", () => {
    expect(formatBytes([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0], 4)).toBe("DE AD BE EF");
  });

  it("returns an empty string for dlc 0", () => {
    expect(formatBytes([1, 2, 3], 0)).toBe("");
  });
});

describe("flattenSignals", () => {
  it("flattens messages/signals and attaches the parent message's id and name", () => {
    const dbc: DbcInfo = {
      messages: [
        {
          id: 256,
          name: "MotorStatus",
          description: null,
          signals: [
            { name: "MotorRPM", unit: "rpm", min: 0, max: 8000, description: null, value_table: {} },
            { name: "ControllerTemp", unit: "degC", min: -40, max: 215, description: null, value_table: {} },
          ],
        },
        {
          id: 257,
          name: "MotorFaults",
          description: null,
          signals: [{ name: "BusOff", unit: "", min: 0, max: 1, description: null, value_table: {} }],
        },
      ],
    };

    const flat = flattenSignals(dbc);
    expect(flat).toHaveLength(3);
    expect(flat[0]).toMatchObject({ messageId: 256, messageName: "MotorStatus", name: "MotorRPM" });
    expect(flat[2]).toMatchObject({ messageId: 257, messageName: "MotorFaults", name: "BusOff" });
  });

  it("returns an empty array for a DBC with no messages", () => {
    expect(flattenSignals({ messages: [] })).toEqual([]);
  });
});
