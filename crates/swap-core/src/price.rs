//! Price helpers. Port of the pure parts of `src/market/price.ts`.
//!
//! The cached, fetch-backed `createPriceProvider` is platform/async and lands in
//! the web crate (Phase F, over gloo-net); the pure extraction + implied-price
//! math live here so they're unit-tested with `cargo test`.

use serde_json::Value;

use crate::swap::Swap;

const NICKS_PER_NOCK: f64 = 65536.0;

/// Pull a USD number out of a few common JSON shapes (CoinGecko etc.).
/// Port of `extractUsd`.
pub fn extract_usd(data: &Value) -> Option<f64> {
    match data {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => {
            // CoinGecko simple/price: { nock: { usd: 1.23 } }
            for v in o.values() {
                if let Value::Object(inner) = v {
                    if let Some(usd) = inner.get("usd").and_then(Value::as_f64) {
                        return Some(usd);
                    }
                }
            }
            o.get("usd")
                .and_then(Value::as_f64)
                .or_else(|| o.get("price").and_then(Value::as_f64))
        }
        _ => None,
    }
}

/// Implied NOCK/USD price from a swap's own amounts (USDC ≈ USD).
/// Port of `impliedNockUsd`.
pub fn implied_nock_usd(swap: &Swap) -> Option<f64> {
    let amount = swap.usdc_amount.as_deref()?;
    let usdc: f64 = amount.trim().parse().ok()?;
    let nock = swap.nock_gift as f64 / NICKS_PER_NOCK;
    if !usdc.is_finite() || !nock.is_finite() || nock <= 0.0 {
        return None;
    }
    Some(usdc / nock)
}
