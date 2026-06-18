//! Live NOCK/USD price fetch (wasm), reusing the verified `swap_core::price::extract_usd`.
//! Port of `createPriceProvider`'s fetch path (CoinGecko-shaped JSON).

use gloo_net::http::Request;

/// Fetch the current NOCK/USD price from `url` (CoinGecko-shaped). `None` on any
/// error or empty url — the banner just hides the price then.
pub async fn fetch_nock_usd(url: &str) -> Option<f64> {
    if url.is_empty() {
        return None;
    }
    let res = Request::get(url).send().await.ok()?;
    if res.status() != 200 {
        return None;
    }
    let v: serde_json::Value = res.json().await.ok()?;
    swap_core::price::extract_usd(&v).filter(|n| n.is_finite())
}
