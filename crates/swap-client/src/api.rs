//! The Worker's swap endpoints as a client trait, plus the in-memory dev/test
//! implementation. Port of `swap-api.ts` (`SwapApi` + `MemorySwapApi`).
//!
//! `HttpSwapApi` (gloo-net fetch + bearer token) is added with the auth flow;
//! `MemorySwapApi` mimics the Worker against a [`Kv`] for dev/tests without a
//! deployed worker or sign-in.

use serde_json::{json, Value};
use swap_core::state_machine::{index_keys, swap_key, SwapRecord};

use crate::kv::Kv;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError(pub String);

impl core::fmt::Display for ApiError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// Client for the Worker's semantic swap endpoints.
#[allow(async_fn_in_trait)]
pub trait SwapApi {
    async fn create(&self, swap: &SwapRecord) -> ApiResult<SwapRecord>;
    async fn claim(&self, h_evm: &str, buyer_eth: &str) -> ApiResult<SwapRecord>;
    async fn advance(&self, h_evm: &str, fields: &SwapRecord) -> ApiResult<SwapRecord>;
    /// Open read; `Ok(None)` when not found.
    async fn get(&self, h_evm: &str) -> ApiResult<Option<SwapRecord>>;
    async fn list_keys(&self, prefix: &str) -> ApiResult<Vec<String>>;
}

/// Dev/test: mimic the Worker against an in-memory [`Kv`] (no auth, no state
/// machine — just version bumps + index maintenance, like the TS mock).
pub struct MemorySwapApi<K: Kv> {
    kv: K,
    /// The connected wallet's pkh (the TS reads `getActiveWallet()?.pkh` on claim).
    active_pkh: Option<String>,
}

impl<K: Kv> MemorySwapApi<K> {
    pub fn new(kv: K) -> Self {
        Self {
            kv,
            active_pkh: None,
        }
    }

    pub fn with_active_pkh(kv: K, pkh: impl Into<String>) -> Self {
        Self {
            kv,
            active_pkh: Some(pkh.into()),
        }
    }

    async fn load(&self, h_evm: &str) -> Option<SwapRecord> {
        let raw = self.kv.get(&swap_key(h_evm)).await?;
        serde_json::from_str(&raw).ok()
    }

    async fn write(&self, rec: &SwapRecord) {
        let h_evm = rec.get("hEvm").and_then(Value::as_str).unwrap_or("");
        self.kv
            .put(&swap_key(h_evm), &serde_json::to_string(rec).unwrap())
            .await;
        for (k, v) in index_keys(rec) {
            self.kv.put(&k, &v).await;
        }
    }
}

fn truthy(rec: &SwapRecord, key: &str) -> bool {
    matches!(rec.get(key), Some(Value::String(s)) if !s.is_empty())
}

fn version(rec: &SwapRecord) -> u64 {
    rec.get("version").and_then(Value::as_u64).unwrap_or(1)
}

impl<K: Kv> SwapApi for MemorySwapApi<K> {
    async fn create(&self, swap: &SwapRecord) -> ApiResult<SwapRecord> {
        let mut rec = swap.clone();
        rec.insert("version".into(), json!(1));
        self.write(&rec).await;
        Ok(rec)
    }

    async fn claim(&self, h_evm: &str, buyer_eth: &str) -> ApiResult<SwapRecord> {
        let mut rec = self
            .load(h_evm)
            .await
            .ok_or_else(|| ApiError("swap not found".into()))?;
        if truthy(&rec, "buyerPkh") || truthy(&rec, "buyerEth") {
            return Err(ApiError("swap already claimed".into()));
        }
        if let Some(pkh) = &self.active_pkh {
            rec.insert("buyerPkh".into(), json!(pkh));
        }
        rec.insert("buyerEth".into(), json!(buyer_eth));
        rec.insert("version".into(), json!(version(&rec) + 1));
        self.write(&rec).await;
        Ok(rec)
    }

    async fn advance(&self, h_evm: &str, fields: &SwapRecord) -> ApiResult<SwapRecord> {
        let mut rec = self
            .load(h_evm)
            .await
            .ok_or_else(|| ApiError("swap not found".into()))?;
        for (k, v) in fields {
            rec.insert(k.clone(), v.clone());
        }
        rec.insert("version".into(), json!(version(&rec) + 1));
        self.write(&rec).await;
        Ok(rec)
    }

    async fn get(&self, h_evm: &str) -> ApiResult<Option<SwapRecord>> {
        Ok(self.load(h_evm).await)
    }

    async fn list_keys(&self, prefix: &str) -> ApiResult<Vec<String>> {
        Ok(self.kv.list(prefix).await)
    }
}
