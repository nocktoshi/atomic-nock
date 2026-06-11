//! EVM config. Mirrors the Base-mainnet defaults in `src/config.ts`. The TS
//! versions are env-overridable (VITE_*); these become runtime/build config in
//! Phase H — hardcoded to the same defaults for now.

use alloy_primitives::{address, Address};

/// Base mainnet chain id (`CHAIN_ID`, default `base.id`).
pub const CHAIN_ID: u64 = 8453;

/// Base USDC (`USDC_ADDRESS`).
pub const USDC_ADDRESS: Address = address!("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

/// Deployed AtomicNock HTLC (`HTLC_ADDRESS` default).
pub const HTLC_ADDRESS: Address = address!("5ac37e7A63b107d226d0b88129B8EB8b07172B75");

/// Fallback swap fee in basis points when the contract read is unavailable.
pub const DEFAULT_FEE_BPS: u16 = 50;
