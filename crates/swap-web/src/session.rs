//! Global wallet session + dev repo, shared via Leptos context. Port of
//! `SessionProvider`/`useSession` — the nock-action closures (claim/lock/refund)
//! need the window.nockchain bridge (deferred), so this holds the connection
//! state + log; the on-chain actions are wired in the components as they land.

use std::sync::Arc;

use leptos::prelude::*;
use swap_client::{MemoryKv, MemorySwapApi, SwapRepository};

/// Dev persistence: the in-memory MemorySwapApi (no worker / no sign-in needed).
pub type DevRepo = SwapRepository<MemorySwapApi<MemoryKv>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NockSession {
    pub pkh: String,
    pub address: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogCls {
    None,
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogState {
    pub msg: String,
    pub cls: LogCls,
}

impl LogState {
    pub fn class(&self) -> &'static str {
        match self.cls {
            LogCls::None => "log",
            LogCls::Ok => "log ok",
            LogCls::Error => "log error",
        }
    }
}

/// Connection + UI state. All fields are `Copy` signal handles, so `SessionCtx`
/// is `Copy` and cheap to pass around.
#[derive(Clone, Copy)]
pub struct SessionCtx {
    pub nock: RwSignal<Option<NockSession>>,
    pub evm: RwSignal<Option<String>>,
    pub log: RwSignal<LogState>,
    /// Latest NOCK/USD market price (shared by the price banner + swap hint).
    pub price: RwSignal<Option<f64>>,
}

impl SessionCtx {
    pub fn set_log(&self, msg: impl Into<String>, ok: bool) {
        let msg = msg.into();
        let cls = if ok {
            LogCls::Ok
        } else if msg.starts_with("Error") {
            LogCls::Error
        } else {
            LogCls::None
        };
        self.log.set(LogState { msg, cls });
    }

    pub fn set_err(&self, msg: impl Into<String>) {
        self.log.set(LogState {
            msg: format!("Error: {}", msg.into()),
            cls: LogCls::Error,
        });
    }
}

/// Install the session context + dev repo at the app root.
pub fn provide_session(initial_log: &str) {
    provide_context(SessionCtx {
        nock: RwSignal::new(None),
        evm: RwSignal::new(None),
        log: RwSignal::new(LogState {
            msg: initial_log.to_string(),
            cls: LogCls::None,
        }),
        price: RwSignal::new(None),
    });
    let repo: Arc<DevRepo> = Arc::new(SwapRepository::new(MemorySwapApi::new(MemoryKv::new())));
    provide_context(repo);
}

pub fn session() -> SessionCtx {
    expect_context::<SessionCtx>()
}

pub fn repo() -> Arc<DevRepo> {
    expect_context::<Arc<DevRepo>>()
}
