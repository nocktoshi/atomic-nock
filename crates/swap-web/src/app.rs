//! App shell + the marketplace/swap UI, aligned to the upstream "intents" design
//! (Marketplace front page with a Uniswap-style SwapBox + an order book). Port of
//! `src/ui/{App,WalletBar,Marketplace,SwapBox,TokenIcon}.tsx`. The sell-NOCK order
//! entry runs fully in-browser against the dev repo; on-chain fill steps need the
//! wallet/node bridges (gated).

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
use crate::util::{format_nock, nock_to_nicks, short, trunc_addr};

const PRICE_URL: &str =
    "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&symbols=nock";

// --- helpers ---

fn local_set(key: &str, value: &str) {
    if let Some(Ok(Some(s))) = web_sys::window().map(|w| w.local_storage()) {
        let _ = s.set_item(key, value);
    }
}
fn now_secs() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}
fn nav_to(path: &str) {
    use_navigate()(path, NavigateOptions::default());
}
fn conn_of(s: &SessionCtx) -> WalletConnection {
    WalletConnection {
        eth: s.evm.get(),
        nock: s.nock.get().map(|n| NockConn {
            pkh: n.pkh,
            address: n.address,
        }),
    }
}
fn stage_label(stage: SwapStage) -> &'static str {
    match stage {
        SwapStage::Created => "open",
        SwapStage::NockLocked => "NOCK locked",
        SwapStage::UsdcLocked => "USDC locked",
        SwapStage::Withdrawn => "USDC withdrawn",
        SwapStage::Claimed => "claimed",
        SwapStage::Refunded => "refunded",
    }
}

/// NOCK = the round token mark; USDC = the Circle coin + Base badge (port of TokenIcon).
/// The CSS sizes the inner svg/img to 100%, so the span itself must carry the size
/// (the React component passed it inline as `size=20`).
#[component]
fn TokenIcon(token: &'static str) -> impl IntoView {
    view! {
        <span class="token-icon" style="width:20px;height:20px">
            {if token == "USDC" {
                view! {
                    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <circle cx="16" cy="16" r="16" fill="#2775CA"></circle>
                        <path fill="#FFF" d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 0 0 .427.303h.975a.416.416 0 0 0 .427-.425v-.06a3.04 3.04 0 0 0-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 0 0-.427.425v.06c.244 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z"></path>
                        <path fill="#FFF" d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 0 0-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 0 0 7.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z"></path>
                    </svg>
                    <span class="token-icon-badge">
                        <svg viewBox="0 0 1244.64 1244.64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path fill="#0000FF" d="M0,101.12c0-34.64,0-51.95,6.53-65.28C12.78,23.08,23.09,12.77,35.85,6.52,49.17,0,66.48,0,101.12,0h1042.4c34.64,0,51.95,0,65.28,6.52,12.76,6.25,23.07,16.56,29.32,29.32,6.52,13.33,6.52,30.64,6.52,65.28v1042.4c0,34.64,0,51.95-6.52,65.28-6.25,12.76-16.56,23.07-29.32,29.32-13.33,6.52-30.64,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.25-23.07-16.56-29.32-29.32C0,1195.47,0,1178.16,0,1143.52V101.12Z"></path>
                        </svg>
                    </span>
                }.into_any()
            } else {
                view! { <img src="/assets/nock-token.png" alt="" width="20" height="20"/> }.into_any()
            }}
        </span>
    }
}

// --- root ---

