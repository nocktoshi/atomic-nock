//! EIP-1193 browser bridge + high-level HTLC ops. Wasm-only. Port of the
//! network-touching parts of `src/evm/htlc.ts` and `src/evm/preimage.ts`.
//!
//! Instead of viem's `createPublicClient`/`createWalletClient`, we call
//! `window.ethereum.request({ method, params })` directly: `eth_call` for reads
//! (calldata from [`crate::calls`]), `eth_sendTransaction` for writes, and a
//! receipt poll for confirmation. No alloy provider/transport (those pull
//! reqwest/hyper, which don't build for wasm32).

use std::str::FromStr;

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolEvent;
use gloo_timers::future::TimeoutFuture;
use js_sys::{Array, Function, Object, Promise, Reflect};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use crate::abi::IHtlc;
use crate::calls;
use crate::config::{CHAIN_ID, DEFAULT_FEE_BPS, HTLC_ADDRESS, USDC_ADDRESS};

/// An EVM/wallet error with a human message.
#[derive(Debug, Clone)]
pub struct EvmError(pub String);

impl std::fmt::Display for EvmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for EvmError {}

fn err(msg: impl Into<String>) -> EvmError {
    EvmError(msg.into())
}
fn js_err(ctx: &str, e: JsValue) -> EvmError {
    EvmError(format!("{ctx}: {e:?}"))
}

type Result<T> = std::result::Result<T, EvmError>;

// --- EIP-1193 transport ---

fn ethereum() -> Result<JsValue> {
    let win = web_sys::window().ok_or_else(|| err("no window"))?;
    let eth = Reflect::get(win.as_ref(), &JsValue::from_str("ethereum"))
        .map_err(|e| js_err("read window.ethereum", e))?;
    if eth.is_undefined() || eth.is_null() {
        return Err(err("No wallet (install MetaMask)"));
    }
    Ok(eth)
}

/// `window.ethereum.request({ method, params })`, awaited.
async fn request(method: &str, params: Array) -> Result<JsValue> {
    let eth = ethereum()?;
    let req_fn: Function = Reflect::get(&eth, &JsValue::from_str("request"))
        .map_err(|e| js_err("get request fn", e))?
        .dyn_into()
        .map_err(|_| err("window.ethereum.request is not callable"))?;
    let arg = Object::new();
    Reflect::set(&arg, &"method".into(), &method.into()).map_err(|e| js_err("set method", e))?;
    Reflect::set(&arg, &"params".into(), &params.into()).map_err(|e| js_err("set params", e))?;
    let promise: Promise = req_fn
        .call1(&eth, &arg)
        .map_err(|e| js_err(method, e))?
        .dyn_into()
        .map_err(|_| err("request did not return a Promise"))?;
    JsFuture::from(promise).await.map_err(|e| js_err(method, e))
}

fn as_string(v: &JsValue, ctx: &str) -> Result<String> {
    v.as_string().ok_or_else(|| err(format!("{ctx}: expected a string result")))
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>> {
    let h = hex.strip_prefix("0x").unwrap_or(hex);
    if !h.len().is_multiple_of(2) {
        return Err(err("odd-length hex"));
    }
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).map_err(|_| err("bad hex")))
        .collect()
}

fn call_obj(to: &Address, data: &str) -> Object {
    let o = Object::new();
    let _ = Reflect::set(&o, &"to".into(), &to.to_string().into());
    let _ = Reflect::set(&o, &"data".into(), &data.into());
    o
}

/// `eth_call` against `to` with `data`, returning the raw return bytes.
async fn eth_call(to: &Address, data: String) -> Result<Vec<u8>> {
    let params = Array::new();
    params.push(&call_obj(to, &data));
    params.push(&"latest".into());
    let res = request("eth_call", params).await?;
    hex_to_bytes(&as_string(&res, "eth_call")?)
}

/// `eth_sendTransaction` from `from` to `to` with `data`; returns the tx hash.
async fn send_tx(from: &Address, to: &Address, data: String) -> Result<String> {
    let o = call_obj(to, &data);
    let _ = Reflect::set(&o, &"from".into(), &from.to_string().into());
    let params = Array::new();
    params.push(&o);
    let res = request("eth_sendTransaction", params).await?;
    as_string(&res, "eth_sendTransaction")
}

