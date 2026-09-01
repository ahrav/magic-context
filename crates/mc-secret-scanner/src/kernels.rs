use proptest::prelude::*;

use crate::evaluator::{
    base62_u32, crc32, decode_prefix, is_uuid, key_tokens, lowercase_percent, parse_hex_u32,
};

/// Table-driven CRC-32/ISO-HDLC, independent of the bitwise loop.
fn crc32_reference(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, entry) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 == 1 {
                (value >> 1) ^ 0xedb8_8320
            } else {
                value >> 1
            };
        }
        *entry = value;
    }
    let mut crc = u32::MAX;
    for byte in bytes {
        crc = table[usize::from((crc as u8) ^ *byte)] ^ (crc >> 8);
    }
    !crc
}

fn base62_encode(mut value: u64, width: usize) -> String {
    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = vec![b'0'; width];
    for slot in out.iter_mut().rev() {
        *slot = DIGITS[usize::try_from(value % 62).expect("digit fits")];
        value /= 62;
    }
    String::from_utf8(out).expect("base62 digits are ASCII")
}

fn base64_encode(bytes: &[u8], url: bool) -> String {
    let alphabet: &[u8] = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut buffer = [0u8; 3];
        buffer[..chunk.len()].copy_from_slice(chunk);
        let packed =
            (u32::from(buffer[0]) << 16) | (u32::from(buffer[1]) << 8) | u32::from(buffer[2]);
        let symbols = chunk.len() + 1;
        for index in 0..symbols {
            let shift = 18 - 6 * index;
            out.push(char::from(alphabet[((packed >> shift) & 0x3f) as usize]));
        }
        for _ in symbols..4 {
            out.push('=');
        }
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn crc32_matches_table_reference(bytes in proptest::collection::vec(any::<u8>(), 0..128)) {
        prop_assert_eq!(crc32(&bytes), crc32_reference(&bytes));
    }

    #[test]
    fn base62_decodes_its_own_encoding(value in any::<u32>(), width in 6usize..=7) {
        let encoded = base62_encode(u64::from(value), width);
        prop_assert_eq!(base62_u32(encoded.as_bytes()), Some(value));
    }

    #[test]
    fn parse_hex_matches_std(value in any::<u32>()) {
        let encoded = format!("{value:08x}");
        prop_assert_eq!(parse_hex_u32(encoded.as_bytes()), Some(value));
        prop_assert_eq!(
            parse_hex_u32(encoded.to_ascii_uppercase().as_bytes()),
            Some(value)
        );
    }

    #[test]
    fn hex_rejects_wrong_width(text in "[0-9a-f]{0,7}") {
        prop_assert_eq!(parse_hex_u32(text.as_bytes()), None);
    }

    #[test]
    fn decode_prefix_accepts_encoded_payloads(
        prefix in proptest::collection::vec(any::<u8>(), 1..8),
        tail in proptest::collection::vec(any::<u8>(), 0..16),
        url in any::<bool>(),
    ) {
        let mut payload = prefix.clone();
        payload.extend_from_slice(&tail);
        let encoded = base64_encode(&payload, url);
        prop_assert!(decode_prefix(encoded.as_bytes(), &prefix, url));
        let mut mismatched = prefix.clone();
        mismatched[0] = mismatched[0].wrapping_add(1);
        prop_assert!(!decode_prefix(encoded.as_bytes(), &mismatched, url));
    }

    #[test]
    fn lowercase_percent_matches_direct_count(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        let expected = if bytes.is_empty() {
            0
        } else {
            bytes.iter().filter(|byte| byte.is_ascii_lowercase()).count() * 100 / bytes.len()
        };
        prop_assert_eq!(lowercase_percent(&bytes), expected);
    }

    #[test]
    fn is_uuid_matches_grammar(text in "[0-9a-fA-F-]{30,40}") {
        let grammar = text.len() == 36
            && text.as_bytes().iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        prop_assert_eq!(is_uuid(text.as_bytes()), grammar);
    }

    #[test]
    fn key_tokens_match_lowercased_split(key in "[A-Za-z0-9_.-]{0,32}") {
        let scanner: Vec<String> = key_tokens(key.as_bytes())
            .map(|token| String::from_utf8(token.to_ascii_lowercase()).expect("ascii"))
            .collect();
        let mut reference = Vec::new();
        for part in key.split(|character: char| !character.is_ascii_alphanumeric()) {
            let bytes = part.as_bytes();
            let mut start = 0;
            for index in 1..bytes.len() {
                if bytes[index].is_ascii_uppercase()
                    && (bytes[index - 1].is_ascii_lowercase()
                        || bytes.get(index + 1).is_some_and(u8::is_ascii_lowercase))
                {
                    reference.push(part[start..index].to_ascii_lowercase());
                    start = index;
                }
            }
            if start < part.len() {
                reference.push(part[start..].to_ascii_lowercase());
            }
        }
        prop_assert_eq!(scanner, reference);
    }
}
