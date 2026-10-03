//! Modified UTF-7 (RFC 3501, section 5.1.3) used by IMAP for mailbox names,
//! e.g. `&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-` is "Отправленные".

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

pub fn decode(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let chunk = &after[..end];
        if chunk.is_empty() {
            out.push('&');
        } else if let Some(text) = decode_chunk(chunk) {
            out.push_str(&text);
        } else {
            // Not valid modified UTF-7: keep the bytes as the server sent them.
            out.push_str(&rest[start..start + end + 2]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

pub fn encode(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending: Vec<u16> = Vec::new();
    for ch in name.chars() {
        if (' '..='~').contains(&ch) {
            flush(&mut pending, &mut out);
            if ch == '&' {
                out.push_str("&-");
            } else {
                out.push(ch);
            }
        } else {
            let mut buf = [0u16; 2];
            pending.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    flush(&mut pending, &mut out);
    out
}

fn flush(units: &mut Vec<u16>, out: &mut String) {
    if units.is_empty() {
        return;
    }
    let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_be_bytes()).collect();
    out.push('&');
    for group in bytes.chunks(3) {
        let n = group
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=group.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out.push('-');
    units.clear();
}

fn decode_chunk(chunk: &str) -> Option<String> {
    let mut bits = 0u32;
    let mut nbits = 0;
    let mut bytes = Vec::with_capacity(chunk.len());
    for c in chunk.bytes() {
        let v = ALPHABET.iter().position(|a| *a == c)? as u32;
        bits = (bits << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            bytes.push((bits >> nbits) as u8);
            bits &= (1 << nbits) - 1;
        }
    }
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes.chunks(2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_russian_names() {
        assert_eq!(decode("&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"), "Отправленные");
        assert_eq!(encode("Отправленные"), "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-");
        for name in ["INBOX", "Входящие/Работа", "A & B", "日本語", "mix Ёлка 1"] {
            assert_eq!(decode(&encode(name)), name);
        }
    }

    #[test]
    fn keeps_ascii_and_ampersand() {
        assert_eq!(encode("A & B"), "A &- B");
        assert_eq!(decode("A &- B"), "A & B");
        assert_eq!(decode("broken &zz"), "broken &zz");
    }
}
