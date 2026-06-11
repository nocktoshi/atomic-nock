//! App shell + routing + components. Port of `src/ui/*` (App, WalletBar,
//! Dashboard, the wizards). The create→list→open flow runs fully in-browser
//! against the in-memory dev repo; on-chain step actions (lock NOCK / USDC,
//! withdraw, claim) need the wallet/node bridges and are gated with a note.

use std::sync::Arc;

use leptos::prelude::*;
use leptos_router::components::{Route, Router, Routes};
use leptos_router::hooks::{use_navigate, use_params_map};
use leptos_router::{path, NavigateOptions};
use wasm_bindgen_futures::spawn_local;

use swap_core::roles::{role_for_swap, swap_status, NockConn, Role, SwapStage, WalletConnection};
use swap_core::swap::Swap;
use swap_evm::calls::keccak256_hex;
use swap_nock::{generate_preimage_jam, htlc_gift_first_name, htlc_lock_root};

use crate::session::{provide_session, repo, session, DevRepo, NockSession, SessionCtx};
use crate::util::{format_nock, nock_to_nicks, short, trunc_addr, NICKS_PER_NOCK};

// --- small browser helpers ---

fn local_set(key: &str, value: &str) {
    if let Some(Ok(Some(s))) = web_sys::window().map(|w| w.local_storage()) {
        let _ = s.set_item(key, value);
    }
}

fn now_secs() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}

fn conn_of(s: &SessionCtx) -> WalletConnection {
    WalletConnection {
        eth: s.evm.get(),
        nock: s
            .nock
            .get()
            .map(|n| NockConn {
                pkh: n.pkh,
                address: n.address,
            }),
    }
}

fn stage_label(stage: SwapStage) -> &'static str {
    match stage {
        SwapStage::Created => "created",
        SwapStage::NockLocked => "NOCK locked",
        SwapStage::UsdcLocked => "USDC locked",
        SwapStage::Withdrawn => "USDC withdrawn",
        SwapStage::Claimed => "claimed",
        SwapStage::Refunded => "refunded",
    }
}

// --- root ---

#[component]
pub fn App() -> impl IntoView {
    provide_session("Welcome to Atomic Nock. Ready to swap.");
    view! {
        <Router>
            <div class="wallet-bar-wrap"><WalletBar/></div>
            <Routes fallback=Dashboard>
                <Route path=path!("/") view=Dashboard/>
                <Route path=path!("/new") view=NewSwap/>
                <Route path=path!("/swap/:id") view=SwapView/>
            </Routes>
        </Router>
    }
}

#[component]
fn WalletBar() -> impl IntoView {
    let s = session();
    let connect_evm = move |_| {
        spawn_local(async move {
            match swap_evm::provider::connect_wallet().await {
                Ok(addr) => s.evm.set(Some(addr.to_string())),
                Err(e) => s.set_err(e.to_string()),
            }
        });
    };
    // Dev Iris connect: a real, deterministic pkh (a valid digest) so listing +
    // lock-root math work without the window.nockchain bridge (deferred).
    let connect_nock = move |_| match swap_core::hash_public_key(&[0u8; 97]) {
        Ok(pkh) => s.nock.set(Some(NockSession {
            pkh,
            address: None,
        })),
        Err(e) => s.set_err(e.to_string()),
    };

    view! {
        <div class="wallet-bar">
            <span class="brand">"⚛ atomic-nock"</span>
            <span class="spacer"></span>
            {move || match s.nock.get() {
                Some(n) => view! { <span class="pill">"Iris " {short(&n.pkh)}</span> }.into_any(),
                None => view! { <button type="button" on:click=connect_nock>"Connect Iris (dev)"</button> }.into_any(),
            }}
            {move || match s.evm.get() {
                Some(a) => view! { <span class="pill">"Base " {trunc_addr(&a)}</span> }.into_any(),
                None => view! { <button type="button" on:click=connect_evm>"Connect MetaMask"</button> }.into_any(),
            }}
        </div>
    }
}

#[component]
fn LogBox() -> impl IntoView {
    let s = session();
    view! {
        <div class=move || s.log.get().class()>{move || s.log.get().msg}</div>
    }
}

