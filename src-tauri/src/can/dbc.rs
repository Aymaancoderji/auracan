use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::frame::{extract_bits, sign_extend, CanFrame};

/// A signal's role within a multiplexed message, parsed from the optional
/// `M` / `m<N>` token that follows a signal's name in an `SG_` line.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum MuxIndicator {
    /// The selector signal (`M`) whose raw value picks which `m<N>` signals
    /// are present in a given frame.
    Multiplexor,
    /// A signal that is only present when the message's multiplexor signal
    /// decodes to `N` (`m<N>`).
    Multiplexed(u32),
}

/// Signal conversion parameters describing how to pull a physical value out
/// of a raw CAN payload, as parsed from a `.dbc` file `SG_` line.
#[derive(Debug, Clone, Serialize)]
pub struct SignalDecoder {
    pub name: String,
    pub start_bit: u8,
    pub bit_length: u8,
    pub is_big_endian: bool,
    pub is_signed: bool,
    pub factor: f64,
    pub offset: f64,
    pub unit: String,
    pub min: f64,
    pub max: f64,
    pub mux: Option<MuxIndicator>,
    /// Enum-style value labels from a `VAL_` line, keyed by raw integer value.
    pub value_table: HashMap<i64, String>,
    /// Free-text description from a `CM_ SG_` line, if any.
    pub description: Option<String>,
}

impl SignalDecoder {
    /// Extracts and sign-extends (if applicable) the raw integer value of
    /// this signal, without applying `factor`/`offset`. Used both for
    /// physical-value decoding and for reading a multiplexor's selector
    /// value.
    fn raw_value(&self, frame_data: &[u8; 8]) -> i64 {
        let raw_bits = extract_bits(frame_data, self.start_bit, self.bit_length, self.is_big_endian);
        if self.is_signed {
            sign_extend(raw_bits, self.bit_length)
        } else {
            raw_bits as i64
        }
    }

    /// Decodes raw bits into a physical value: `(raw * factor) + offset`.
    pub fn decode(&self, frame_data: &[u8; 8]) -> f64 {
        self.raw_value(frame_data) as f64 * self.factor + self.offset
    }
}

/// A CAN message definition: its arbitration ID and the signals packed
/// inside its payload.
#[derive(Debug, Clone)]
pub struct MessageDef {
    pub name: String,
    pub id: u32,
    pub dlc: u8,
    pub signals: Vec<SignalDecoder>,
    /// Free-text description from a `CM_ BO_` line, if any.
    pub description: Option<String>,
}

/// A parsed DBC database: message definitions keyed by CAN arbitration ID.
#[derive(Debug, Clone, Default)]
pub struct DbcDatabase {
    pub messages: HashMap<u32, MessageDef>,
}

