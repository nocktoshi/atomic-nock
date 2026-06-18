//! Port of `src/app/roles.test.ts`.

use swap_core::roles::{
    refund_availability, role_for_swap, swap_status, verify_swap_wallets, NockConn, OnchainLock,
    RefundContext, Role, SwapStage, WalletConnection,
};
use swap_core::swap::Swap;

fn make_swap() -> Swap {
    Swap {
        h_nock: "HNOCK".into(),
        h_evm: "0xevm".into(),
        seller_pkh: "SELLER_PKH".into(),
        buyer_pkh: "BUYER_PKH".into(),
        seller_eth: Some("0xSeller".into()),
        buyer_eth: Some("0xBuyer".into()),
        usdc_amount: Some("1.0".into()),
        nock_refund_height: 1000,
        usdc_timelock: 5000,
        nock_gift: 65536,
        ..Default::default()
    }
}

fn seller_conn() -> WalletConnection {
    WalletConnection {
        eth: Some("0xSeller".into()),
        nock: Some(NockConn {
            pkh: "SELLER_PKH".into(),
            address: Some("SELLER_ADDR".into()),
        }),
    }
}

fn buyer_conn() -> WalletConnection {
    WalletConnection {
        eth: Some("0xBuyer".into()),
        nock: Some(NockConn {
            pkh: "BUYER_PKH".into(),
            address: None,
        }),
    }
}

fn nock_only(pkh: &str) -> WalletConnection {
    WalletConnection {
        eth: None,
        nock: Some(NockConn {
            pkh: pkh.into(),
            address: None,
        }),
    }
}

fn eth_only(eth: &str) -> WalletConnection {
    WalletConnection {
        eth: Some(eth.into()),
        nock: None,
    }
}

// --- roleForSwap ---

#[test]
fn detects_seller_buyer_when_both_chains_match() {
    assert_eq!(role_for_swap(&make_swap(), &seller_conn()), Some(Role::Seller));
    assert_eq!(role_for_swap(&make_swap(), &buyer_conn()), Some(Role::Buyer));
}

#[test]
fn detects_seller_by_nock_address() {
    let mut swap = make_swap();
    swap.seller_pkh = "SELLER_ADDR".into();
    let conn = WalletConnection {
        eth: Some("0xSeller".into()),
        nock: Some(NockConn {
            pkh: "IRIS_PKH".into(),
            address: Some("SELLER_ADDR".into()),
        }),
    };
    assert_eq!(role_for_swap(&swap, &conn), Some(Role::Seller));
}

#[test]
fn detects_by_single_chain_for_dashboard_hints() {
    assert_eq!(role_for_swap(&make_swap(), &eth_only("0xSELLER")), Some(Role::Seller));
    assert_eq!(role_for_swap(&make_swap(), &nock_only("BUYER_PKH")), Some(Role::Buyer));
}

#[test]
fn returns_none_when_no_match() {
    let conn = WalletConnection {
        eth: Some("0xother".into()),
        nock: Some(NockConn {
            pkh: "OTHER".into(),
            address: None,
        }),
    };
    assert_eq!(role_for_swap(&make_swap(), &conn), None);
}

// --- verifySwapWallets ---

#[test]
fn accepts_matching_seller_wallets() {
    let v = verify_swap_wallets(&make_swap(), &seller_conn());
    assert!(v.ok);
    assert_eq!(v.role, Some(Role::Seller));
}

#[test]
fn accepts_matching_buyer_wallets() {
    let v = verify_swap_wallets(&make_swap(), &buyer_conn());
    assert!(v.ok);
    assert_eq!(v.role, Some(Role::Buyer));
}

#[test]
fn allows_buyer_base_before_usdc_lock_when_iris_matches_buyer() {
    let mut swap = make_swap();
    swap.buyer_eth = None;
    let conn = WalletConnection {
        eth: Some("0xFreshBuyer".into()),
        nock: Some(NockConn {
            pkh: "BUYER_PKH".into(),
            address: None,
        }),
    };
    let v = verify_swap_wallets(&swap, &conn);
    assert!(v.ok);
    assert_eq!(v.role, Some(Role::Buyer));
}

