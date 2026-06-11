//! Port of the pure parts of `src/market/price.test.ts` (the `extractUsd` shapes
//! via `impliedNockUsd` and the implied-price math). The fetch/cache provider is
//! a Phase F web-crate concern.

use serde_json::json;
use swap_core::price::{extract_usd, implied_nock_usd};
use swap_core::swap::Swap;

fn base() -> Swap {
    Swap {
        h_nock: "H".into(),
        h_evm: "0x".into(),
        seller_pkh: "S".into(),
        buyer_pkh: "B".into(),
        seller_eth: Some("0xs".into()),
        nock_refund_height: 1,
        usdc_timelock: 1,
        nock_gift: 65536, // 1 NOCK
        ..Default::default()
    }
}

#[test]
fn computes_usdc_per_nock() {
    let mut s = base();
    s.usdc_amount = Some("2.5".into());
    assert_eq!(implied_nock_usd(&s), Some(2.5));
}

#[test]
fn returns_none_without_an_amount() {
    assert_eq!(implied_nock_usd(&base()), None);
}

#[test]
fn extracts_coingecko_shape() {
    assert_eq!(extract_usd(&json!({ "nock": { "usd": 1.23 } })), Some(1.23));
}

#[test]
fn handles_usd_and_price_shapes() {
    assert_eq!(extract_usd(&json!({ "usd": 2 })), Some(2.0));
    assert_eq!(extract_usd(&json!({ "price": 3 })), Some(3.0));
}

#[test]
fn returns_none_for_unrecognized() {
    assert_eq!(extract_usd(&json!({ "foo": "bar" })), None);
    assert_eq!(extract_usd(&json!("nope")), None);
}