#[component]
fn Dashboard() -> impl IntoView {
    let s = session();
    let nav = use_navigate();
    let swaps = RwSignal::new(Vec::<Swap>::new());
    let lookup = RwSignal::new(String::new());

    // (Re)load the connected wallet's swaps whenever the Iris session changes.
    Effect::new(move |_| {
        let nock = s.nock.get();
        let repo: Arc<DevRepo> = repo();
        spawn_local(async move {
            match nock {
                Some(n) => {
                    if let Ok(list) = repo.list_for_nock_pkh(&n.pkh).await {
                        swaps.set(list);
                    }
                }
                None => swaps.set(Vec::new()),
            }
        });
    });

    let nav_lookup = nav.clone();
    let do_lookup = move |_| {
        let id = lookup.get().trim().to_string();
        if id.is_empty() {
            s.set_err("Paste a swap id");
            return;
        }
        let nav = nav_lookup.clone();
        let repo: Arc<DevRepo> = repo();
        spawn_local(async move {
            match repo.get(&id).await {
                Ok(Some(swap)) => nav(&format!("/swap/{}", swap.h_evm), NavigateOptions::default()),
                Ok(None) => s.set_err("No swap found for that id"),
                Err(e) => s.set_err(e.to_string()),
            }
        });
    };
    let nav_new = nav.clone();

    view! {
        <section class="panel">
            <h2 class="flow-title">"Your swaps"</h2>
            <LogBox/>
            <div class="swaps-box">
                {move || {
                    let s = session();
                    let conn = conn_of(&s);
                    let list = swaps.get();
                    if s.nock.get().is_none() {
                        return view! { <p class="hint">"Connect Iris to see your swaps."</p> }.into_any();
                    }
                    if list.is_empty() {
                        return view! { <p class="hint">"No swaps yet for the connected wallet(s)."</p> }.into_any();
                    }
                    list.into_iter().map(|swap| {
                        let role = role_for_swap(&swap, &conn).unwrap_or(Role::Buyer);
                        let role_txt = if role == Role::Seller { "seller" } else { "buyer" };
                        let id = swap.h_evm.clone();
                        let nav = use_navigate();
                        let stage = stage_label(swap_status(&swap));
                        let amount = swap.usdc_amount.clone().unwrap_or_default();
                        view! {
                            <div class="swap-card" on:click=move |_| nav(&format!("/swap/{id}"), NavigateOptions::default())>
                                <div class="swap-card-head">
                                    <span class="pill">{role_txt}</span>
                                    <span class="pill">{stage}</span>
                                </div>
                                <div class="swap-card-body">
                                    <div>{format_nock(swap.nock_gift)} " ⇄ " {amount} " USDC"</div>
                                    <div class="muted">{short(&swap.h_evm)}</div>
                                </div>
                            </div>
                        }
                    }).collect_view().into_any()
                }}
            </div>

            <label for="swap-id">"Open a swap by ID"</label>
            <div class="lookup-row">
                <input id="swap-id" placeholder="Swap ID (0x…) from the seller"
                    prop:value=move || lookup.get()
                    on:input=move |ev| lookup.set(event_target_value(&ev)) />
                <button type="button" on:click=do_lookup>"Open swap"</button>
            </div>
            <div class="create-row">
                <button type="button" on:click=move |_| nav_new("/new", NavigateOptions::default())>
                    "Create new swap (sell NOCK)"
                </button>
            </div>
        </section>
    }
}

#[component]
fn NewSwap() -> impl IntoView {
    let s = session();
    let nav = use_navigate();
    let usdc = RwSignal::new("1.00".to_string());
    let nock = RwSignal::new("50".to_string());
    let busy = RwSignal::new(false);

    let create = move |_| {
        if busy.get() {
            return;
        }
        let Some(n) = s.nock.get() else {
            s.set_err("Connect Iris first");
            return;
        };
        let Some(nicks) = nock_to_nicks(&nock.get()) else {
            s.set_err("Enter a valid NOCK amount");
            return;
        };
        let usdc_amount = usdc.get().trim().to_string();
        let evm = s.evm.get();
        let nav = nav.clone();
        busy.set(true);
        spawn_local(async move {
            let (jam, hex) = match generate_preimage_jam() {
                Ok(v) => v,
                Err(e) => {
                    s.set_err(e);
                    busy.set(false);
                    return;
                }
            };
            let h_nock = swap_core::hash_preimage(&jam).unwrap();
            let h_evm = keccak256_hex(&jam);
            local_set(&format!("seller:{h_evm}"), &hex); // keep the secret client-side
            let swap = Swap {
                h_nock,
                h_evm: h_evm.clone(),
                seller_pkh: n.pkh,
                buyer_pkh: String::new(), // open swap
                seller_eth: evm,
                usdc_amount: Some(usdc_amount),
                nock_gift: nicks,
                nock_refund_height: 1000, // placeholder until lock-time (needs node height)
                usdc_timelock: now_secs() + 12 * 3600,
                ..Default::default()
            };
            let repo: Arc<DevRepo> = repo();
            match repo.create(&swap).await {
                Ok(()) => {
                    s.set_log("Swap created. Share its id with a buyer.", true);
                    nav(&format!("/swap/{h_evm}"), NavigateOptions::default());
                }
                Err(e) => s.set_err(e.to_string()),
            }
            busy.set(false);
        });
    };
    let nav_back = use_navigate();

    view! {
        <div class="role-flow">
            <button type="button" class="role-back" on:click=move |_| nav_back("/", NavigateOptions::default())>"← Dashboard"</button>
            <section class="panel">
                <h2 class="flow-title">"Sell NOCK for USDC"</h2>
                <LogBox/>
                <label for="nock">"NOCK to sell"</label>
                <input id="nock" prop:value=move || nock.get() on:input=move |ev| nock.set(event_target_value(&ev)) />
                <label for="usdc">"USDC to receive"</label>
                <input id="usdc" prop:value=move || usdc.get() on:input=move |ev| usdc.set(event_target_value(&ev)) />
                <div class="create-row">
                    <button type="button" class=move || if busy.get() { "busy" } else { "" } on:click=create>
                        "Generate & post swap"
                    </button>
                </div>
                <p class="hint">"This generates the preimage locally, computes the hashlocks, and posts an open swap. Locking NOCK on-chain is the next step (needs the Iris wallet bridge)."</p>
            </section>
        </div>
    }
}

