//! The shared swap bundle and its wire encoding. Port of `src/swap.ts`
//! (the type, `encodeSwapParams`/`decodeSwapParams`, and the byte helpers).
//!
//! The encoded form stringifies the bigint fields and omits empty optionals,
//! exactly matching `encodeSwapParams` so the JSON round-trips with the Worker /
//! KV and feeds the [`crate::state_machine`] record map directly.

use serde_json::{Map, Value};

use crate::state_machine::SwapRecord;

/// Shared swap bundle (no preimage — that's revealed on the Base withdraw).
/// Mirrors `SwapPublic`. `buyer_pkh` is empty (`""`) on an open, unclaimed swap.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Swap {
    pub h_nock: String,
    pub h_evm: String,
    pub seller_pkh: String,
    pub buyer_pkh: String,
    pub nock_refund_height: u64,
    pub usdc_timelock: u64,
    pub nock_gift: u64,
    /// Seller's Base address — captured at creation so the buyer never types it.
    pub seller_eth: Option<String>,
    /// Buyer's Base address — captured when the buyer locks USDC.
    pub buyer_eth: Option<String>,
    /// Human USDC amount for the swap (e.g. "1.5").
    pub usdc_amount: Option<String>,
    /// Filled after seller locks NOCK; buyer needs this to claim.
    pub lock_first_name: Option<String>,
    /// HTLC OR lock-tree root (from seller lock).
    pub lock_root: Option<String>,
    /// Seller's input note hash used for the lock tx.
    pub parent_hash: Option<String>,
    /// Output index of the HTLC gift note in the seller's lock tx.
    pub birth_output_index: Option<u32>,
    pub nock_lock_tx_id: Option<String>,
    pub usdc_lock_tx_hash: Option<String>,
    pub usdc_withdraw_tx_hash: Option<String>,
    pub nock_claim_tx_id: Option<String>,
    pub usdc_refund_tx_hash: Option<String>,
    pub nock_refund_tx_id: Option<String>,
}

/// `DraftSwap` is just a `Swap` whose progress fields are still empty; we model
/// it with the same struct (every optional defaults to `None`).
pub type DraftSwap = Swap;

fn insert_opt(map: &mut Map<String, Value>, key: &str, val: &Option<String>) {
    // TS includes optional string fields only when truthy (non-empty).
    if let Some(s) = val {
        if !s.is_empty() {
            map.insert(key.into(), Value::from(s.clone()));
        }
    }
}

/// Build the encoded record (string-bigints, empty optionals omitted) in the
/// exact field order of `encodeSwapParams`. This is what gets JSON-stringified
/// for transport and fed to the state machine.
pub fn encode_swap_record(s: &Swap) -> SwapRecord {
    let mut m = Map::new();
    m.insert("hNock".into(), Value::from(s.h_nock.clone()));
    m.insert("hEvm".into(), Value::from(s.h_evm.clone()));
    m.insert("sellerPkh".into(), Value::from(s.seller_pkh.clone()));
    m.insert("buyerPkh".into(), Value::from(s.buyer_pkh.clone()));
    insert_opt(&mut m, "sellerEth", &s.seller_eth);
    insert_opt(&mut m, "buyerEth", &s.buyer_eth);
    insert_opt(&mut m, "usdcAmount", &s.usdc_amount);
    insert_opt(&mut m, "lockFirstName", &s.lock_first_name);
    insert_opt(&mut m, "lockRoot", &s.lock_root);
    insert_opt(&mut m, "parentHash", &s.parent_hash);
    if let Some(i) = s.birth_output_index {
        m.insert("birthOutputIndex".into(), Value::from(i));
    }
    insert_opt(&mut m, "nockLockTxId", &s.nock_lock_tx_id);
    insert_opt(&mut m, "usdcLockTxHash", &s.usdc_lock_tx_hash);
    insert_opt(&mut m, "usdcWithdrawTxHash", &s.usdc_withdraw_tx_hash);
    insert_opt(&mut m, "nockClaimTxId", &s.nock_claim_tx_id);
    insert_opt(&mut m, "usdcRefundTxHash", &s.usdc_refund_tx_hash);
    insert_opt(&mut m, "nockRefundTxId", &s.nock_refund_tx_id);
    // bigints, stringified, last (matches encodeSwapParams ordering).
    m.insert("nockGift".into(), Value::from(s.nock_gift.to_string()));
    m.insert(
        "nockRefundHeight".into(),
        Value::from(s.nock_refund_height.to_string()),
    );
    m.insert(
        "usdcTimelock".into(),
        Value::from(s.usdc_timelock.to_string()),
    );
    m
}