impl DbcDatabase {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let contents = fs::read_to_string(path)?;
        Ok(Self::parse(&contents))
    }

    /// Parses a subset of the DBC grammar sufficient for `BO_`/`SG_` blocks
    /// (including multiplexed signals), plus `CM_` comments and `VAL_`
    /// enum tables:
    ///
    /// ```text
    /// BO_ 100 MotorStatus: 8 MCU
    ///  SG_ MotorRPM : 0|16@1- (1,0) [-32000|32000] "rpm" ECU
    ///  SG_ GearSelect M : 16|4@1+ (1,0) [0|15] "" ECU
    ///  SG_ GearRatio m3 : 20|8@1+ (0.1,0) [0|25] "" ECU
    /// CM_ SG_ 100 MotorRPM "Rotor speed, filtered.";
    /// VAL_ 100 GearSelect 0 "Park" 1 "Reverse" 3 "Drive" ;
    /// ```
    pub fn parse(contents: &str) -> Self {
        let mut messages: HashMap<u32, MessageDef> = HashMap::new();
        let mut current_id: Option<u32> = None;

        for line in contents.lines() {
            let trimmed = line.trim();

            if let Some(rest) = trimmed.strip_prefix("BO_ ") {
                // BO_ <id> <name>: <dlc> <sender>
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() >= 3 {
                    if let Ok(id) = parts[0].parse::<u32>() {
                        let name = parts[1].trim_end_matches(':').to_string();
                        let dlc = parts[2].parse::<u8>().unwrap_or(8);
                        messages.insert(
                            id,
                            MessageDef {
                                name,
                                id,
                                dlc,
                                signals: Vec::new(),
                                description: None,
                            },
                        );
                        current_id = Some(id);
                    }
                }
            } else if let Some(rest) = trimmed.strip_prefix("SG_ ") {
                if let Some(id) = current_id {
                    if let Some(signal) = parse_signal_line(rest) {
                        if let Some(msg) = messages.get_mut(&id) {
                            msg.signals.push(signal);
                        }
                    }
                }
            } else if let Some(rest) = trimmed.strip_prefix("CM_ SG_ ") {
                apply_signal_comment(&mut messages, rest);
                current_id = None;
            } else if let Some(rest) = trimmed.strip_prefix("CM_ BO_ ") {
                apply_message_comment(&mut messages, rest);
                current_id = None;
            } else if let Some(rest) = trimmed.strip_prefix("VAL_ ") {
                apply_value_table(&mut messages, rest);
                current_id = None;
            } else if trimmed.is_empty() || !trimmed.starts_with(char::is_whitespace) && !trimmed.starts_with("SG_") {
                // Any other top-level keyword (BA_, BU_, ...) ends the
                // current message block's signal context unless it's BO_.
                if !trimmed.starts_with("BO_") {
                    current_id = None;
                }
            }
        }

        Self { messages }
    }

    /// Decodes every known signal contained in `frame` using this database.
    /// For multiplexed messages, only the multiplexor signal itself and the
    /// `m<N>` signals whose selector matches the frame's current mux value
    /// are included.
    pub fn decode_frame(&self, frame: &CanFrame) -> HashMap<String, f64> {
        let mut out = HashMap::new();
        if let Some(msg) = self.messages.get(&frame.id) {
            let mux_value = msg
                .signals
                .iter()
                .find(|s| s.mux == Some(MuxIndicator::Multiplexor))
                .map(|s| s.raw_value(&frame.data));

            for sig in &msg.signals {
                let active = match sig.mux {
                    Some(MuxIndicator::Multiplexed(n)) => mux_value == Some(n as i64),
                    _ => true,
                };
                if active {
                    out.insert(sig.name.clone(), sig.decode(&frame.data));
                }
            }
        }
        out
    }
}

/// Extracts the text inside the first `"..."` pair found in `s`.
fn extract_quoted(s: &str) -> Option<String> {
    let start = s.find('"')?;
    let end = s[start + 1..].find('"')?;
    Some(s[start + 1..start + 1 + end].to_string())
}

/// Applies a `CM_ SG_ <msg_id> <signal_name> "<text>";` comment line.
fn apply_signal_comment(messages: &mut HashMap<u32, MessageDef>, rest: &str) {
    let Some((id_str, remainder)) = rest.split_once(' ') else { return };
    let Ok(id) = id_str.trim().parse::<u32>() else { return };
    let Some((sig_name, remainder)) = remainder.trim_start().split_once(' ') else { return };
    let Some(text) = extract_quoted(remainder) else { return };

    if let Some(msg) = messages.get_mut(&id) {
        if let Some(sig) = msg.signals.iter_mut().find(|s| s.name == sig_name) {
            sig.description = Some(text);
        }
    }
}

/// Applies a `CM_ BO_ <msg_id> "<text>";` comment line.
fn apply_message_comment(messages: &mut HashMap<u32, MessageDef>, rest: &str) {
    let Some((id_str, remainder)) = rest.split_once(' ') else { return };
    let Ok(id) = id_str.trim().parse::<u32>() else { return };
    let Some(text) = extract_quoted(remainder) else { return };

    if let Some(msg) = messages.get_mut(&id) {
        msg.description = Some(text);
    }
}

