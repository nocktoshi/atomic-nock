//! Rust-native Nockchain crypto helpers, calling `iris-crypto` directly (no
//! wasm-bindgen / JsValue, unlike the `iris-wasm` JS layer).

use iris_crypto::{Hashable, PublicKey};

/// Length, in bytes, of a serialized Nockchain (cheetah) public key.
pub const PUBKEY_LEN: usize = 97;

/// Compute the base58 public-key hash (pkh) for a 97-byte public key.
///
/// Rust-native port of `iris-wasm`'s `hashPublicKey`.
pub fn hash_public_key(public_key_bytes: &[u8]) -> Result<String, &'static str> {
    if public_key_bytes.len() != PUBKEY_LEN {
        return Err("public key must be 97 bytes");
    }
    let mut buf = [0u8; PUBKEY_LEN];
    buf.copy_from_slice(public_key_bytes);
    Ok(PublicKey::from_be_bytes(&buf).hash().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_public_key_rejects_wrong_length() {
        assert!(hash_public_key(&[0u8; 10]).is_err());
        assert!(hash_public_key(&[0u8; PUBKEY_LEN]).is_ok());
    }
}
