//! Server-side Nockchain signature verification (the sign-in trust anchor).
//! Rust-native port of `worker/src/verify.ts` — calls `iris-crypto` directly
//! instead of running rose-wasm's `hashPublicKey` / `verifySignature`.
//!
//! We verify two things:
//!   1. `hash_public_key(pubkey_bytes) == expected_pkh` (binds the key to the
//!      account whose fields change), and
//!   2. `public_key.verify(digest, signature)` (proves key control),
//!
//! where `digest` is hashed from the message exactly as iris-wasm does.

use iris_crypto::{PublicKey, Signature};
use iris_ztd::{Belt, Digest, Hashable, NounEncode};

use crate::crypto::{hash_public_key, PUBKEY_LEN};
use crate::swap::hex_to_bytes;

/// Hash the signed message the same way iris-wasm `signMessage`/`verifySignature` do.
fn message_digest(message: &str) -> Digest {
    Belt::from_bytes(message.as_bytes()).to_noun().hash()
}

/// Returns the verified base58 pkh if the signature is valid AND (when
/// `expected_pkh` is `Some`) the public key hashes to it. `None` on any failure.
///
/// Pass `expected_pkh = None` during the login challenge to learn *which* pkh
/// signed; pass the on-record pkh to assert a specific signer.
pub fn verify_nock_signature(
    message: &str,
    pubkey_hex: &str,
    signature: &Signature,
    expected_pkh: Option<&str>,
) -> Option<String> {
    let bytes = hex_to_bytes(pubkey_hex)?;
    if bytes.len() != PUBKEY_LEN {
        return None;
    }
    let pkh = hash_public_key(&bytes).ok()?;
    if let Some(exp) = expected_pkh {
        if pkh != exp {
            return None;
        }
    }
    let mut buf = [0u8; PUBKEY_LEN];
    buf.copy_from_slice(&bytes);
    let public_key = PublicKey::from_be_bytes(&buf);
    if public_key.verify(&message_digest(message), signature) {
        Some(pkh)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swap::bytes_to_hex;
    use iris_crypto::PrivateKey;
    use iris_ztd::U256;

    /// A deterministic keypair + a message-bound signature exercising the full
    /// hash → sign → verify path through the real iris-crypto primitives.
    fn keypair_and_sig(message: &str) -> (String, String, Signature) {
        let sk = PrivateKey(U256::from_u64(0x1234_5678_9abc_def0));
        let pk = sk.public_key();
        let pubkey_hex = bytes_to_hex(&pk.to_be_bytes());
        let pkh = hash_public_key(&pk.to_be_bytes()).unwrap();
        let sig = sk.sign(&message_digest(message));
        (pubkey_hex, pkh, sig)
    }

    #[test]
    fn verifies_a_valid_signature_and_binds_pkh() {
        let msg = "atomicnock-login|SOME_PKH|123|abcd";
        let (pubkey_hex, pkh, sig) = keypair_and_sig(msg);
        // No expected pkh: returns whoever signed.
        assert_eq!(
            verify_nock_signature(msg, &pubkey_hex, &sig, None).as_deref(),
            Some(pkh.as_str())
        );
        // Correct expected pkh: accepted.
        assert_eq!(
            verify_nock_signature(msg, &pubkey_hex, &sig, Some(&pkh)).as_deref(),
            Some(pkh.as_str())
        );
    }

    #[test]
    fn rejects_wrong_expected_pkh() {
        let msg = "hello";
        let (pubkey_hex, _pkh, sig) = keypair_and_sig(msg);
        assert!(verify_nock_signature(msg, &pubkey_hex, &sig, Some("NOT_THE_SIGNER")).is_none());
    }

    #[test]
    fn rejects_signature_over_a_different_message() {
        let (pubkey_hex, pkh, sig) = keypair_and_sig("message-A");
        assert!(verify_nock_signature("message-B", &pubkey_hex, &sig, Some(&pkh)).is_none());
    }

    #[test]
    fn signature_survives_json_round_trip() {
        // The client sends the signature as JSON; the worker deserializes it.
        // Same serde impl on both sides → must round-trip losslessly.
        let (pubkey_hex, pkh, sig) = keypair_and_sig("wire-test");
        let json = serde_json::to_string(&sig).unwrap();
        let back: Signature = serde_json::from_str(&json).unwrap();
        assert_eq!(sig, back);
        assert_eq!(
            verify_nock_signature("wire-test", &pubkey_hex, &back, Some(&pkh)).as_deref(),
            Some(pkh.as_str())
        );
    }
}
