//! Swap persistence keyed by `hEvm`, over a [`SwapApi`]. Port of `swap-repo.ts`.
//! Listing goes through the authenticated `idx:nock:<pkh>:` index (every swap you
//! participate in). Encoding/decoding + field-scoping reuse swap-core.

use swap_core::roles::Role;
use swap_core::state_machine::progress_fields;
use swap_core::swap::{decode_swap_record, encode_swap_record, Swap};

use crate::api::{ApiError, ApiResult, SwapApi};

const NOCK_IDX: &str = "idx:nock:";

pub struct SwapRepository<A: SwapApi> {
    api: A,
}

impl<A: SwapApi> SwapRepository<A> {
    pub fn new(api: A) -> Self {
        Self { api }
    }

    pub async fn get(&self, h_evm: &str) -> ApiResult<Option<Swap>> {
        match self.api.get(h_evm).await? {
            Some(rec) => decode_swap_record(&rec)
                .map(Some)
                .map_err(|e| ApiError(e.to_string())),
            None => Ok(None),
        }
    }

    /// Create a new (possibly open / buyer-less) swap. Seller-authenticated.
    pub async fn create(&self, swap: &Swap) -> ApiResult<()> {
        self.api.create(&encode_swap_record(swap)).await.map(|_| ())
    }

    /// Buyer commits to an open swap; returns the committed swap.
    pub async fn claim(&self, h_evm: &str, buyer_eth: &str) -> ApiResult<Swap> {
        let rec = self.api.claim(h_evm, buyer_eth).await?;
        decode_swap_record(&rec).map_err(|e| ApiError(e.to_string()))
    }

    /// Persist a party's progress fields (scoped to their role).
    pub async fn put(&self, swap: &Swap, role: Role) -> ApiResult<()> {
        if swap.h_evm.is_empty() {
            return Err(ApiError("swap has no id yet".into()));
        }
        let fields = progress_fields(&encode_swap_record(swap), role);
        self.api.advance(&swap.h_evm, &fields).await.map(|_| ())
    }

    pub async fn list_for_nock_pkh(&self, pkh: &str) -> ApiResult<Vec<Swap>> {
        let prefix = format!("{NOCK_IDX}{pkh}:");
        let keys = self.api.list_keys(&prefix).await?;
        let mut out = Vec::new();
        for k in keys {
            let id = k.strip_prefix(&prefix).unwrap_or(&k);
            if let Some(swap) = self.get(id).await? {
                out.push(swap);
            }
        }
        Ok(out)
    }
}
