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

export interface SignalInfo {
  name: string;
  unit: string;
  min: number;
  max: number;
}

export interface MessageInfo {
  id: number;
  name: string;
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
