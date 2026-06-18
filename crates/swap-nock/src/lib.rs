//! Nockchain layer for atomic-nock (port of `src/nock/*`).
//!
//! Done + tested: the deterministic HTLC lock construction ([`lock`], native +
//! wasm) and the gRPC-Web client ([`grpc`], wasm-only).
//!
//! NOT yet ported (tracked separately; needs a live Nockchain node + golden
//! fixtures from the running app to validate): the full lock/claim/refund tx
//! building (`SpendBuilder`/`TxBuilder` + fee balancing), `signAndSendIrisTx`
//! and its tx-shape patching, balance/note parsing, and the `window.nockchain`
//! extension bridge. These are protocol-fragile (see `src/nock/wallet.ts`).

pub mod lock;
pub mod preimage;

#[cfg(all(target_arch = "wasm32", feature = "grpc"))]
pub mod grpc;

pub use lock::{htlc_gift_first_name, htlc_lock_root, htlc_or_lock};
pub use preimage::generate_preimage_jam;