/// Applies a `VAL_ <msg_id> <signal_name> <v1> "<label1>" <v2> "<label2>" ...;`
/// enum-table line.
fn apply_value_table(messages: &mut HashMap<u32, MessageDef>, rest: &str) {
    let rest = rest.trim().trim_end_matches(';').trim();
    let Some((id_str, remainder)) = rest.split_once(' ') else { return };
    let Ok(id) = id_str.trim().parse::<u32>() else { return };
    let Some((sig_name, mut remainder)) = remainder.trim_start().split_once(' ') else { return };

    let mut table = HashMap::new();
    loop {
        remainder = remainder.trim_start();
        if remainder.is_empty() {
            break;
        }
        let Some((num_str, after_num)) = remainder.split_once(char::is_whitespace) else { break };
        let Ok(num) = num_str.trim().parse::<i64>() else { break };
        let after_num = after_num.trim_start();
        let Some(quote_start) = after_num.find('"') else { break };
        let Some(quote_len) = after_num[quote_start + 1..].find('"') else { break };
        let label = after_num[quote_start + 1..quote_start + 1 + quote_len].to_string();
        table.insert(num, label);
        remainder = &after_num[quote_start + 1 + quote_len + 1..];
    }

    if let Some(msg) = messages.get_mut(&id) {
        if let Some(sig) = msg.signals.iter_mut().find(|s| s.name == sig_name) {
            sig.value_table = table;
        }
    }
}

