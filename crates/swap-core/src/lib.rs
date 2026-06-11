//! Shared, target-agnostic domain logic for atomic-nock.
//!
//! Builds for both native (`cargo test`) and wasm32 (the Leptos SPA + the
//! Worker), with no wasm-bindgen / JS interop — the Nockchain crypto comes
//! straight from the `iris-rs`/`rose-rs` crates. This crate is the single source
//! of truth for the swap wire contract and state machine, so the client and the
//! Worker cannot drift.

pub mod contract;
pub mod crypto;
pub mod hashes;
pub mod price;
pub mod roles;
pub mod session;
pub mod state_machine;
pub mod swap;
pub mod verify;

pub use crypto::{hash_public_key, PUBKEY_LEN};
pub use hashes::hash_preimage;
pub use roles::{role_for_swap, Role};
pub use state_machine::progress_fields;
pub use swap::{decode_swap_params, encode_swap_params, Swap};
pub use verify::verify_nock_signature;
