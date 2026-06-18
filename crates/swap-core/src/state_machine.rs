//! Swap state machine + integrity enforcement. Direct port of
//! `worker/src/swaps.ts`. The Worker is the authority; every mutation goes
//! through here, which guarantees:
//!   - immutable economic identity never changes after creation,
//!   - the buyer is committed exactly once (no claim-jumping),
//!   - a party may only write their own progress fields,
//!   - optimistic-concurrency version bumps.
//!
//! These are *pure* transitions: the caller loads the prior record, calls the
//! transition, and (on `Ok`) writes the returned record plus [`index_keys`].
//! That keeps swap-core free of async IO so it builds + tests on every target.

use serde_json::{Map, Value};

use crate::contract::{
    BUYER_CLAIM_FIELDS, BUYER_FIELDS, IMMUTABLE_FIELDS, REQUIRED_AT_CREATE, SELLER_FIELDS,
};
use crate::roles::Role;

/// A stored swap record (string-encoded bigints, same shape the client uses).
/// Mirrors the TS `Record<string, unknown>` / `SwapRecord`.
pub type SwapRecord = Map<String, Value>;

pub const SWAP_PREFIX: &str = "swap:";
pub const ETH_IDX: &str = "idx:eth:";
pub const NOCK_IDX: &str = "idx:nock:";

/// An error carrying the HTTP status the Worker should return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapError {
    pub status: u16,
    pub message: String,
}

impl SwapError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl core::fmt::Display for SwapError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{} ({})", self.message, self.status)
    }
}

impl std::error::Error for SwapError {}

pub type Result<T> = core::result::Result<T, SwapError>;

/// Protocol ordering (defense-in-depth; the on-chain HTLCs are the real guard).
/// A progress field can only be set once ALL its prerequisites already exist.
fn prerequisites(field: &str) -> &'static [&'static str] {
    match field {
        "lockFirstName" => &["buyerPkh"],
        "usdcLockTxHash" => &["lockFirstName"],
        "usdcWithdrawTxHash" => &["lockFirstName", "usdcLockTxHash"],
        "nockClaimTxId" => &["usdcWithdrawTxHash"],
        "nockRefundTxId" => &["lockFirstName"],
        "usdcRefundTxHash" => &["usdcLockTxHash"],
        _ => &[],
    }
}

/// A field cannot be set if any conflicting (terminal-state) field already exists.
fn conflicts(field: &str) -> &'static [&'static str] {
    match field {
        "nockClaimTxId" => &["nockRefundTxId"],
        "nockRefundTxId" => &["nockClaimTxId"],
        "usdcWithdrawTxHash" => &["usdcRefundTxHash"],
        "usdcRefundTxHash" => &["usdcWithdrawTxHash"],
        _ => &[],
    }
}

/// Canonical swap id: the lowercased `hEvm`.
pub fn id(h_evm: &str) -> String {
    h_evm.to_lowercase()
}

/// KV key for a swap record.
pub fn swap_key(h_evm: &str) -> String {
    format!("{SWAP_PREFIX}{}", id(h_evm))
}

/// Participant index keys to (re)write alongside the record — `(key, value)`
/// pairs where the value points back at the swap id. Idempotent. Mirrors the
/// index maintenance in `writeSwap`.
pub fn index_keys(rec: &SwapRecord) -> Vec<(String, String)> {
    let key = id(str_field(rec, "hEvm").unwrap_or(""));
    let mut out = Vec::new();
    if let Some(v) = nonempty(rec, "sellerEth") {
        out.push((format!("{ETH_IDX}{}:{}", v.to_lowercase(), key), key.clone()));
    }
    if let Some(v) = nonempty(rec, "buyerEth") {
        out.push((format!("{ETH_IDX}{}:{}", v.to_lowercase(), key), key.clone()));
    }
    if let Some(v) = nonempty(rec, "sellerPkh") {
        out.push((format!("{NOCK_IDX}{v}:{key}"), key.clone()));
    }
    if let Some(v) = nonempty(rec, "buyerPkh") {
        out.push((format!("{NOCK_IDX}{v}:{key}"), key.clone()));
    }
    out
}

/// Create a swap. `exists` is whether a record already lives at this id (the
/// caller performs the load). The session pkh must equal the swap's `sellerPkh`.
pub fn create_swap(swap: &SwapRecord, session_pkh: &str, exists: bool) -> Result<SwapRecord> {
    match str_field(swap, "hEvm") {
        Some(s) if !s.is_empty() => {}
        _ => return Err(SwapError::new(400, "missing hEvm")),
    }
    for f in REQUIRED_AT_CREATE {
        match swap.get(*f) {
            None | Some(Value::Null) => {
                return Err(SwapError::new(400, format!("missing required field \"{f}\"")))
            }
            Some(Value::String(s)) if s.is_empty() => {
                return Err(SwapError::new(400, format!("missing required field \"{f}\"")))
            }
            _ => {}
        }
    }
    if str_field(swap, "sellerPkh") != Some(session_pkh) {
        return Err(SwapError::new(403, "sellerPkh must match the signed-in wallet"));
    }
    if exists {
        return Err(SwapError::new(409, "swap already exists"));
    }

    let mut rec = swap.clone();
    rec.insert("sellerPkh".into(), Value::from(session_pkh));
    rec.insert("version".into(), Value::from(1u64));
    Ok(rec)
}

