//! Role detection + wallet verification + stage/refund derivation from a swap's
//! persisted participant data. Port of `src/app/roles.ts`.

use crate::swap::Swap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Seller,
    Buyer,
}

/// A connected Iris (Nockchain) session: a pkh and an optional display address.
#[derive(Debug, Clone, Default)]
pub struct NockConn {
    pub pkh: String,
    pub address: Option<String>,
}

/// Connected wallets used to identify swap participants.
#[derive(Debug, Clone, Default)]
pub struct WalletConnection {
    pub eth: Option<String>,
    pub nock: Option<NockConn>,
}

fn is_present(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|v| !v.is_empty())
}

fn unique_nonempty(values: &[Option<&str>]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in values.iter().flatten() {
        let t = raw.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// Iris session keys that may match swap `sellerPkh` / `buyerPkh`.
pub fn nock_wallet_keys(nock: Option<&NockConn>) -> Vec<String> {
    match nock {
        None => Vec::new(),
        Some(n) => unique_nonempty(&[Some(n.pkh.as_str()), n.address.as_deref()]),
    }
}

struct NockFlags {
    is_seller: bool,
    is_buyer: bool,
    ok: bool,
}

fn nock_party_flags(swap: &Swap, nock: Option<&NockConn>) -> NockFlags {
    let keys = nock_wallet_keys(nock);
    NockFlags {
        is_seller: keys.contains(&swap.seller_pkh),
        is_buyer: keys.contains(&swap.buyer_pkh),
        ok: keys
            .iter()
            .any(|k| *k == swap.seller_pkh || *k == swap.buyer_pkh),
    }
}

struct EvmFlags {
    is_seller: bool,
    is_buyer: bool,
    seller_eth: Option<String>,
    buyer_eth: Option<String>,
    eth: Option<String>,
}

fn evm_party_flags(swap: &Swap, eth: Option<&str>) -> EvmFlags {
    // JS `eth?.toLowerCase()` then truthiness: empty == falsy/absent.
    let e = eth
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    let seller_eth = swap
        .seller_eth
        .as_deref()
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    let buyer_eth = swap
        .buyer_eth
        .as_deref()
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    let is_seller = matches!((&e, &seller_eth), (Some(a), Some(b)) if a == b);
    let is_buyer = matches!((&e, &buyer_eth), (Some(a), Some(b)) if a == b);
    EvmFlags {
        is_seller,
        is_buyer,
        seller_eth,
        buyer_eth,
        eth: e,
    }
}

/// True for the "buyer connected a fresh Base wallet (not yet recorded), and it
/// isn't the seller's" case — lets a buyer be recognized before locking USDC.
fn fresh_buyer_evm(evm: &EvmFlags) -> bool {
    evm.buyer_eth.is_none()
        && evm.eth.is_some()
        && evm.seller_eth.is_some()
        && evm.eth != evm.seller_eth
}

/// Determine the connected user's role in a swap from persisted participant data.
pub fn role_for_swap(swap: &Swap, conn: &WalletConnection) -> Option<Role> {
    let nock = nock_party_flags(swap, conn.nock.as_ref());
    let evm = evm_party_flags(swap, conn.eth.as_deref());

    if nock.is_seller && evm.is_seller {
        return Some(Role::Seller);
    }
    if nock.is_buyer && (evm.is_buyer || fresh_buyer_evm(&evm)) {
        return Some(Role::Buyer);
    }
    // Single-chain match (dashboard list before both wallets are connected).
    if evm.is_seller {
        return Some(Role::Seller);
    }
    if evm.is_buyer {
        return Some(Role::Buyer);
    }
    if nock.is_seller {
        return Some(Role::Seller);
    }
    if nock.is_buyer {
        return Some(Role::Buyer);
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapWalletVerification {
    pub ok: bool,
    pub role: Option<Role>,
    pub nock_ok: bool,
    pub evm_ok: bool,
    pub issues: Vec<String>,
}

/// For an existing swap, require Iris and Base to belong to the same party.
/// Buyer Base may differ from `buyerEth` until they lock USDC.
pub fn verify_swap_wallets(swap: &Swap, conn: &WalletConnection) -> SwapWalletVerification {
    if swap.h_evm.is_empty() {
        return SwapWalletVerification {
            ok: true,
            role: None,
            nock_ok: conn.nock.is_some(),
            evm_ok: conn.eth.is_some(),
            issues: Vec::new(),
        };
    }

    let nock = nock_party_flags(swap, conn.nock.as_ref());
    let evm = evm_party_flags(swap, conn.eth.as_deref());
    let evm_ok = evm.is_seller || evm.is_buyer || (nock.is_buyer && fresh_buyer_evm(&evm));

    let role = if nock.is_seller && evm.is_seller {
        Some(Role::Seller)
    } else if nock.is_buyer && (evm.is_buyer || fresh_buyer_evm(&evm)) {
        Some(Role::Buyer)
    } else {
        None
    };

    let mut issues = Vec::new();
    if conn.nock.is_none() {
        issues.push("Connect Iris (Nockchain wallet).".to_string());
    } else if !nock.ok {
        issues.push("Connected Iris wallet is not the buyer or seller for this swap.".to_string());
    }
    if conn.eth.is_none() {
        issues.push("Connect MetaMask (Base).".to_string());
    } else if !evm_ok {
        issues.push("Connected Base wallet is not the buyer or seller for this swap.".to_string());
    }
    if nock.ok && evm_ok && role.is_none() {
        issues.push(
            "Iris and MetaMask must be the same party — connect both wallets as the buyer or both as the seller."
                .to_string(),
        );
    }

    SwapWalletVerification {
        ok: nock.ok && evm_ok && role.is_some(),
        role,
        nock_ok: nock.ok,
        evm_ok,
        issues,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapStage {
    Created,
    NockLocked,
    UsdcLocked,
    Withdrawn,
    Claimed,
    Refunded,
}

/// Most-advanced stage derivable from persisted fields.
pub fn swap_status(swap: &Swap) -> SwapStage {
    if is_present(&swap.usdc_refund_tx_hash) || is_present(&swap.nock_refund_tx_id) {
        return SwapStage::Refunded;
    }
    if is_present(&swap.nock_claim_tx_id) {
        return SwapStage::Claimed;
    }
    if is_present(&swap.usdc_withdraw_tx_hash) {
        return SwapStage::Withdrawn;
    }
    if is_present(&swap.usdc_lock_tx_hash) {
        return SwapStage::UsdcLocked;
    }
    if is_present(&swap.lock_first_name) || is_present(&swap.nock_lock_tx_id) {
        return SwapStage::NockLocked;
    }
    SwapStage::Created
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnchainLock {
    pub amount: u128,
    pub withdrawn: bool,
    pub refunded: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RefundContext {
    pub now_sec: i64,
    pub nock_height: Option<i64>,
    pub onchain_lock: Option<OnchainLock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefundInfo {
    /// Buyer can reclaim USDC on Base (timelock elapsed, still locked).
    pub eth: bool,
    /// Seller can reclaim NOCK (refund height reached, not yet claimed).
    pub nock: bool,
}

pub fn refund_availability(swap: &Swap, ctx: &RefundContext) -> RefundInfo {
    let eth_ready = is_present(&swap.usdc_lock_tx_hash)
        && !is_present(&swap.usdc_withdraw_tx_hash)
        && !is_present(&swap.usdc_refund_tx_hash)
        && ctx.now_sec >= swap.usdc_timelock as i64
        && match &ctx.onchain_lock {
            None => true,
            Some(l) => l.amount > 0 && !l.withdrawn && !l.refunded,
        };

    let nock_ready = is_present(&swap.lock_first_name)
        && !is_present(&swap.nock_claim_tx_id)
        && !is_present(&swap.nock_refund_tx_id)
        && ctx
            .nock_height
            .is_some_and(|h| h >= swap.nock_refund_height as i64);

    RefundInfo {
        eth: eth_ready,
        nock: nock_ready,
    }
}