/// Poll `eth_getTransactionReceipt` until mined; error unless status == 0x1.
async fn wait_for_success(tx_hash: &str, what: &str) -> Result<()> {
    for _ in 0..150 {
        let params = Array::new();
        params.push(&tx_hash.into());
        let res = request("eth_getTransactionReceipt", params).await?;
        if !res.is_null() && !res.is_undefined() {
            let status = Reflect::get(&res, &"status".into())
                .ok()
                .and_then(|s| s.as_string())
                .unwrap_or_default();
            // 0x1 = success, 0x0 = revert.
            return if status == "0x1" {
                Ok(())
            } else {
                Err(err(format!("{what} transaction reverted")))
            };
        }
        TimeoutFuture::new(2_000).await;
    }
    Err(err(format!("{what} transaction not mined in time")))
}

fn account_from(res: &JsValue) -> Result<Address> {
    let arr: Array = res.clone().dyn_into().map_err(|_| err("expected accounts array"))?;
    let first = arr.get(0);
    let s = first.as_string().ok_or_else(|| err("no connected account"))?;
    Address::from_str(&s).map_err(|_| err("bad account address"))
}

// --- high-level ops (mirror htlc.ts) ---

/// Connect MetaMask and ensure it's on Base; returns the selected address.
pub async fn connect_wallet() -> Result<Address> {
    let account = account_from(&request("eth_requestAccounts", Array::new()).await?)?;
    let chain_hex = as_string(&request("eth_chainId", Array::new()).await?, "eth_chainId")?;
    let chain_id = u64::from_str_radix(chain_hex.trim_start_matches("0x"), 16)
        .map_err(|_| err("bad chainId"))?;
    if chain_id != CHAIN_ID {
        let target = Object::new();
        let _ = Reflect::set(&target, &"chainId".into(), &format!("0x{CHAIN_ID:x}").into());
        let params = Array::new();
        params.push(&target);
        request("wallet_switchEthereumChain", params).await?;
    }
    Ok(account)
}

/// Current connected account (`eth_accounts`).
pub async fn current_account() -> Result<Address> {
    account_from(&request("eth_accounts", Array::new()).await?)
}

pub async fn compute_swap_id(
    seller: Address,
    buyer: Address,
    amount: U256,
    hashlock: B256,
    timelock: U256,
) -> Result<B256> {
    let ret = eth_call(
        &HTLC_ADDRESS,
        calls::swap_id_calldata(seller, buyer, amount, hashlock, timelock),
    )
    .await?;
    calls::decode_swap_id(&ret).ok_or_else(|| err("could not decode swapId"))
}

pub async fn get_fee_bps() -> Result<u16> {
    match eth_call(&HTLC_ADDRESS, calls::fee_bps_calldata()).await {
        Ok(ret) => Ok(calls::decode_fee_bps(&ret).unwrap_or(DEFAULT_FEE_BPS)),
        Err(_) => Ok(DEFAULT_FEE_BPS),
    }
}

pub async fn get_usdc_decimals() -> Result<u8> {
    let ret = eth_call(&USDC_ADDRESS, calls::decimals_calldata()).await?;
    calls::decode_decimals(&ret).ok_or_else(|| err("could not decode decimals"))
}

pub async fn get_onchain_lock(swap_id: B256) -> Result<Option<crate::OnchainLock>> {
    let ret = eth_call(&HTLC_ADDRESS, calls::get_lock_calldata(swap_id)).await?;
    Ok(calls::decode_get_lock(&ret))
}

/// Result of the seller's approve+lock step.
pub struct LockResult {
    pub swap_id: B256,
    pub lock_hash: String,
    pub buyer: Address,
}

/// Approve (if needed) and lock USDC into the HTLC. Mirrors `approveAndLock`.
pub async fn approve_and_lock(
    seller: Address,
    amount_usdc: &str,
    hashlock: B256,
    timelock: U256,
) -> Result<LockResult> {
    let account = current_account().await?;
    let decimals = get_usdc_decimals().await?;
    let amount = crate::to_atomic(amount_usdc, decimals as u32);
    if amount == U256::ZERO {
        return Err(err("USDC amount must be greater than 0"));
    }

    let balance = {
        let ret = eth_call(&USDC_ADDRESS, calls::balance_of_calldata(account)).await?;
        calls::decode_u256(&ret).ok_or_else(|| err("could not decode balance"))?
    };
    if balance < amount {
        return Err(err(format!("Insufficient USDC for {amount_usdc}")));
    }

    let swap_id = compute_swap_id(seller, account, amount, hashlock, timelock).await?;

    let allowance = {
        let ret = eth_call(&USDC_ADDRESS, calls::allowance_calldata(account, HTLC_ADDRESS)).await?;
        calls::decode_u256(&ret).ok_or_else(|| err("could not decode allowance"))?
    };
    if allowance < amount {
        let approve_hash =
            send_tx(&account, &USDC_ADDRESS, calls::approve_calldata(HTLC_ADDRESS, amount)).await?;
        wait_for_success(&approve_hash, "USDC approve").await?;
    }

    let lock_hash = send_tx(
        &account,
        &HTLC_ADDRESS,
        calls::lock_calldata(seller, amount, hashlock, timelock),
    )
    .await?;
    wait_for_success(&lock_hash, "USDC lock").await?;
    Ok(LockResult {
        swap_id,
        lock_hash,
        buyer: account,
    })
}