/// Buyer claims an OPEN swap. `buyer_pkh` (the session pkh) cannot be spoofed —
/// it comes from the authenticated session, not the request body.
pub fn claim_swap(
    prev: Option<&SwapRecord>,
    buyer_eth: &str,
    session_pkh: &str,
) -> Result<SwapRecord> {
    let prev = prev.ok_or_else(|| SwapError::new(404, "swap not found"))?;
    if truthy(prev, "buyerPkh") || truthy(prev, "buyerEth") {
        return Err(SwapError::new(409, "swap already claimed"));
    }
    if str_field(prev, "sellerPkh") == Some(session_pkh) {
        return Err(SwapError::new(403, "seller cannot claim their own swap"));
    }
    if buyer_eth.is_empty() {
        return Err(SwapError::new(400, "missing buyerEth"));
    }

    let mut rec = prev.clone();
    rec.insert("buyerPkh".into(), Value::from(session_pkh));
    rec.insert("buyerEth".into(), Value::from(buyer_eth));
    rec.insert("version".into(), Value::from(version(prev) + 1));
    Ok(rec)
}

/// Advance a swap with progress fields. The session pkh decides the role:
/// seller may write [`SELLER_FIELDS`], buyer may write [`BUYER_FIELDS`].
/// Diff-based: only fields that actually CHANGED are applied and authorized.
pub fn advance_swap(
    prev: Option<&SwapRecord>,
    fields: &Map<String, Value>,
    session_pkh: &str,
    expected_version: Option<u64>,
) -> Result<SwapRecord> {
    let prev = prev.ok_or_else(|| SwapError::new(404, "swap not found"))?;
    if let Some(ev) = expected_version {
        if version(prev) != ev {
            return Err(SwapError::new(409, "version conflict — reload and retry"));
        }
    }

    let is_seller = str_field(prev, "sellerPkh") == Some(session_pkh);
    let is_buyer = str_field(prev, "buyerPkh") == Some(session_pkh);
    if !is_seller && !is_buyer {
        return Err(SwapError::new(403, "not a participant in this swap"));
    }

    let mut next = prev.clone();
    for (f, v) in fields {
        if js_string(Some(v)) == js_string(prev.get(f)) {
            continue; // unchanged
        }
        let f_str = f.as_str();
        if IMMUTABLE_FIELDS.contains(&f_str) || BUYER_CLAIM_FIELDS.contains(&f_str) {
            return Err(SwapError::new(409, format!("field \"{f}\" is immutable once set")));
        }
        if SELLER_FIELDS.contains(&f_str) {
            if !is_seller {
                return Err(SwapError::new(403, format!("only the seller may write \"{f}\"")));
            }
        } else if BUYER_FIELDS.contains(&f_str) {
            if !is_buyer {
                return Err(SwapError::new(403, format!("only the buyer may write \"{f}\"")));
            }
        } else {
            return Err(SwapError::new(403, format!("unknown field \"{f}\"")));
        }
        for p in prerequisites(f) {
            if !truthy(prev, p) {
                return Err(SwapError::new(
                    409,
                    format!("cannot set \"{f}\" before \"{p}\" is set"),
                ));
            }
        }
        for c in conflicts(f) {
            if truthy(prev, c) {
                return Err(SwapError::new(
                    409,
                    format!("cannot set \"{f}\": \"{c}\" is already set"),
                ));
            }
        }
        next.insert(f.clone(), v.clone());
    }
    next.insert("version".into(), Value::from(version(prev) + 1));
    Ok(next)
}

/// Pick a party's writable progress fields out of an encoded record (skipping
/// nulls). Port of `progressFields`; this is what the client sends to
/// `/swap/:id/advance`. Reuses the same field constants as [`advance_swap`], so
/// the client and Worker can't disagree on who-writes-what.
pub fn progress_fields(record: &SwapRecord, role: Role) -> Map<String, Value> {
    let names: &[&str] = match role {
        Role::Seller => SELLER_FIELDS,
        Role::Buyer => BUYER_FIELDS,
    };
    let mut out = Map::new();
    for n in names {
        if let Some(v) = record.get(*n) {
            if !v.is_null() {
                out.insert((*n).to_string(), v.clone());
            }
        }
    }
    out
}

// --- helpers (JS-semantics shims) ---

fn version(rec: &SwapRecord) -> u64 {
    rec.get("version").and_then(Value::as_u64).unwrap_or(1)
}

fn str_field<'a>(rec: &'a SwapRecord, key: &str) -> Option<&'a str> {
    rec.get(key).and_then(Value::as_str)
}

/// A present, non-empty string field (`undefined`/`""` → `None`).
fn nonempty<'a>(rec: &'a SwapRecord, key: &str) -> Option<&'a str> {
    match rec.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// JS truthiness of `rec[key]`: `undefined`/`null`/`false`/`0`/`""` are falsy.
fn truthy(rec: &SwapRecord, key: &str) -> bool {
    match rec.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0).unwrap_or(true),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JS `String(v ?? "")`: `undefined`/`null` → `""`, strings verbatim, numbers /
/// bools by their JS string form. Used for the "did this field change?" check.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}
