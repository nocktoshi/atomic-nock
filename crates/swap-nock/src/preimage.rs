//! Swap-secret / preimage generation. Port of `generateSwapSecret` (`src/swap.ts`).
//!
//! The preimage is a random 32-byte value encoded as a hex string, turned into a
//! belt-sequence noun via `tasBelts` (NOT a single `tas` atom — a single atom is
//! too large for hashNoun/Tip5), then jammed. The seller keeps the hex/jam
//! client-side and only reveals it on the Base withdraw.

use iris_ztd::{belts_from_ubig, jam, BeltSeq, Noun, NounEncode};

/// `tas`: a string's bytes as a little-endian atom.
fn tas(s: &str) -> Noun {
    Noun::Atom(ibig::UBig::from_le_bytes(s.as_bytes()))
}

/// `tasBelts`: `atom_to_belts(tas(s))` — the atom split into goldilocks belts.
fn tas_belts(s: &str) -> Noun {
    let Noun::Atom(atom) = tas(s) else {
        unreachable!("tas always returns an atom")
    };
    BeltSeq(belts_from_ubig(atom)).to_noun()
}

/// Generate a fresh swap secret: `(preimage_jam, secret_hex)`. The 32 random
/// bytes are hex-encoded, `tasBelts`-encoded, and jammed.
pub fn generate_preimage_jam() -> Result<(Vec<u8>, String), &'static str> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "failed to generate randomness")?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok((jam(tas_belts(&hex)), hex))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock; // ensure crate wiring
    use iris_ztd::cue;
    use swap_core::hash_preimage;

    #[test]
    fn preimage_jam_cues_back_and_hashes() {
        let (jam_bytes, hex) = generate_preimage_jam().unwrap();
        assert_eq!(hex.len(), 64); // 32 bytes hex
        // a valid jam round-trips through cue
        assert!(cue(&jam_bytes).is_some());
        // and produces a valid structural hax digest
        assert!(hash_preimage(&jam_bytes).is_ok());
        let _ = lock::htlc_or_lock; // keep import meaningful
    }

    #[test]
    fn two_secrets_differ() {
        let (a, _) = generate_preimage_jam().unwrap();
        let (b, _) = generate_preimage_jam().unwrap();
        assert_ne!(a, b);
    }
}
