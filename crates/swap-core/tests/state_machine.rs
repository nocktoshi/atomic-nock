//! Port of `worker/src/swaps.test.ts` — the state-machine ordering invariants.
//!
//! The TS test drives `createSwap/claimSwap/advanceSwap` against an in-memory
//! KV `Env`. The Rust transitions are pure, so this harness reproduces the
//! Worker's load → transition → write(record + index keys) loop over a HashMap.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use swap_core::roles::Role;
use swap_core::state_machine::{
    advance_swap, claim_swap, create_swap, index_keys, progress_fields, swap_key, SwapError,
    SwapRecord,
};

/// Minimal stand-in for the Worker's KV-backed `Env`.
#[derive(Default)]
struct FakeStore {
    kv: HashMap<String, String>,
}

impl FakeStore {
    fn load(&self, h_evm: &str) -> Option<SwapRecord> {
        self.kv
            .get(&swap_key(h_evm))
            .map(|raw| serde_json::from_str(raw).expect("stored record is valid json"))
    }

    fn write(&mut self, rec: &SwapRecord) {
        let h_evm = rec["hEvm"].as_str().unwrap();
        self.kv
            .insert(swap_key(h_evm), serde_json::to_string(rec).unwrap());
        for (k, v) in index_keys(rec) {
            self.kv.insert(k, v);
        }
    }

    fn create(&mut self, swap: &SwapRecord, pkh: &str) -> Result<SwapRecord, SwapError> {
        let exists = self.load(swap["hEvm"].as_str().unwrap()).is_some();
        let rec = create_swap(swap, pkh, exists)?;
        self.write(&rec);
        Ok(rec)
    }

    fn claim(&mut self, h_evm: &str, buyer_eth: &str, pkh: &str) -> Result<SwapRecord, SwapError> {
        let prev = self.load(h_evm);
        let rec = claim_swap(prev.as_ref(), buyer_eth, pkh)?;
        self.write(&rec);
        Ok(rec)
    }

    fn advance(
        &mut self,
        h_evm: &str,
        fields: Value,
        pkh: &str,
    ) -> Result<SwapRecord, SwapError> {
        let prev = self.load(h_evm);
        let fields = fields.as_object().cloned().unwrap_or_default();
        let rec = advance_swap(prev.as_ref(), &fields, pkh, None)?;
        self.write(&rec);
        Ok(rec)
    }
}

const SELLER: &str = "SELLER_PKH";
const BUYER: &str = "BUYER_PKH";

fn base_swap() -> SwapRecord {
    let v = json!({
        "hEvm": "0xabc",
        "hNock": "HN",
        "sellerPkh": SELLER,
        "usdcTimelock": "1",
        "nockGift": "100",
        "nockRefundHeight": "1",
        "sellerEth": "0xseller",
        "usdcAmount": "1",
    });
    v.as_object().cloned().unwrap()
}

fn seed_claimed() -> FakeStore {
    let mut store = FakeStore::default();
    store.create(&base_swap(), SELLER).expect("create");
    store.claim("0xabc", "0xbuyer", BUYER).expect("claim");
    store
}

fn err(r: Result<SwapRecord, SwapError>) -> SwapError {
    r.expect_err("expected an error")
}

#[test]
fn buyer_cannot_lock_usdc_before_seller_locks_nock() {
    let mut env = seed_claimed();
    let e = err(env.advance("0xabc", json!({ "usdcLockTxHash": "0xul" }), BUYER));
    assert!(
        e.message.contains("before \"lockFirstName\""),
        "got: {}",
        e.message
    );
}

#[test]
fn seller_cannot_withdraw_before_buyer_locks_usdc() {
    let mut env = seed_claimed();
    env.advance("0xabc", json!({ "lockFirstName": "LFN" }), SELLER)
        .unwrap();
    let e = err(env.advance("0xabc", json!({ "usdcWithdrawTxHash": "0xuw" }), SELLER));
    assert!(
        e.message.contains("before \"usdcLockTxHash\""),
        "got: {}",
        e.message
    );
}

