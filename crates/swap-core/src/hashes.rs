//! Nockchain HTLC preimage hashing. Port of `rose.hashPreimage` (the
//! `hashPreimage` export added by the rose-rs `fix/hax-hash` branch).
//!
//! `hNock` MUST be the node's STRUCTURAL hash-noun (hash-varlen per belt leaf +
//! hash-ten-cell per cell), NOT iris `hashNoun` (hash-varlen over the whole
//! noun), or the HTLC hax check `=(h (hash-noun u.preimage))` can never match.
//! See `Hax::hash_preimage` in iris-nockchain-types and the note in
//! [`crate`] about the rose-rs dependency.

use iris_nockchain_types::v1::Hax;
use iris_ztd::cue;

/// Base58 structural hash-noun of a jammed HTLC preimage (== `rose.hashPreimage`).
pub fn hash_preimage(preimage_jam: &[u8]) -> Result<String, &'static str> {
    let noun = cue(preimage_jam).ok_or("unable to cue preimage jam")?;
    Ok(Hax::hash_preimage(&noun).to_string())
}