#[component]
fn SwapView() -> impl IntoView {
    let s = session();
    let params = use_params_map();
    // None = loading, Some(None) = not found, Some(Some) = loaded
    let state = RwSignal::new(None::<Option<Swap>>);

    Effect::new(move |_| {
        let id = params.read().get("id").unwrap_or_default();
        let repo: Arc<DevRepo> = repo();
        state.set(None);
        spawn_local(async move {
            state.set(Some(repo.get(&id).await.ok().flatten()));
        });
    });

    let nav_back = use_navigate();
    view! {
        <div class="role-flow">
            <button type="button" class="role-back" on:click=move |_| nav_back("/", NavigateOptions::default())>"← Dashboard"</button>
            {move || match state.get() {
                None => view! { <p class="hint">"Loading swap…"</p> }.into_any(),
                Some(None) => view! { <p class="hint">"Swap not found."</p> }.into_any(),
                Some(Some(swap)) => {
                    let conn = conn_of(&s);
                    let role = role_for_swap(&swap, &conn).unwrap_or(Role::Buyer);
                    view! { <SwapDetail swap=swap role=role/> }.into_any()
                }
            }}
        </div>
    }
}

#[component]
fn SwapDetail(swap: Swap, role: Role) -> impl IntoView {
    let role_txt = if role == Role::Seller { "Seller" } else { "Buyer" };
    let stage = stage_label(swap_status(&swap));
    let amount = swap.usdc_amount.clone().unwrap_or_default();
    // Once a buyer is committed, the lock root + gift name are computable.
    let lock_info = if !swap.buyer_pkh.is_empty() {
        match (
            htlc_lock_root(
                &swap.h_nock,
                &swap.buyer_pkh,
                &swap.seller_pkh,
                swap.nock_refund_height as u32,
            ),
            htlc_gift_first_name(
                &swap.h_nock,
                &swap.buyer_pkh,
                &swap.seller_pkh,
                swap.nock_refund_height as u32,
            ),
        ) {
            (Ok(lr), Ok(gn)) => Some((lr.to_string(), gn.to_string())),
            _ => None,
        }
    } else {
        None
    };

    view! {
        <section class="panel">
            <h2 class="flow-title">{role_txt} " view · " {stage}</h2>
            <LogBox/>
            <div class="swap-detail">
                <Row label="Amount" value=format!("{} ⇄ {} USDC", format_nock(swap.nock_gift), amount)/>
                <Row label="Swap id (hEvm)" value=swap.h_evm.clone()/>
                <Row label="hNock" value=swap.h_nock.clone()/>
                <Row label="Seller pkh" value=short(&swap.seller_pkh)/>
                <Row label="Buyer pkh" value={if swap.buyer_pkh.is_empty() { "— (open)".to_string() } else { short(&swap.buyer_pkh) }}/>
                {move || lock_info.clone().map(|(lr, gn)| view! {
                    <Row label="HTLC lock root" value=short(&lr)/>
                    <Row label="Gift first name" value=short(&gn)/>
                })}
            </div>
            <p class="hint">"On-chain steps (lock NOCK / lock USDC / withdraw / claim) require the wallet + node bridges and are wired as those land. The swap state, hashlocks, and (once claimed) the HTLC lock root + gift name above are all computed by the Rust crates."</p>
        </section>
    }
}

#[component]
fn Row(label: &'static str, value: String) -> impl IntoView {
    view! {
        <div class="detail-row">
            <span class="detail-label">{label}</span>
            <span class="detail-value">{value}</span>
        </div>
    }
}

// keep an explicit reference so the constant isn't flagged unused in some builds
#[allow(dead_code)]
const _NICKS: f64 = NICKS_PER_NOCK;
