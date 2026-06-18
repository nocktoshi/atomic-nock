//! Client-side swap persistence for atomic-nock (port of `src/app/repo/*`,
//! `src/app/storage/*`, `src/app/auth.ts`). Builds native + wasm; `MemorySwapApi`
//! over [`kv::MemoryKv`] is the dev/test path, `HttpSwapApi` (wasm) talks to the
//! deployed Worker with the Iris-signed session flow.

pub mod api;
pub mod auth;
pub mod kv;
pub mod repo;

#[cfg(target_arch = "wasm32")]
pub mod http;
#[cfg(target_arch = "wasm32")]
pub mod name_resolve;
#[cfg(target_arch = "wasm32")]
pub mod price;

pub use api::{ApiError, MemorySwapApi, SwapApi};
pub use auth::{is_fresh, token_expiry, SignedAuth, Signer};
pub use kv::{Kv, MemoryKv};
pub use repo::SwapRepository;

#[cfg(target_arch = "wasm32")]
pub use http::HttpSwapApi;