#[test]
fn rejects_mismatched_iris_wallet() {
    let conn = WalletConnection {
        eth: Some("0xBuyer".into()),
        nock: Some(NockConn {
            pkh: "WRONG".into(),
            address: None,
        }),
    };
    let v = verify_swap_wallets(&make_swap(), &conn);
    assert!(!v.ok);
    assert!(!v.nock_ok);
}

#[test]
fn rejects_cross_party_wallets() {
    let conn = WalletConnection {
        eth: Some("0xSeller".into()),
        nock: Some(NockConn {
            pkh: "BUYER_PKH".into(),
            address: None,
        }),
    };
    let v = verify_swap_wallets(&make_swap(), &conn);
    assert!(!v.ok);
    assert_eq!(v.role, None);
}

#[test]
fn skips_participant_checks_for_draft_swaps() {
    let mut swap = make_swap();
    swap.h_evm = String::new();
    let conn = WalletConnection {
        eth: Some("0xanything".into()),
        nock: Some(NockConn {
            pkh: "ANY".into(),
            address: None,
        }),
    };
    let v = verify_swap_wallets(&swap, &conn);
    assert!(v.ok);
    assert_eq!(v.role, None);
}

// --- swapStatus ---

#[test]
fn derives_the_most_advanced_stage() {
    assert_eq!(swap_status(&make_swap()), SwapStage::Created);
    let mut s = make_swap();
    s.lock_first_name = Some("x".into());
    assert_eq!(swap_status(&s), SwapStage::NockLocked);
    let mut s = make_swap();
    s.usdc_lock_tx_hash = Some("0x1".into());
    assert_eq!(swap_status(&s), SwapStage::UsdcLocked);
    let mut s = make_swap();
    s.usdc_withdraw_tx_hash = Some("0x2".into());
    assert_eq!(swap_status(&s), SwapStage::Withdrawn);
    let mut s = make_swap();
    s.nock_claim_tx_id = Some("t".into());
    assert_eq!(swap_status(&s), SwapStage::Claimed);
    let mut s = make_swap();
    s.usdc_refund_tx_hash = Some("0x3".into());
    assert_eq!(swap_status(&s), SwapStage::Refunded);
}

// --- refundAvailability ---

fn locked() -> Swap {
    let mut s = make_swap();
    s.usdc_lock_tx_hash = Some("0x1".into());
    s.lock_first_name = Some("LF".into());
    s
}

#[test]
fn eth_refund_only_after_the_timelock() {
    assert!(!refund_availability(&locked(), &RefundContext { now_sec: 4999, ..Default::default() }).eth);
    assert!(refund_availability(&locked(), &RefundContext { now_sec: 5000, ..Default::default() }).eth);
}

#[test]
fn eth_refund_blocked_once_withdrawn() {
    let mut s = make_swap();
    s.usdc_lock_tx_hash = Some("0x1".into());
    s.usdc_withdraw_tx_hash = Some("0x9".into());
    assert!(!refund_availability(&s, &RefundContext { now_sec: 9999, ..Default::default() }).eth);
}

#[test]
fn eth_refund_respects_onchain_state() {
    let r = refund_availability(
        &locked(),
        &RefundContext {
            now_sec: 9999,
            nock_height: None,
            onchain_lock: Some(OnchainLock {
                amount: 0,
                withdrawn: false,
                refunded: false,
            }),
        },
    );
    assert!(!r.eth);
}

#[test]
fn nock_refund_only_at_or_after_refund_height() {
    assert!(!refund_availability(&locked(), &RefundContext { now_sec: 0, nock_height: Some(999), ..Default::default() }).nock);
    assert!(refund_availability(&locked(), &RefundContext { now_sec: 0, nock_height: Some(1000), ..Default::default() }).nock);
}

#[test]
fn nock_refund_blocked_once_claimed() {
    let mut s = make_swap();
    s.lock_first_name = Some("LF".into());
    s.nock_claim_tx_id = Some("t".into());
    assert!(!refund_availability(&s, &RefundContext { now_sec: 0, nock_height: Some(99999), ..Default::default() }).nock);
}