#[component]
pub fn App() -> impl IntoView {
    provide_session("Buy or sell native NOCK — post an order above or fill one below.");
    let s = session();
    spawn_local(async move {
        if let Some(p) = swap_client::price::fetch_nock_usd(PRICE_URL).await {
            s.price.set(Some(p));
        }
    });
    view! {
        <main id="app">
            <Router>
                <div class="wallet-bar-wrap"><WalletBar/></div>
                <Routes fallback=Marketplace>
                    <Route path=path!("/") view=Marketplace/>
                    <Route path=path!("/market") view=Marketplace/>
                    <Route path=path!("/dashboard") view=DashboardRoute/>
                    <Route path=path!("/swap/:id") view=SwapView/>
                </Routes>
            </Router>
        </main>
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
    let connect_nock = move |_| match swap_core::hash_public_key(&[0u8; 97]) {
        Ok(pkh) => s.nock.set(Some(NockSession { pkh, address: None })),
        Err(e) => s.set_err(e.to_string()),
    };

    view! {
        <button type="button" class="wallet-connect-btn" on:click=connect_nock>
            <span class="wallet-btn-icon">"☢"</span>
            <span class="wallet-btn-label">
                {move || s.nock.get().map(|n| short(&n.pkh)).unwrap_or_else(|| "Nockchain".into())}
            </span>
        </button>
        <button type="button" class="wallet-connect-btn" on:click=connect_evm>
            <span class="wallet-btn-icon">"◆"</span>
            <span class="wallet-btn-label">
                {move || s.evm.get().map(|a| trunc_addr(&a)).unwrap_or_else(|| "Base".into())}
            </span>
        </button>
        <div class="price-banner">
            {move || match s.price.get() {
                Some(p) => format!("$NOCK ≈ ${:.4} USD", p),
                None => "$NOCK ≈ — USD".to_string(),
            }}
        </div>
        <button type="button" class="my-swaps-pill" on:click=move |_| nav_to("/dashboard")>"My Swaps"</button>
    }
}

#[component]
fn LogBox() -> impl IntoView {
    let s = session();
    view! { <div class=move || s.log.get().class()>{move || s.log.get().msg}</div> }
}

// --- swap box (order entry) ---

#[component]
fn SwapBox() -> impl IntoView {
    let s = session();
    let sell_is_nock = RwSignal::new(true);
    let nock_amount = RwSignal::new(String::new());
    let quote_amount = RwSignal::new(String::new());
    let busy = RwSignal::new(false);

    let panel = move |is_sell: bool| {
        let nock_side = move || is_sell == sell_is_nock.get();
        let label = move || match (is_sell, nock_side()) {
            (true, true) => "You sell",
            (true, false) => "You pay",
            (false, true) => "You buy",
            (false, false) => "You receive",
        };
        view! {
            <div class="swap-panel">
                <span class="swap-panel-label">{label}</span>
                <div class="swap-panel-row">
                    <input class="swap-amount" type="number" min="0" placeholder="0"
                        prop:value=move || if nock_side() { nock_amount.get() } else { quote_amount.get() }
                        on:input=move |ev| {
                            let v = event_target_value(&ev);
                            if nock_side() { nock_amount.set(v) } else { quote_amount.set(v) }
                        } />
                    <button type="button" class="swap-token token-btn" on:click=move |_| sell_is_nock.update(|b| *b = !*b)>
                        {move || if nock_side() {
                            view! { <TokenIcon token="NOCK"/> "NOCK" }.into_any()
                        } else {
                            view! { <TokenIcon token="USDC"/> "USDC" }.into_any()
                        }}
                        <span class="token-chevron">"▾"</span>
                    </button>
                </div>
            </div>
        }
    };

    let rate = move || {
        let n: f64 = nock_amount.get().trim().parse().unwrap_or(0.0);
        let q: f64 = quote_amount.get().trim().parse().unwrap_or(0.0);
        if n > 0.0 && q > 0.0 {
            format!("≈ ${:.4} per NOCK", q / n)
        } else {
            String::new()
        }
    };
    let market_hint =
        move || s.price.get().map(|p| format!("market ≈ ${:.4}", p)).unwrap_or_default();
    let ready = move || s.nock.get().is_some() && s.evm.get().is_some();
    let action_label =
        move || if sell_is_nock.get() { "Sell NOCK for USDC" } else { "Buy NOCK with USDC" };

    let submit = move |_| {
        if busy.get() {
            return;
        }
        if !sell_is_nock.get() {
            s.set_err("Buy orders (bids) need the upstream intents API — sell NOCK to post here.");
            return;
        }
        let Some(n) = s.nock.get() else {
            s.set_err("Connect Iris (Nockchain wallet).");
            return;
        };
        let Some(evm) = s.evm.get() else {
            s.set_err("Connect a Base wallet.");
            return;
        };
        let Some(nicks) = nock_to_nicks(&nock_amount.get()) else {
            s.set_err("Enter a NOCK amount.");
            return;
        };
        if (nicks as f64) / 65536.0 < 50.0 {
            s.set_err("Minimum NOCK amount is 50 NOCK.");
            return;
        }
        let usdc = quote_amount.get().trim().to_string();
        if usdc.parse::<f64>().unwrap_or(0.0) < 0.10 {
            s.set_err("Minimum USDC amount is $0.10.");
            return;
        }
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
            let h_evm = keccak256_hex(&jam);
            let swap = Swap {
                h_nock: swap_core::hash_preimage(&jam).unwrap(),
                h_evm: h_evm.clone(),
                seller_pkh: n.pkh,
                buyer_pkh: String::new(),
                seller_eth: Some(evm),
                usdc_amount: Some(usdc),
                nock_gift: nicks,
                nock_refund_height: 1000,
                usdc_timelock: now_secs() + 12 * 3600,
                ..Default::default()
            };
            local_set(&format!("seller:{h_evm}"), &hex);
            let repo: Arc<DevRepo> = repo();
            match repo.create(&swap).await {
                Ok(()) => {
                    s.set_log("Sell order posted — it's live on the marketplace.", true);
                    nav_to(&format!("/swap/{h_evm}"));
                }
                Err(e) => s.set_err(e.to_string()),
            }
            busy.set(false);
        });
    };

    view! {
        <div class="swap-interface swap-box">
            {panel(true)}
            <button type="button" class="swap-flip" aria-label="Flip direction" title="Flip direction"
                on:click=move |_| sell_is_nock.update(|b| *b = !*b)>"⇅"</button>
            {panel(false)}
            <span class="addr-resolve-hint swap-rate">
                {move || {
                    let r = rate();
                    let m = market_hint();
                    if !r.is_empty() && !m.is_empty() { format!("{r}  ·  {m}") } else { format!("{r}{m}") }
                }}
            </span>
            <button type="button"
                class=move || if busy.get() { "swap-submit busy" } else { "swap-submit" }
                disabled=move || busy.get() || !ready()
                on:click=submit>
                {move || if busy.get() { "Posting…".to_string() } else { action_label().to_string() }}
            </button>
            {move || (!ready()).then(|| view! {
                <span class="addr-resolve-hint">"Connect both wallets (Base + Nockchain) to place an order."</span>
            })}
        </div>
    }
}