#[test]
fn walks_the_full_happy_path_in_order() {
    let mut env = seed_claimed();
    env.advance(
        "0xabc",
        json!({ "lockFirstName": "LFN", "nockLockTxId": "0xnl" }),
        SELLER,
    )
    .unwrap();
    env.advance("0xabc", json!({ "usdcLockTxHash": "0xul" }), BUYER)
        .unwrap();
    env.advance("0xabc", json!({ "usdcWithdrawTxHash": "0xuw" }), SELLER)
        .unwrap();
    let rec = env
        .advance("0xabc", json!({ "nockClaimTxId": "0xnc" }), BUYER)
        .unwrap();
    assert_eq!(rec["nockClaimTxId"], json!("0xnc"));
    assert_eq!(rec["version"], json!(6)); // create=1, claim=2, +4 advances
}

#[test]
fn seller_cannot_withdraw_after_buyer_refunded_conflict() {
    let mut env = seed_claimed();
    env.advance("0xabc", json!({ "lockFirstName": "LFN" }), SELLER)
        .unwrap();
    env.advance("0xabc", json!({ "usdcLockTxHash": "0xul" }), BUYER)
        .unwrap();
    env.advance("0xabc", json!({ "usdcRefundTxHash": "0xrf" }), BUYER)
        .unwrap();
    let e = err(env.advance("0xabc", json!({ "usdcWithdrawTxHash": "0xuw" }), SELLER));
    assert!(
        e.message.contains("\"usdcRefundTxHash\" is already set"),
        "got: {}",
        e.message
    );
}

#[test]
fn non_participant_cannot_advance() {
    let mut env = seed_claimed();
    let e = err(env.advance("0xabc", json!({ "usdcLockTxHash": "0xul" }), "STRANGER_PKH"));
    assert!(e.message.contains("not a participant"), "got: {}", e.message);
}

// --- extra coverage beyond the TS suite (cheap, guards the port) ---

#[test]
fn create_requires_seller_pkh_matches_session() {
    let mut env = FakeStore::default();
    let e = err(env.create(&base_swap(), "SOMEONE_ELSE"));
    assert_eq!(e.status, 403);
}

#[test]
fn cannot_create_twice() {
    let mut env = FakeStore::default();
    env.create(&base_swap(), SELLER).unwrap();
    let e = err(env.create(&base_swap(), SELLER));
    assert_eq!(e.status, 409);
}

#[test]
fn buyer_cannot_be_claimed_twice() {
    let mut env = seed_claimed();
    let e = err(env.claim("0xabc", "0xother", "ANOTHER_BUYER"));
    assert_eq!(e.status, 409);
}

#[test]
fn missing_required_field_rejected_at_create() {
    let mut env = FakeStore::default();
    let mut swap = base_swap();
    swap.remove("nockGift");
    let e = err(env.create(&swap, SELLER));
    assert_eq!(e.status, 400);
    assert!(e.message.contains("nockGift"), "got: {}", e.message);
}

#[test]
fn progress_fields_scopes_to_role() {
    let mut rec = base_swap();
    rec.insert("lockFirstName".into(), json!("LFN")); // seller field
    rec.insert("usdcLockTxHash".into(), json!("0xul")); // buyer field
    let seller = progress_fields(&rec, Role::Seller);
    assert!(seller.contains_key("lockFirstName"));
    assert!(!seller.contains_key("usdcLockTxHash"));
    let buyer = progress_fields(&rec, Role::Buyer);
    assert!(buyer.contains_key("usdcLockTxHash"));
    assert!(!buyer.contains_key("lockFirstName"));
}

#[test]
fn index_keys_cover_both_parties() {
    let env = seed_claimed();
    // After claim, the nock index for the buyer's pkh must point back at the id.
    let key: Map<String, Value> = env.load("0xabc").unwrap();
    let _ = key; // record exists
    let idx = format!("idx:nock:{BUYER}:0xabc");
    assert_eq!(env.kv.get(&idx).map(String::as_str), Some("0xabc"));
    let eth_idx = "idx:eth:0xbuyer:0xabc";
    assert_eq!(env.kv.get(eth_idx).map(String::as_str), Some("0xabc"));
}
