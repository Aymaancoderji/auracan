use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::frame::{extract_bits, sign_extend, CanFrame};

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
}

impl SignalDecoder {
    /// Decodes raw bits into a physical value: `(raw * factor) + offset`.
    pub fn decode(&self, frame_data: &[u8; 8]) -> f64 {
        let raw_bits = extract_bits(frame_data, self.start_bit, self.bit_length, self.is_big_endian);
        let raw_value = if self.is_signed {
            sign_extend(raw_bits, self.bit_length) as f64
        } else {
            raw_bits as f64
        };
        raw_value * self.factor + self.offset
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

    /// Parses a subset of the DBC grammar sufficient for `BO_`/`SG_` blocks:
    ///
    /// ```text
    /// BO_ 100 MotorStatus: 8 MCU
    ///  SG_ MotorRPM : 0|16@1- (1,0) [-32000|32000] "rpm" ECU
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
            } else if trimmed.is_empty() || !trimmed.starts_with(char::is_whitespace) && !trimmed.starts_with("SG_") {
                // Any other top-level keyword (CM_, BA_, VAL_, ...) ends the
                // current message block's signal context unless it's BO_.
                if !trimmed.starts_with("BO_") {
                    current_id = None;
                }
            }
        }

        Self { messages }
    }

    /// Decodes every known signal contained in `frame` using this database.
    pub fn decode_frame(&self, frame: &CanFrame) -> HashMap<String, f64> {
        let mut out = HashMap::new();
        if let Some(msg) = self.messages.get(&frame.id) {
            for sig in &msg.signals {
                out.insert(sig.name.clone(), sig.decode(&frame.data));
            }
        }
        out
    }
}

/// Parses a single `SG_` line body, e.g.:
/// `MotorRPM : 0|16@1- (1,0) [-32000|32000] "rpm" ECU`
fn parse_signal_line(rest: &str) -> Option<SignalDecoder> {
    let (name_part, remainder) = rest.split_once(':')?;
    let name = name_part.trim().to_string();
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

    Some(SignalDecoder {
        name,
        start_bit,
        bit_length,
        is_big_endian,
        is_signed,
        factor,
        offset,
        unit,
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
}
