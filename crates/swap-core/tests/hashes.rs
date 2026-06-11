//! Golden test for the structural hax preimage hash, lifted from the rose-rs
//! `fix/hax-hash` commit (a real HTLC preimage from a failing claim). This
//! proves our `hash_preimage` routes through `Hax::hash_preimage` (the node's
//! structural hash-noun) and NOT the buggy whole-noun `hashNoun`, which is the
//! whole reason we pin the rose-rs fork. See [[iris-rs-hax-fix]].

use swap_core::hash_preimage;

#[test]
fn hash_preimage_matches_node_structural_hash() {
    // A real HTLC hax preimage jam (from a failing nock-otc claim).
    let jam: [u8; 79] = [
        1, 4, 94, 58, 17, 242, 138, 59, 221, 17, 3, 236, 145, 212, 172, 51, 41, 91, 17, 50, 64,
        143, 128, 4, 27, 38, 225, 48, 160, 7, 16, 192, 24, 8, 250, 63, 48, 130, 139, 12, 240, 187,
        33, 147, 240, 145, 120, 104, 131, 3, 244, 36, 50, 199, 221, 55, 56, 152, 120, 0, 129, 72,
        209, 194, 114, 52, 110, 8, 86, 192, 239, 178, 176, 65, 126, 22, 54, 38, 6,
    ];
    assert_eq!(
        hash_preimage(&jam).unwrap(),
        "8XiEzPMGNQp29EwSdtGhHsyEmXsDR2AkZfuTWCfydWVA8XbKsLk7BGo"
    );
}
