//! HTLC OR-lock construction + lock-root, on the native iris-rs types. Port of
//! `htlcOrLock` / `htlcLockRootDigest` in `src/nock/tx.ts`.
//!
//! The lock has two branches:
//!   - claim:  `[Pkh(buyer), Hax(hNock)]`  (buyer spends by revealing the preimage)
//!   - refund: `[Pkh(seller), Tim(abs.min = refundHeight)]`  (seller reclaims later)
//!
//! `hNock` is the STRUCTURAL hax hash of the preimage (see
//! [`swap_core::hash_preimage`] / [[iris-rs-hax-fix]]). The refund timelock uses
//! the canonical NUMBER encoding (a `u32` block height) — correct for swaps
//! created after the hax fix (the rose-rs fork we pin), per the `tx.ts` note.

use iris_nockchain_types::v1::{Hax, Lock, LockPrimitive, LockTim, Pkh, SpendCondition};
use iris_nockchain_types::TimelockRange;
use iris_ztd::{Digest, Hashable};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockError(pub String);

impl core::fmt::Display for LockError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for LockError {}

fn digest(b58: &str, label: &str) -> Result<Digest, LockError> {
    Digest::try_from(b58).map_err(|_| LockError(format!("{label} is not a valid base58 digest")))
}

/// Build the HTLC OR(claim | refund) lock. Port of `htlcOrLock`.
pub fn htlc_or_lock(
    h_nock: &str,
    buyer_pkh: &str,
    seller_pkh: &str,
    refund_height: u32,
) -> Result<Lock, LockError> {
    let claim = SpendCondition(vec![
        LockPrimitive::Pkh(Pkh::single(digest(buyer_pkh, "buyerPkh")?)),
        LockPrimitive::Hax(Hax {
            preimages: [digest(h_nock, "hNock")?].into(),
        }),
    ]);
    let refund = SpendCondition(vec![
        LockPrimitive::Pkh(Pkh::single(digest(seller_pkh, "sellerPkh")?)),
        LockPrimitive::Tim(LockTim {
            rel: TimelockRange::none(),
            // abs.min = Number(refundHeight) — canonical node encoding.
            abs: TimelockRange {
                min: Some(refund_height),
                max: None,
            },
        }),
    ]);
    Ok(Lock::from_list(vec![claim, refund]))
}

/// Digest of the HTLC OR lock tree (== iris `lockRootHash`). Port of
/// `htlcLockRootDigest`.
pub fn htlc_lock_root(
    h_nock: &str,
    buyer_pkh: &str,
    seller_pkh: &str,
    refund_height: u32,
) -> Result<Digest, LockError> {
    Ok(htlc_or_lock(h_nock, buyer_pkh, seller_pkh, refund_height)?.hash())
}

/// The HTLC gift output's `name.first` — what the buyer claims. Port of
/// `htlcGiftOutputFirstName`, but computed directly: for a V1 note,
/// `Name::new_v1` sets `first = (true, lock_root).hash()` (see iris
/// `tx_engine/note.rs`), so the first name depends ONLY on the lock root — not on
/// the input note, parent hash, source, or output index. (The TS does a full
/// TxBuilder simulation to reach the same value.)
pub fn htlc_gift_first_name(
    h_nock: &str,
    buyer_pkh: &str,
    seller_pkh: &str,
    refund_height: u32,
) -> Result<Digest, LockError> {
    let lock_root = htlc_lock_root(h_nock, buyer_pkh, seller_pkh, refund_height)?;
    Ok((true, lock_root).hash())
}

#[cfg(test)]
mod tests {
    use super::*;
    use swap_core::{hash_preimage, hash_public_key};

    // Three distinct, valid base58 digests derived through the real crypto.
    fn fixtures() -> (String, String, String) {
        let buyer = hash_public_key(&[0u8; 97]).unwrap();
        let seller = hash_public_key(&[1u8; 97]).unwrap();
        // a real structural hax preimage hash (the golden from the hax-fix test)
        let h_nock = hash_preimage(&[
            1, 4, 94, 58, 17, 242, 138, 59, 221, 17, 3, 236, 145, 212, 172, 51, 41, 91, 17, 50, 64,
            143, 128, 4, 27, 38, 225, 48, 160, 7, 16, 192, 24, 8, 250, 63, 48, 130, 139, 12, 240,
            187, 33, 147, 240, 145, 120, 104, 131, 3, 244, 36, 50, 199, 221, 55, 56, 152, 120, 0,
            129, 72, 209, 194, 114, 52, 110, 8, 86, 192, 239, 178, 176, 65, 126, 22, 54, 38, 6,
        ])
        .unwrap();
        (h_nock, buyer, seller)
    }

    #[test]
    fn lock_root_is_deterministic() {
        let (h, b, s) = fixtures();
        let a = htlc_lock_root(&h, &b, &s, 1000).unwrap();
        let c = htlc_lock_root(&h, &b, &s, 1000).unwrap();
        assert_eq!(a, c);
    }

    #[test]
    fn lock_root_depends_on_every_input() {
        let (h, b, s) = fixtures();
        let base = htlc_lock_root(&h, &b, &s, 1000).unwrap();
        // changing the refund height changes the root
        assert_ne!(base, htlc_lock_root(&h, &b, &s, 1001).unwrap());
        // swapping buyer/seller changes the root
        assert_ne!(base, htlc_lock_root(&h, &s, &b, 1000).unwrap());
    }

    #[test]
    fn lock_has_two_branches() {
        let (h, b, s) = fixtures();
        let lock = htlc_or_lock(&h, &b, &s, 1000).unwrap();
        assert_eq!(lock.height(), 2); // V2 == two spend conditions
    }

    #[test]
    fn rejects_non_digest_inputs() {
        let (h, b, _s) = fixtures();
        assert!(htlc_lock_root(&h, &b, "not-a-digest!", 1000).is_err());
    }

    #[test]
    fn gift_first_name_is_derived_from_lock_root() {
        let (h, b, s) = fixtures();
        let name = htlc_gift_first_name(&h, &b, &s, 1000).unwrap();
        // deterministic + distinct from the lock root itself
        assert_eq!(name, htlc_gift_first_name(&h, &b, &s, 1000).unwrap());
        assert_ne!(name, htlc_lock_root(&h, &b, &s, 1000).unwrap());
        // changing any lock input changes the gift name (it folds in the lock root)
        assert_ne!(name, htlc_gift_first_name(&h, &b, &s, 1001).unwrap());
    }
}
