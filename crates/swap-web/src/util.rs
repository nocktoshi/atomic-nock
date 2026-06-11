//! Display helpers. Port of the pure parts of `src/ui/util.ts`.

pub const NICKS_PER_NOCK: f64 = 65536.0;

/// Abbreviate a long id/address as `head…tail`.
pub fn short(s: &str) -> String {
    short_with(s, 8, 6)
}

pub fn short_with(s: &str, head: usize, tail: usize) -> String {
    if s.is_empty() {
        return "—".to_string();
    }
    if s.chars().count() > head + tail + 1 {
        let chars: Vec<char> = s.chars().collect();
        let h: String = chars[..head].iter().collect();
        let t: String = chars[chars.len() - tail..].iter().collect();
        format!("{h}…{t}")
    } else {
        s.to_string()
    }
}

/// Format nicks as a human NOCK string.
pub fn format_nock(nicks: u64) -> String {
    let nock = nicks as f64 / NICKS_PER_NOCK;
    // trim trailing zeros like parseFloat(toFixed(6))
    let s = format!("{:.6}", nock);
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    format!("{trimmed} NOCK")
}

/// Parse a NOCK input string into nicks, or `None` if not finite.
pub fn nock_to_nicks(nock: &str) -> Option<u64> {
    let n: f64 = nock.trim().parse().ok()?;
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    Some((n * NICKS_PER_NOCK).round() as u64)
}

/// Truncate a wallet address for a button label.
pub fn trunc_addr(addr: &str) -> String {
    short_with(addr, 8, 6)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_nock() {
        assert_eq!(format_nock(65536), "1 NOCK");
        assert_eq!(format_nock(32768), "0.5 NOCK");
        assert_eq!(format_nock(50 * 65536), "50 NOCK");
    }

    #[test]
    fn nock_to_nicks_round_trips() {
        assert_eq!(nock_to_nicks("1"), Some(65536));
        assert_eq!(nock_to_nicks("0.5"), Some(32768));
        assert_eq!(nock_to_nicks("nope"), None);
    }

    #[test]
    fn short_abbreviates() {
        assert_eq!(short(""), "—");
        assert_eq!(short("0x1234567890abcdef1234"), "0x123456…ef1234");
        assert_eq!(short("short"), "short");
    }
}