/// Encode a swap to its JSON wire string (== `encodeSwapParams`).
pub fn encode_swap_params(s: &Swap) -> String {
    serde_json::to_string(&encode_swap_record(s)).expect("swap record serializes")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl core::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for DecodeError {}

/// `str(v)` in `decodeSwapParams`: trim, and treat empty as absent.
fn trimmed(map: &Map<String, Value>, key: &str) -> Option<String> {
    match map.get(key).and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// Parse a stringified-bigint field via `u64::from_str` (the TS uses `BigInt`).
fn parse_u64(map: &Map<String, Value>, key: &str) -> core::result::Result<u64, DecodeError> {
    let v = map.get(key);
    // Accept both a JSON string ("100") and a JSON number (100), like BigInt().
    let parsed = match v {
        Some(Value::String(s)) => s.trim().parse::<u64>().ok(),
        Some(Value::Number(n)) => n.as_u64(),
        _ => None,
    };
    parsed.ok_or_else(|| DecodeError(format!("invalid bigint field \"{key}\"")))
}

/// Decode a swap record map into the typed [`Swap`] (== `decodeSwapParams`).
pub fn decode_swap_record(map: &Map<String, Value>) -> core::result::Result<Swap, DecodeError> {
    if map.contains_key("preimageJam") {
        return Err(DecodeError(
            "Swap JSON must not include preimageJam — seller reveals it via Base withdraw".into(),
        ));
    }
    let birth_output_index = match map.get("birthOutputIndex") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_u64().map(|x| x as u32),
        Some(Value::String(s)) => s.trim().parse::<u32>().ok(),
        _ => None,
    };
    Ok(Swap {
        h_nock: map.get("hNock").and_then(Value::as_str).unwrap_or("").into(),
        h_evm: map.get("hEvm").and_then(Value::as_str).unwrap_or("").into(),
        seller_pkh: map
            .get("sellerPkh")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        // buyerPkh may be absent on an OPEN swap; empty string = unclaimed.
        buyer_pkh: map
            .get("buyerPkh")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        nock_refund_height: parse_u64(map, "nockRefundHeight")?,
        usdc_timelock: parse_u64(map, "usdcTimelock")?,
        nock_gift: parse_u64(map, "nockGift")?,
        seller_eth: trimmed(map, "sellerEth"),
        buyer_eth: trimmed(map, "buyerEth"),
        usdc_amount: trimmed(map, "usdcAmount"),
        lock_first_name: trimmed(map, "lockFirstName"),
        lock_root: trimmed(map, "lockRoot"),
        parent_hash: trimmed(map, "parentHash"),
        birth_output_index,
        nock_lock_tx_id: trimmed(map, "nockLockTxId"),
        usdc_lock_tx_hash: trimmed(map, "usdcLockTxHash"),
        usdc_withdraw_tx_hash: trimmed(map, "usdcWithdrawTxHash"),
        nock_claim_tx_id: trimmed(map, "nockClaimTxId"),
        usdc_refund_tx_hash: trimmed(map, "usdcRefundTxHash"),
        nock_refund_tx_id: trimmed(map, "nockRefundTxId"),
    })
}

/// Decode from a JSON wire string (== `decodeSwapParams`).
pub fn decode_swap_params(json: &str) -> core::result::Result<Swap, DecodeError> {
    let v: Value = serde_json::from_str(json).map_err(|e| DecodeError(e.to_string()))?;
    let map = v
        .as_object()
        .ok_or_else(|| DecodeError("swap json is not an object".into()))?;
    decode_swap_record(map)
}

/// `0x`-prefixed lowercase hex of `bytes`.
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Decode hex (with or without `0x`). Returns `None` on odd length / bad digit.
pub fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    let h = hex.strip_prefix("0x").unwrap_or(hex);
    if !h.len().is_multiple_of(2) {
        return None;
    }
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Swap {
        Swap {
            h_nock: "HNOCK".into(),
            h_evm: "0xEvM".into(),
            seller_pkh: "SELLER".into(),
            buyer_pkh: "BUYER".into(),
            nock_refund_height: 1000,
            usdc_timelock: 5000,
            nock_gift: 65536,
            seller_eth: Some("0xSeller".into()),
            buyer_eth: Some("0xBuyer".into()),
            usdc_amount: Some("1.5".into()),
            birth_output_index: Some(2),
            nock_lock_tx_id: Some("0xnl".into()),
            ..Default::default()
        }
    }

    #[test]
    fn encode_decode_round_trips() {
        let s = sample();
        let decoded = decode_swap_params(&encode_swap_params(&s)).unwrap();
        assert_eq!(decoded, s);
    }

    #[test]
    fn bigints_are_stringified() {
        let json = encode_swap_params(&sample());
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["nockGift"], Value::from("65536"));
        assert_eq!(v["nockRefundHeight"], Value::from("1000"));
        assert_eq!(v["usdcTimelock"], Value::from("5000"));
        // birthOutputIndex stays a number
        assert_eq!(v["birthOutputIndex"], Value::from(2));
    }

    #[test]
    fn empty_optionals_are_omitted() {
        let s = Swap {
            h_nock: "H".into(),
            h_evm: "0x".into(),
            seller_pkh: "S".into(),
            buyer_pkh: String::new(),
            nock_refund_height: 1,
            usdc_timelock: 1,
            nock_gift: 1,
            ..Default::default()
        };
        let v: Value = serde_json::from_str(&encode_swap_params(&s)).unwrap();
        assert!(v.get("sellerEth").is_none());
        assert!(v.get("usdcAmount").is_none());
        // buyerPkh is always present (empty string == unclaimed)
        assert_eq!(v["buyerPkh"], Value::from(""));
    }

    #[test]
    fn decode_rejects_preimage() {
        let err = decode_swap_params(r#"{"preimageJam":"x"}"#).unwrap_err();
        assert!(err.0.contains("preimageJam"));
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0x00, 0x01, 0xab, 0xff];
        assert_eq!(bytes_to_hex(&bytes), "0x0001abff");
        assert_eq!(hex_to_bytes("0x0001abff"), Some(bytes.clone()));
        assert_eq!(hex_to_bytes("0001abff"), Some(bytes));
        assert_eq!(hex_to_bytes("abc"), None);
    }
}
