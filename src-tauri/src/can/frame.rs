use serde::Serialize;

/// A single raw CAN frame captured from a SocketCAN interface.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CanFrame {
    pub id: u32,
    pub is_extended: bool,
    pub dlc: u8,
    pub data: [u8; 8],
    pub timestamp_us: u64,
}

impl CanFrame {
    pub fn new(id: u32, is_extended: bool, data: &[u8], timestamp_us: u64) -> Self {
        let dlc = data.len().min(8) as u8;
        let mut buf = [0u8; 8];
        buf[..dlc as usize].copy_from_slice(&data[..dlc as usize]);
        Self {
            id,
            is_extended,
            dlc,
            data: buf,
            timestamp_us,
        }
    }
}

/// Extracts an unsigned integer of `bit_length` bits starting at `start_bit`
/// from an 8-byte CAN payload, honoring DBC-style bit numbering.
///
/// - Little-endian (Intel) signals: `start_bit` is the LSB position, bits are
///   read walking toward the MSB across byte boundaries.
/// - Big-endian (Motorola) signals: `start_bit` uses DBC's MSB-first bit
///   numbering within each byte (bit 7 is the MSB of byte 0).
pub fn extract_bits(data: &[u8; 8], start_bit: u8, bit_length: u8, is_big_endian: bool) -> u64 {
    if bit_length == 0 || bit_length > 64 {
        return 0;
    }

    let mut raw: u64 = 0;

    if is_big_endian {
        // Motorola bit order: walk bits from start_bit downward through the
        // byte-major, bit-minor DBC numbering scheme.
        let mut byte_idx = (start_bit / 8) as usize;
        let mut bit_in_byte = start_bit % 8;
        for _ in 0..bit_length {
            let bit = (data[byte_idx] >> bit_in_byte) & 1;
            raw = (raw << 1) | bit as u64;
            if bit_in_byte == 0 {
                byte_idx += 1;
                bit_in_byte = 7;
            } else {
                bit_in_byte -= 1;
            }
            if byte_idx >= 8 {
                break;
            }
        }
    } else {
        // Intel bit order: start_bit is the LSB, walk toward the MSB.
        for i in 0..bit_length {
            let pos = start_bit as u32 + i as u32;
            let byte_idx = (pos / 8) as usize;
            if byte_idx >= 8 {
                break;
            }
            let bit_in_byte = pos % 8;
            let bit = (data[byte_idx] >> bit_in_byte) & 1;
            raw |= (bit as u64) << i;
        }
    }

    raw
}

/// Sign-extends a `bit_length`-wide raw value that was extracted via
/// [`extract_bits`], interpreting it as two's complement.
pub fn sign_extend(raw: u64, bit_length: u8) -> i64 {
    if bit_length >= 64 {
        return raw as i64;
    }
    let shift = 64 - bit_length as u32;
    ((raw << shift) as i64) >> shift
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_little_endian_signal() {
        // Byte0 = 0b1111_0000 -> lower nibble (bits 0..4) = 0
        let data = [0b1111_0000, 0, 0, 0, 0, 0, 0, 0];
        let raw = extract_bits(&data, 0, 4, false);
        assert_eq!(raw, 0);
        let raw2 = extract_bits(&data, 4, 4, false);
        assert_eq!(raw2, 0b1111);
    }

    #[test]
    fn extracts_big_endian_signal() {
        let data = [0b1010_0000, 0, 0, 0, 0, 0, 0, 0];
        // start_bit 7 (MSB of byte0), length 3 -> top 3 bits: 1,0,1
        let raw = extract_bits(&data, 7, 3, true);
        assert_eq!(raw, 0b101);
    }

    #[test]
    fn sign_extends_negative_value() {
        // 8-bit value 0xFF should be -1
        let raw = extract_bits(&[0xFF, 0, 0, 0, 0, 0, 0, 0], 0, 8, false);
        assert_eq!(sign_extend(raw, 8), -1);
    }
}
