//! Stateless sign-in: an HMAC-bound login challenge the user signs with Iris,
//! exchanged for a short-lived HMAC session token bound to their pkh. Port of
//! `worker/src/session.ts` (crypto.subtle HMAC-SHA256 → `hmac`+`sha2`).
//!
//! These functions are pure: the caller supplies the current time (`now_ms` /
//! `exp_ms`) and the challenge randomness, so they unit-test natively without a
//! Worker runtime. The Worker passes `Date::now()` and a random nonce.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

const CHALLENGE_PREFIX: &str = "atomicnock-login";

/// Challenge TTL: 2 minutes to sign (matches `CHALLENGE_TTL_MS`).
pub const CHALLENGE_TTL_MS: u64 = 2 * 60_000;
/// Session TTL: 7 days (matches `SESSION_TTL_MS`).
pub const SESSION_TTL_MS: u64 = 7 * 24 * 60 * 60_000;

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

fn hmac_b64url(secret: &str, data: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key len");
    mac.update(data.as_bytes());
    b64url(&mac.finalize().into_bytes())
}

/// Constant-time string compare (subtle returns false on length mismatch).
fn ct_eq(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub challenge: String,
    pub challenge_mac: String,
}

/// Issue a signed login challenge for `pkh`, expiring at `exp_ms` (epoch ms,
/// usually `now + CHALLENGE_TTL_MS`). `rand` is a fresh 16-byte nonce.
pub fn make_challenge(pkh: &str, secret: &str, exp_ms: u64, rand: &[u8; 16]) -> Challenge {
    let challenge = format!("{CHALLENGE_PREFIX}|{pkh}|{exp_ms}|{}", b64url(rand));
    let challenge_mac = hmac_b64url(secret, &challenge);
    Challenge {
        challenge,
        challenge_mac,
    }
}

/// Validate a previously-issued challenge; returns the bound pkh or `None`.
pub fn validate_challenge(
    challenge: &str,
    challenge_mac: &str,
    secret: &str,
    now_ms: u64,
) -> Option<String> {
    let expected = hmac_b64url(secret, challenge);
    if !ct_eq(&expected, challenge_mac) {
        return None;
    }
    let parts: Vec<&str> = challenge.split('|').collect();
    if parts.len() != 4 || parts[0] != CHALLENGE_PREFIX {
        return None;
    }
    let exp: u64 = parts[2].parse().ok()?;
    if now_ms > exp {
        return None;
    }
    Some(parts[1].to_string())
}

/// Mint a session token bound to `pkh`, expiring at `exp_ms`
/// (usually `now + SESSION_TTL_MS`). Format: `<b64url(json)>.<mac>`.
pub fn issue_token(pkh: &str, secret: &str, exp_ms: u64) -> String {
    // preserve_order keeps the {pkh, exp} key order identical to the TS worker.
    let payload_json = serde_json::json!({ "pkh": pkh, "exp": exp_ms }).to_string();
    let payload = b64url(payload_json.as_bytes());
    let mac = hmac_b64url(secret, &payload);
    format!("{payload}.{mac}")
}

/// Verify a session token; returns the bound pkh or `None`.
pub fn verify_token(token: Option<&str>, secret: &str, now_ms: u64) -> Option<String> {
    let token = token?;
    let dot = token.find('.')?;
    let payload = &token[..dot];
    let mac = &token[dot + 1..];
    let expected = hmac_b64url(secret, payload);
    if !ct_eq(&expected, mac) {
        return None;
    }
    let json = b64url_decode(payload)?;
    let claims: serde_json::Value = serde_json::from_slice(&json).ok()?;
    let pkh = claims.get("pkh")?.as_str()?;
    let exp = claims.get("exp")?.as_u64()?;
    if pkh.is_empty() || now_ms > exp {
        return None;
    }
    Some(pkh.to_string())
}

/// Pull the bearer token out of an `Authorization` header value.
pub fn bearer(authorization: Option<&str>) -> Option<&str> {
    authorization?.strip_prefix("Bearer ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-session-secret";
    const PKH: &str = "SELLER_PKH";
    const RAND: [u8; 16] = [7u8; 16];

    #[test]
    fn challenge_round_trips_and_binds_pkh() {
        let c = make_challenge(PKH, SECRET, 10_000, &RAND);
        assert_eq!(
            validate_challenge(&c.challenge, &c.challenge_mac, SECRET, 9_000).as_deref(),
            Some(PKH)
        );
    }

    #[test]
    fn challenge_rejects_tampered_mac_and_expiry() {
        let c = make_challenge(PKH, SECRET, 10_000, &RAND);
        // wrong mac
        assert!(validate_challenge(&c.challenge, "deadbeef", SECRET, 9_000).is_none());
        // wrong secret
        assert!(validate_challenge(&c.challenge, &c.challenge_mac, "other", 9_000).is_none());
        // expired (now > exp)
        assert!(validate_challenge(&c.challenge, &c.challenge_mac, SECRET, 10_001).is_none());
        // tampered pkh in the challenge body invalidates the mac
        let forged = c.challenge.replace(PKH, "ATTACKER");
        assert!(validate_challenge(&forged, &c.challenge_mac, SECRET, 9_000).is_none());
    }

    #[test]
    fn token_round_trips_and_expires() {
        let token = issue_token(PKH, SECRET, 100_000);
        assert_eq!(verify_token(Some(&token), SECRET, 50_000).as_deref(), Some(PKH));
        // expired
        assert!(verify_token(Some(&token), SECRET, 100_001).is_none());
        // tampered payload
        let bad = format!("x{token}");
        assert!(verify_token(Some(&bad), SECRET, 50_000).is_none());
        // wrong secret
        assert!(verify_token(Some(&token), "other", 50_000).is_none());
        // no token
        assert!(verify_token(None, SECRET, 50_000).is_none());
    }

    #[test]
    fn bearer_parses_header() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(None), None);
    }
}
