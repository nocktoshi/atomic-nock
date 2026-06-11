//! Pure calldata encoders + return/calldata decoders over the [`crate::abi`]
//! types. The browser layer (provider.rs) ships the calldata over EIP-1193;
//! these functions never touch the network, so they unit-test natively.

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;

use crate::abi::{IERC20, IHtlc};

/// `0x`-prefixed lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// keccak256 of `bytes` as a `0x` hex string (== viem `keccak256`). This is the
/// swap's `hEvm` over the preimage jam.
pub fn keccak256_hex(bytes: &[u8]) -> String {
    to_hex(keccak256(bytes).as_slice())
}

// --- calldata builders (hex strings for the EIP-1193 `data` field) ---

pub fn lock_calldata(seller: Address, amount: U256, hashlock: B256, timelock: U256) -> String {
    to_hex(
        &IHtlc::lockCall {
            seller,
            amount,
            hashlock,
            timelock,
        }
        .abi_encode(),
    )
}

pub fn withdraw_calldata(id: B256, preimage_jam: &[u8]) -> String {
    to_hex(
        &IHtlc::withdrawCall {
            id,
            preimageJam: Bytes::copy_from_slice(preimage_jam),
        }
        .abi_encode(),
    )
}

pub fn refund_calldata(id: B256) -> String {
    to_hex(&IHtlc::refundCall { id }.abi_encode())
}

pub fn swap_id_calldata(
    seller: Address,
    buyer: Address,
    amount: U256,
    hashlock: B256,
    timelock: U256,
) -> String {
    to_hex(
        &IHtlc::swapIdCall {
            seller,
            buyer,
            amount,
            hashlock,
            timelock,
        }
        .abi_encode(),
    )
}

pub fn fee_bps_calldata() -> String {
    to_hex(&IHtlc::feeBpsCall {}.abi_encode())
}

pub fn get_lock_calldata(id: B256) -> String {
    to_hex(&IHtlc::getLockCall { id }.abi_encode())
}

pub fn approve_calldata(spender: Address, amount: U256) -> String {
    to_hex(&IERC20::approveCall { spender, amount }.abi_encode())
}

pub fn decimals_calldata() -> String {
    to_hex(&IERC20::decimalsCall {}.abi_encode())
}

pub fn allowance_calldata(owner: Address, spender: Address) -> String {
    to_hex(&IERC20::allowanceCall { owner, spender }.abi_encode())
}

pub fn balance_of_calldata(account: Address) -> String {
    to_hex(&IERC20::balanceOfCall { account }.abi_encode())
}

// --- return decoders (over the bytes returned by eth_call) ---

pub fn decode_swap_id(ret: &[u8]) -> Option<B256> {
    IHtlc::swapIdCall::abi_decode_returns(ret).ok()
}

pub fn decode_fee_bps(ret: &[u8]) -> Option<u16> {
    IHtlc::feeBpsCall::abi_decode_returns(ret).ok()
}

pub fn decode_decimals(ret: &[u8]) -> Option<u8> {
    IERC20::decimalsCall::abi_decode_returns(ret).ok()
}

pub fn decode_u256(ret: &[u8]) -> Option<U256> {
    // allowance / balanceOf share the same single-uint256 return shape.
    IERC20::allowanceCall::abi_decode_returns(ret).ok()
}

/// A swap's on-chain lock state (the subset the app uses). Port of `OnchainLock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnchainLock {
    pub buyer: Address,
    pub seller: Address,
    pub amount: U256,
    pub withdrawn: bool,
    pub refunded: bool,
}

pub fn decode_get_lock(ret: &[u8]) -> Option<OnchainLock> {
    let r = IHtlc::getLockCall::abi_decode_returns(ret).ok()?;
    Some(OnchainLock {
        buyer: r.buyer,
        seller: r.seller,
        amount: r.amount,
        withdrawn: r.withdrawn,
        refunded: r.refunded,
    })
}

/// Decode the `preimageJam` argument out of a `withdraw(...)` transaction's
/// calldata (selector included). Port of `getPreimageFromWithdrawTx`'s decode.
pub fn decode_withdraw_preimage(calldata: &[u8]) -> Option<Vec<u8>> {
    IHtlc::withdrawCall::abi_decode(calldata)
        .ok()
        .map(|c| c.preimageJam.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolValue;

    #[test]
    fn keccak_matches_known_vector() {
        // keccak256("") well-known digest.
        assert_eq!(
            keccak256_hex(&[]),
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn withdraw_calldata_round_trips_preimage() {
        let id = B256::repeat_byte(0xab);
        let jam = vec![1u8, 2, 3, 4, 250, 0, 99];
        let data_hex = withdraw_calldata(id, &jam);
        let raw = hex::decode(data_hex.trim_start_matches("0x")).unwrap();
        assert_eq!(decode_withdraw_preimage(&raw), Some(jam));
    }

    #[test]
    fn calldata_carries_a_4byte_selector() {
        let cd = fee_bps_calldata();
        let raw = hex::decode(cd.trim_start_matches("0x")).unwrap();
        assert_eq!(raw.len(), 4); // no args -> just the selector
    }

    #[test]
    fn decodes_get_lock_return() {
        let buyer = Address::repeat_byte(0x11);
        let seller = Address::repeat_byte(0x22);
        let amount = U256::from(1_000_000u64);
        let hashlock = B256::repeat_byte(0x33);
        let timelock = U256::from(5000u64);
        // ABI-encode the 7-value return tuple the contract would produce.
        let ret = (buyer, seller, amount, hashlock, timelock, true, false).abi_encode_params();
        let lock = decode_get_lock(&ret).expect("decodes");
        assert_eq!(
            lock,
            OnchainLock {
                buyer,
                seller,
                amount,
                withdrawn: true,
                refunded: false,
            }
        );
    }

    #[test]
    fn decodes_single_uint_returns() {
        let v = U256::from(42u64);
        let ret = v.abi_encode();
        assert_eq!(decode_u256(&ret), Some(v));
    }
}
