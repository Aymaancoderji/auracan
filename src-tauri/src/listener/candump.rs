//! Reader/writer for the `candump -l` log line format:
//!
//! ```text
//! (<secs>.<usecs>) <iface> <id>#<data>
//! (1690000000.123456) vcan0 100#dc0500000000
//! ```
//!
//! Standard-frame IDs are written as 3 hex digits, extended-frame IDs as 8,
//! matching how `candump`/`canplayer` distinguish them on parse. Using this
//! format (rather than inventing our own) means recordings can also be
//! inspected or replayed with those tools.

use crate::can::CanFrame;

/// Formats one frame as a `candump -l` log line.
pub fn format_line(interface: &str, frame: &CanFrame) -> String {
    let secs = frame.timestamp_us / 1_000_000;
    let usecs = frame.timestamp_us % 1_000_000;
    let width = if frame.is_extended { 8 } else { 3 };
    let id = format!("{:0width$x}", frame.id, width = width);
    let mut data = String::with_capacity(frame.dlc as usize * 2);
    for b in &frame.data[..frame.dlc as usize] {
        data.push_str(&format!("{b:02x}"));
    }
    format!("({secs}.{usecs:06}) {interface} {id}#{data}")
}

/// Parses one log line into `(timestamp_us, CanFrame)`. Returns `None` for
/// blank lines or lines that don't match the expected format, so callers
/// can skip malformed lines rather than aborting a whole replay.
pub fn parse_line(line: &str) -> Option<(u64, CanFrame)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let rest = line.strip_prefix('(')?;
    let (ts_part, rest) = rest.split_once(')')?;
    let (secs_str, usecs_str) = ts_part.split_once('.')?;
    let secs: u64 = secs_str.trim().parse().ok()?;
    let usecs: u64 = usecs_str.trim().parse().ok()?;
    let timestamp_us = secs * 1_000_000 + usecs;

    let (_iface, frame_part) = rest.trim().split_once(' ')?;
    let (id_str, data_str) = frame_part.split_once('#')?;
    let is_extended = id_str.len() > 3;
    let id = u32::from_str_radix(id_str, 16).ok()?;

    if data_str.len() % 2 != 0 {
        return None;
    }
    let mut data = Vec::with_capacity(data_str.len() / 2);
    for start in (0..data_str.len()).step_by(2) {
        data.push(u8::from_str_radix(&data_str[start..start + 2], 16).ok()?);
    }

    Some((timestamp_us, CanFrame::new(id, is_extended, &data, timestamp_us)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_standard_frame() {
        let data = [0xDC, 0x05, 65, 0, 0, 0, 0, 0];
        let frame = CanFrame::new(256, false, &data, 1_690_000_000_123_456);
        let line = format_line("vcan0", &frame);
        assert_eq!(line, "(1690000000.123456) vcan0 100#dc05410000000000");

        let (ts, parsed) = parse_line(&line).expect("parses");
        assert_eq!(ts, 1_690_000_000_123_456);
        assert_eq!(parsed.id, 256);
        assert!(!parsed.is_extended);
        assert_eq!(parsed.dlc, 8);
        assert_eq!(&parsed.data, &data);
    }

    #[test]
    fn round_trips_an_extended_frame() {
        let data = [1, 2, 3];
        let frame = CanFrame::new(0x1ABCDEF, true, &data, 42_000_000);
        let line = format_line("can0", &frame);

        let (_, parsed) = parse_line(&line).expect("parses");
        assert_eq!(parsed.id, 0x1ABCDEF);
        assert!(parsed.is_extended);
        assert_eq!(parsed.dlc, 3);
        assert_eq!(&parsed.data[..3], &data);
    }

    #[test]
    fn ignores_malformed_lines() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("not a candump line").is_none());
        assert!(parse_line("(bad.timestamp) vcan0 100#00").is_none());
        assert!(parse_line("(1.0) vcan0 100#0").is_none());
    }
}