// --- marketplace (front page) ---

#[component]
fn Marketplace() -> impl IntoView {
    let s = session();
    let orders = RwSignal::new(Vec::<Swap>::new());
    let side = RwSignal::new("all".to_string());

    Effect::new(move |_| {
        s.log.track(); // re-list after a post (post→navigate→back) + on mount
        let repo: Arc<DevRepo> = repo();
        spawn_local(async move {
            if let Ok(list) = repo.list_open().await {
                orders.set(list);
            }
        });
    });

    let tab = move |value: &'static str, label: &'static str| {
        view! {
            <button type="button" role="tab" aria-selected=move || side.get() == value
                class=move || if side.get() == value { "market-tab active" } else { "market-tab" }
                on:click=move |_| side.set(value.to_string())>{label}</button>
        }
    };

    view! {
        <section class="panel">
            <h2 class="flow-title">"Swap NOCK"</h2>
            <SwapBox/>
            <LogBox/>
            <div class="market-controls">
                <div class="market-tabs" role="tablist" aria-label="Order side">
                    {tab("all", "All orders")}
                    {tab("buy", "Buy NOCK")}
                    {tab("sell", "Sell NOCK")}
                </div>
                <div class="market-filters">
                    <select aria-label="Token filter"><option>"All tokens"</option><option>"USDC"</option></select>
                    <select aria-label="Sort orders"><option>"Newest"</option><option>"Price"</option></select>
                </div>
            </div>
            <div class="swaps-box">
                {move || {
                    // Dev repo only holds asks (open swaps); "sell" side has none here.
                    let list: Vec<Swap> = if side.get() == "sell" { Vec::new() } else { orders.get() };
                    if list.is_empty() {
                        view! { <p class="hint">"No open orders match. Post one above — it lists here automatically."</p> }.into_any()
                    } else {
                        list.into_iter().map(market_card).collect_view().into_any()
                    }
                }}
            </div>
        </section>
    }
}

