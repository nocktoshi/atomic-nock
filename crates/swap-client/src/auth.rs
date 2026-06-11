//! Client sign-in: exchange an Iris-signed challenge for a session token bound to
//! the wallet's pkh, cached in localStorage. Port of `auth.ts`.
//!
//! Signing the challenge needs the Iris wallet (the `window.nockchain` bridge),
//! so it's behind the [`Signer`] trait — the token freshness + cache + HTTP
//! plumbing here is complete and testable; only the signature is pluggable.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

use crate::api::ApiError;

pub const STORAGE_PREFIX: &str = "atomicnock.session.";
/// Treat a token as expired this long before its real exp (clock skew / long ops).
pub const EXPIRY_SKEW_MS: u64 = 5 * 60_000;

/// The Schnorr signature + pubkey a worker login needs (from the Iris wallet).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedAuth {
    pub pubkey_hex: String,
    pub sig_c: String,
    pub sig_s: String,
}

/// Produces an Iris signature over the worker login challenge. Implemented by the
/// `window.nockchain` bridge (deferred); stubbable for now.
#[allow(async_fn_in_trait)]
pub trait Signer {
    /// The connected wallet's pkh (must equal the challenge's bound pkh).
    fn pkh(&self) -> String;
    /// Sign `message` for the worker.
    async fn sign_for_worker(&self, message: &str) -> Result<SignedAuth, ApiError>;
}

/// Read the `exp` (ms) baked into a session token, or `None` if unreadable.
/// Matches the token format issued by `swap_core::session::issue_token`.
pub fn token_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').next()?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("exp")?.as_u64()
}

/// Whether a token is still fresh at `now_ms` (with the skew margin).
pub fn is_fresh(token: &str, now_ms: u64) -> bool {
    token_expiry(token).is_some_and(|exp| exp.saturating_sub(EXPIRY_SKEW_MS) > now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use swap_core::session::issue_token;

    #[test]
    fn reads_expiry_from_a_swap_core_token() {
        // Cross-validate against the worker's own token format.
        let exp = 10_000_000_000u64;
        let token = issue_token("SELLER_PKH", "secret", exp);
        assert_eq!(token_expiry(&token), Some(exp));
    }

    #[test]
    fn freshness_respects_skew() {
        let exp = 10_000_000_000u64;
        let token = issue_token("PKH", "secret", exp);
        assert!(is_fresh(&token, 1_000));
        assert!(is_fresh(&token, exp - EXPIRY_SKEW_MS - 1));
        assert!(!is_fresh(&token, exp - EXPIRY_SKEW_MS)); // within skew window
        assert!(!is_fresh(&token, exp + 1));
    }

    #[test]
    fn garbage_tokens_have_no_expiry() {
        assert_eq!(token_expiry("not-a-token"), None);
        assert!(!is_fresh("not-a-token", 0));
    }
}