/// Parses a single `SG_` line body, e.g.:
/// `MotorRPM : 0|16@1- (1,0) [-32000|32000] "rpm" ECU`
fn parse_signal_line(rest: &str) -> Option<SignalDecoder> {
    let (name_part, remainder) = rest.split_once(':')?;
    // "<name>" or "<name> M" (multiplexor) or "<name> m<N>" (multiplexed).
    let mut name_tokens = name_part.split_whitespace();
    let name = name_tokens.next()?.to_string();
    let mux = match name_tokens.next() {
        Some("M") => Some(MuxIndicator::Multiplexor),
        Some(tok) => tok.strip_prefix('m').and_then(|n| n.parse().ok()).map(MuxIndicator::Multiplexed),
        None => None,
    };
    let remainder = remainder.trim();

    // Layout: <start>|<length>@<endian><sign> (<factor>,<offset>) [<min>|<max>] "<unit>" <receiver>
    let (layout, after_layout) = remainder.split_once(' ')?;
    let (start_len, endian_sign) = layout.split_once('@')?;
    let (start_bit_str, bit_length_str) = start_len.split_once('|')?;
    let start_bit: u8 = start_bit_str.trim().parse().ok()?;
    let bit_length: u8 = bit_length_str.trim().parse().ok()?;

    let mut chars = endian_sign.chars();
    let endian_char = chars.next()?;
    let sign_char = chars.next().unwrap_or('+');
    let is_big_endian = endian_char == '0';
    let is_signed = sign_char == '-';

    let after_layout = after_layout.trim();
    let factor_offset_start = after_layout.find('(')?;
    let factor_offset_end = after_layout.find(')')?;
    let factor_offset = &after_layout[factor_offset_start + 1..factor_offset_end];
    let (factor_str, offset_str) = factor_offset.split_once(',')?;
    let factor: f64 = factor_str.trim().parse().ok()?;
    let offset: f64 = offset_str.trim().parse().ok()?;

    let unit = after_layout
        .find('"')
        .and_then(|start| {
            after_layout[start + 1..]
                .find('"')
                .map(|end| after_layout[start + 1..start + 1 + end].to_string())
        })
        .unwrap_or_default();

    let (min, max) = after_layout
        .find('[')
        .zip(after_layout.find(']'))
        .and_then(|(start, end)| {
            let (min_str, max_str) = after_layout[start + 1..end].split_once('|')?;
            let min: f64 = min_str.trim().parse().ok()?;
            let max: f64 = max_str.trim().parse().ok()?;
            Some((min, max))
        })
        .unwrap_or((0.0, 0.0));

    Some(SignalDecoder {
        name,
        start_bit,
        bit_length,
        is_big_endian,
        is_signed,
        factor,
        offset,
        unit,
        min,
        max,
        mux,
        value_table: HashMap::new(),
        description: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DBC: &str = r#"
BO_ 256 MotorStatus: 8 MCU
 SG_ MotorRPM : 0|16@1- (1,0) [-32000|32000] "rpm" ECU
 SG_ ControllerTemp : 16|8@1+ (1,-40) [-40|215] "degC" ECU
"#;

    #[test]
    fn parses_message_and_signals() {
        let db = DbcDatabase::parse(SAMPLE_DBC);
        let msg = db.messages.get(&256).expect("message present");
        assert_eq!(msg.name, "MotorStatus");
        assert_eq!(msg.signals.len(), 2);
        assert_eq!(msg.signals[0].name, "MotorRPM");
        assert_eq!(msg.signals[0].factor, 1.0);
        assert!(msg.signals[0].is_signed);
    }

    #[test]
    fn decodes_frame_against_database() {
        let db = DbcDatabase::parse(SAMPLE_DBC);
        // RPM = 1500 (little-endian 16-bit) -> bytes [0xDC, 0x05]
        // Temp raw byte = 65 -> 65 - 40 = 25 degC
        let data = [0xDC, 0x05, 65, 0, 0, 0, 0, 0];
        let frame = CanFrame::new(256, false, &data, 0);
        let decoded = db.decode_frame(&frame);
        assert_eq!(decoded.get("MotorRPM").copied(), Some(1500.0));
        assert_eq!(decoded.get("ControllerTemp").copied(), Some(25.0));
    }

    const MUX_DBC: &str = r#"
BO_ 512 DiagResponse: 8 MCU
 SG_ ParamId M : 0|8@1+ (1,0) [0|255] "" ECU
 SG_ Temperature m1 : 8|8@1+ (1,-40) [-40|215] "degC" ECU
 SG_ VoltageRail m2 : 8|16@1+ (0.01,0) [0|60] "V" ECU
 SG_ Uptime : 24|16@1+ (1,0) [0|65535] "s" ECU
"#;

    #[test]
    fn decodes_only_the_active_multiplexed_signal() {
        let db = DbcDatabase::parse(MUX_DBC);

        // ParamId = 1 -> Temperature active, VoltageRail absent.
        let data = [1, 65, 0, 0, 0, 0, 0, 0];
        let decoded = db.decode_frame(&CanFrame::new(512, false, &data, 0));
        assert_eq!(decoded.get("ParamId").copied(), Some(1.0));
        assert_eq!(decoded.get("Temperature").copied(), Some(25.0));
        assert!(!decoded.contains_key("VoltageRail"));

        // ParamId = 2 -> VoltageRail active, Temperature absent. Non-muxed
        // signals (Uptime) are always present regardless of selector.
        let data = [2, 0x88, 0x13, 0, 0, 0, 0, 0];
        let decoded = db.decode_frame(&CanFrame::new(512, false, &data, 0));
        assert_eq!(decoded.get("ParamId").copied(), Some(2.0));
        assert!(!decoded.contains_key("Temperature"));
        assert_eq!(decoded.get("VoltageRail").copied(), Some(50.0));
        assert!(decoded.contains_key("Uptime"));
    }

    const ANNOTATED_DBC: &str = r#"
BO_ 256 MotorStatus: 8 MCU
 SG_ GearSelect : 0|4@1+ (1,0) [0|15] "" ECU
CM_ BO_ 256 "Top-level motor status message.";
CM_ SG_ 256 GearSelect "Current commanded gear.";
VAL_ 256 GearSelect 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
"#;

    #[test]
    fn applies_comments_and_value_tables() {
        let db = DbcDatabase::parse(ANNOTATED_DBC);
        let msg = db.messages.get(&256).expect("message present");
        assert_eq!(msg.description.as_deref(), Some("Top-level motor status message."));

        let sig = &msg.signals[0];
        assert_eq!(sig.description.as_deref(), Some("Current commanded gear."));
        assert_eq!(sig.value_table.get(&3).map(String::as_str), Some("Drive"));
        assert_eq!(sig.value_table.len(), 4);
    }
}
