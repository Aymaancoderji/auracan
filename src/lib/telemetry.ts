export interface TelemetryPayload {
  signals: Record<string, number>;
  bus_load_pct: number;
  frame_count: number;
  error_count: number;
}

export type StreamStatus =
  | { state: "reconnecting"; attempt: number; max_attempts: number }
  | { state: "disconnected"; reason: string }
  | { state: "finished" };

export interface RawFramePayload {
  id: number;
  is_extended: boolean;
  dlc: number;
  data: number[];
  timestamp_us: number;
}

export interface SignalInfo {
  name: string;
  unit: string;
  min: number;
  max: number;
  description: string | null;
  /** Enum-style value labels (from a DBC `VAL_` table), keyed by raw integer value. */
  value_table: Record<string, string>;
}

export interface MessageInfo {
  id: number;
  name: string;
  description: string | null;
  signals: SignalInfo[];
}

export interface DbcInfo {
  messages: MessageInfo[];
}

/** A signal flattened across all messages, for display/selection in the UI. */
export interface FlatSignal extends SignalInfo {
  messageId: number;
  messageName: string;
}

export function flattenSignals(dbc: DbcInfo): FlatSignal[] {
  return dbc.messages.flatMap((msg) =>
    msg.signals.map((sig) => ({ ...sig, messageId: msg.id, messageName: msg.name }))
  );
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

/** Renders raw frames (newest-first, as displayed) as CSV, oldest-first so it reads chronologically. */
export function framesToCsv(frames: RawFramePayload[], messageNameById: Map<number, string>): string {
  const header = "id,message,dlc,data,timestamp_us";
  const rows = [...frames]
    .reverse()
    .map((f) =>
      [
        formatHex(f.id, f.is_extended),
        messageNameById.get(f.id) ?? "",
        f.dlc,
        formatBytes(f.data, f.dlc),
        f.timestamp_us,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
  return [header, ...rows].join("\n");
}
