//! Base / EVM HTLC layer for atomic-nock. Port of `src/evm/*`.
//!
//! The pure core (ABIs, amount math, calldata/return codecs) builds and tests on
//! native + wasm32. The EIP-1193 browser bridge + high-level contract ops live in
//! [`provider`] and are wasm-only (they call `window.ethereum`).

pub mod abi;
pub mod amount;
pub mod calls;
pub mod config;

#[cfg(target_arch = "wasm32")]
pub mod provider;

pub use amount::{parse_usdc, to_atomic};
pub use calls::OnchainLock;
