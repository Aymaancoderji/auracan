import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "./settings";

describe("settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when nothing is persisted", () => {
    expect(loadSettings()).toEqual({
      interfaceName: "vcan0",
      baudRate: 500000,
      dbcPath: null,
      slotSignals: [null, null, null],
    });
  });

  it("round-trips a saved settings object", () => {
    saveSettings({
      interfaceName: "can0",
      baudRate: 250000,
      dbcPath: "/home/user/motor.dbc",
      slotSignals: ["MotorRPM", null, "ControllerTemp"],
    });

    expect(loadSettings()).toEqual({
      interfaceName: "can0",
      baudRate: 250000,
      dbcPath: "/home/user/motor.dbc",
      slotSignals: ["MotorRPM", null, "ControllerTemp"],
    });
  });

  it("falls back to defaults for malformed JSON", () => {
    localStorage.setItem("auracan.settings.v1", "{not json");
    expect(loadSettings()).toEqual({
      interfaceName: "vcan0",
      baudRate: 500000,
      dbcPath: null,
      slotSignals: [null, null, null],
    });
  });

  it("falls back field-by-field for a partially valid stored object", () => {
    localStorage.setItem(
      "auracan.settings.v1",
      JSON.stringify({ interfaceName: 42, baudRate: 125000, dbcPath: "/x.dbc" })
    );
    expect(loadSettings()).toEqual({
      interfaceName: "vcan0", // wrong type in storage, defaulted
      baudRate: 125000,
      dbcPath: "/x.dbc",
      slotSignals: [null, null, null], // missing in storage, defaulted
    });
  });
});
