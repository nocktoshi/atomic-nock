//! Port of `src/app/repo/swap-repo.test.ts`.

use pollster::block_on;
use swap_client::{MemoryKv, MemorySwapApi, SwapRepository};
use swap_core::swap::Swap;

fn make_repo() -> SwapRepository<MemorySwapApi<MemoryKv>> {
    SwapRepository::new(MemorySwapApi::new(MemoryKv::new()))
}

fn make_swap(h_evm: &str) -> Swap {
    Swap {
        h_nock: "HNOCK".into(),
        h_evm: h_evm.into(),
        seller_pkh: "SELLER_PKH".into(),
        buyer_pkh: "BUYER_PKH".into(),
        seller_eth: Some("0xSeLLeReth".into()),
        buyer_eth: Some("0xBuYeReth".into()),
        usdc_amount: Some("1.0".into()),
        nock_refund_height: 100,
        usdc_timelock: 200,
        nock_gift: 65536,
        ..Default::default()
    }
}

#[test]
fn stores_and_fetches_by_hevm_case_insensitive() {
    block_on(async {
        let repo = make_repo();
        repo.create(&make_swap("0xAbC123")).await.unwrap();
        let got = repo.get("0xabc123").await.unwrap().unwrap();
        assert_eq!(got.seller_pkh, "SELLER_PKH");
        assert_eq!(got.usdc_amount.as_deref(), Some("1.0"));
    });
}

#[test]
fn indexes_by_every_participant_nock_pkh() {
    block_on(async {
        let repo = make_repo();
        repo.create(&make_swap("0xAbC123")).await.unwrap();

        let seller: Vec<String> = repo
            .list_for_nock_pkh("SELLER_PKH")
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.h_evm)
            .collect();
        assert_eq!(seller, vec!["0xAbC123".to_string()]);
        assert_eq!(repo.list_for_nock_pkh("BUYER_PKH").await.unwrap().len(), 1);
        assert_eq!(repo.list_for_nock_pkh("NOBODY_PKH").await.unwrap().len(), 0);
    });
}

#[test]
fn keeps_multiple_swaps_separate() {
    block_on(async {
        let repo = make_repo();
        repo.create(&make_swap("0xaaa")).await.unwrap();
        repo.create(&make_swap("0xbbb")).await.unwrap();
        let mut list: Vec<String> = repo
            .list_for_nock_pkh("SELLER_PKH")
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.h_evm)
            .collect();
        list.sort();
        assert_eq!(list, vec!["0xaaa".to_string(), "0xbbb".to_string()]);
    });
}