fn market_card(swap: Swap) -> impl IntoView {
    let id = swap.h_evm.clone();
    let amount = swap.usdc_amount.clone().unwrap_or_default();
    let title = format!("{} for {} USDC", format_nock(swap.nock_gift), amount);
    let stage = stage_label(swap_status(&swap));
    view! {
        <div class="swap-card overview">
            <div class="swap-card-title">
                <span>{title}</span>
                <div class="swap-card-title-badges">
                    <span class="swap-badge market-side ask">"Buy NOCK"</span>
                    <span class="swap-badge">"USDC"</span>
                    <span class="swap-badge">{stage}</span>
                </div>
            </div>
            <div class="swap-card-row"><span class="k">"Seller"</span><span class="v">{short(&swap.seller_pkh)}</span></div>
            <div class="swap-card-row"><span class="k">"Order id"</span><span class="v">{short(&swap.h_evm)}</span></div>
            <div class="card-actions">
                <button type="button" on:click=move |_| nav_to(&format!("/swap/{id}"))>"Buy NOCK"</button>
            </div>
        </div>
    }
}

// --- dashboard (my swaps) ---

#[component]
fn DashboardRoute() -> impl IntoView {
    view! {
        <div class="role-flow">
            <button type="button" class="role-back" on:click=move |_| nav_to("/")>"← Market"</button>
            <Dashboard/>
        </div>
    }
}

#[component]
fn Dashboard() -> impl IntoView {
    let s = session();
    let swaps = RwSignal::new(Vec::<Swap>::new());
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
    view! {
        <section class="panel">
            <h2 class="flow-title">"Your swaps"</h2>
            <LogBox/>
            <div class="swaps-box">
                {move || {
                    if s.nock.get().is_none() {
                        return view! { <p class="hint">"Connect Iris to see your swaps."</p> }.into_any();
                    }
                    let list = swaps.get();
                    if list.is_empty() {
                        return view! { <p class="hint">"No swaps yet for the connected wallet(s)."</p> }.into_any();
                    }
                    list.into_iter().map(market_card).collect_view().into_any()
                }}
            </div>
        </section>
    }
}

// --- swap detail ---

#[component]
fn SwapView() -> impl IntoView {
    let s = session();
    let params = use_params_map();
    let state = RwSignal::new(None::<Option<Swap>>);
    Effect::new(move |_| {
        let id = params.read().get("id").unwrap_or_default();
        let repo: Arc<DevRepo> = repo();
        state.set(None);
        spawn_local(async move {
            state.set(Some(repo.get(&id).await.ok().flatten()));
        });
    });
    view! {
        <div class="role-flow">
            <button type="button" class="role-back" on:click=move |_| nav_to("/")>"← Market"</button>
            {move || match state.get() {
                None => view! { <p class="hint">"Loading order…"</p> }.into_any(),
                Some(None) => view! { <p class="hint">"Order not found."</p> }.into_any(),
                Some(Some(swap)) => {
                    let role = role_for_swap(&swap, &conn_of(&s)).unwrap_or(Role::Buyer);
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
    let lock_info = (!swap.buyer_pkh.is_empty())
        .then(|| {
            match (
                htlc_lock_root(&swap.h_nock, &swap.buyer_pkh, &swap.seller_pkh, swap.nock_refund_height as u32),
                htlc_gift_first_name(&swap.h_nock, &swap.buyer_pkh, &swap.seller_pkh, swap.nock_refund_height as u32),
            ) {
                (Ok(lr), Ok(gn)) => Some((lr.to_string(), gn.to_string())),
                _ => None,
            }
        })
        .flatten();

    view! {
        <section class="panel">
            <h2 class="flow-title">{role_txt}" view · "{stage}</h2>
            <LogBox/>
            <div class="swap-detail">
                <Row label="Amount" value=format!("{} for {} USDC", format_nock(swap.nock_gift), amount)/>
                <Row label="Order id (hEvm)" value=swap.h_evm.clone()/>
                <Row label="hNock" value=swap.h_nock.clone()/>
                <Row label="Seller pkh" value=short(&swap.seller_pkh)/>
                <Row label="Buyer pkh" value={if swap.buyer_pkh.is_empty() { "— (open)".into() } else { short(&swap.buyer_pkh) }}/>
                {lock_info.map(|(lr, gn)| view! {
                    <Row label="HTLC lock root" value=short(&lr)/>
                    <Row label="Gift first name" value=short(&gn)/>
                })}
            </div>
            <p class="hint">"On-chain steps (lock NOCK / lock USDC / withdraw / claim) require the wallet + node bridges and are wired as those land."</p>
        </section>
    }
}

#[component]
fn Row(label: &'static str, value: String) -> impl IntoView {
    view! { <div class="swap-card-row"><span class="k">{label}</span><span class="v">{value}</span></div> }
}