/// Buyer reclaims locked USDC after the timelock. Mirrors `refundUsdc`.
pub async fn refund_usdc(swap_id: B256) -> Result<String> {
    let account = current_account().await?;
    send_tx(&account, &HTLC_ADDRESS, calls::refund_calldata(swap_id)).await
}

/// Seller withdraws USDC, revealing the preimage. Mirrors `withdrawUsdc`.
pub async fn withdraw_usdc(swap_id: B256, preimage_jam: &[u8]) -> Result<String> {
    let account = current_account().await?;
    send_tx(
        &account,
        &HTLC_ADDRESS,
        calls::withdraw_calldata(swap_id, preimage_jam),
    )
    .await
}

// --- preimage recovery (preimage.ts) ---

/// Decode `preimageJam` from a Base HTLC withdraw tx. Mirrors `getPreimageFromWithdrawTx`.
pub async fn get_preimage_from_withdraw_tx(tx_hash: &str) -> Result<Vec<u8>> {
    let params = Array::new();
    params.push(&tx_hash.into());
    let tx = request("eth_getTransactionByHash", params).await?;
    if tx.is_null() || tx.is_undefined() {
        return Err(err("transaction not found"));
    }
    let to = Reflect::get(&tx, &"to".into()).ok().and_then(|v| v.as_string());
    match to {
        Some(t) if t.eq_ignore_ascii_case(&HTLC_ADDRESS.to_string()) => {}
        _ => return Err(err("Transaction is not a call to the OTC HTLC contract")),
    }
    let input = Reflect::get(&tx, &"input".into())
        .ok()
        .and_then(|v| v.as_string())
        .ok_or_else(|| err("tx has no input"))?;
    let calldata = hex_to_bytes(&input)?;
    calls::decode_withdraw_preimage(&calldata).ok_or_else(|| err("Transaction is not withdraw()"))
}

/// Find the latest `Withdrawn` log for `swap_id` and return its preimage.
/// Mirrors `findPreimageFromSwapWithdraw`.
pub async fn find_preimage_from_swap_withdraw(swap_id: B256) -> Result<(String, Vec<u8>)> {
    // head block
    let head_hex = as_string(&request("eth_blockNumber", Array::new()).await?, "eth_blockNumber")?;
    let head = u64::from_str_radix(head_hex.trim_start_matches("0x"), 16).unwrap_or(0);
    let from_block = head.saturating_sub(500_000);

    let filter = Object::new();
    let _ = Reflect::set(&filter, &"address".into(), &HTLC_ADDRESS.to_string().into());
    let _ = Reflect::set(&filter, &"fromBlock".into(), &format!("0x{from_block:x}").into());
    let _ = Reflect::set(&filter, &"toBlock".into(), &"latest".into());
    // topics: [Withdrawn signature, indexed swapId]
    let topics = Array::new();
    topics.push(&IHtlc::Withdrawn::SIGNATURE_HASH.to_string().into());
    topics.push(&swap_id.to_string().into());
    let _ = Reflect::set(&filter, &"topics".into(), &topics);

    let params = Array::new();
    params.push(&filter);
    let logs: Array = request("eth_getLogs", params)
        .await?
        .dyn_into()
        .map_err(|_| err("eth_getLogs did not return an array"))?;
    if logs.length() == 0 {
        return Err(err(
            "No Withdrawn event for this swapId — seller must withdraw USDC on Base first",
        ));
    }
    let last = logs.get(logs.length() - 1);
    let tx_hash = Reflect::get(&last, &"transactionHash".into())
        .ok()
        .and_then(|v| v.as_string())
        .ok_or_else(|| err("log has no transactionHash"))?;
    let preimage = get_preimage_from_withdraw_tx(&tx_hash).await?;
    Ok((tx_hash, preimage))
}
