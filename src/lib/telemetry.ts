export interface TelemetryPayload {
  signals: Record<string, number>;
  bus_load_pct: number;
  frame_count: number;
  error_count: number;
}

export interface RawFramePayload {
  id: number;
  is_extended: boolean;
  dlc: number;
  data: number[];
  timestamp_us: number;
}

export function formatHex(id: number, isExtended: boolean): string {
  const width = isExtended ? 8 : 3;
  return "0x" + id.toString(16).toUpperCase().padStart(width, "0");
}

export function formatBytes(data: number[], dlc: number): string {
  return data
    .slice(0, dlc)
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}
