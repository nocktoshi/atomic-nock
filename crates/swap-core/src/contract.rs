//! Wire contract between the client and the Worker — the field-authorization
//! model. The Worker is authoritative and enforces every invariant; the client
//! mirrors these shapes. Direct port of `worker/src/contract.ts`.
//!
//! - [`IMMUTABLE_FIELDS`]   set once at creation, never change (the swap's
//!   economic identity: hashlock, amount, timelock, seller).
//! - [`BUYER_CLAIM_FIELDS`] the buyer's identity, settable once then immutable.
//! - [`SELLER_FIELDS`]      progress fields only the verified seller may write.
//! - [`BUYER_FIELDS`]       progress fields only the verified buyer may write.

pub const IMMUTABLE_FIELDS: &[&str] = &[
    "hEvm",
    "hNock",
    "usdcTimelock",
    "nockGift",
    "nockRefundHeight",
    "sellerEth",
    "sellerPkh",
    "usdcAmount",
    "swapId",
];

pub const BUYER_CLAIM_FIELDS: &[&str] = &["buyerPkh", "buyerEth"];

pub const SELLER_FIELDS: &[&str] = &[
    "lockFirstName",
    "lockRoot",
    "parentHash",
    "birthOutputIndex",
    "nockLockTxId",
    "usdcWithdrawTxHash",
    "nockRefundTxId",
];

pub const BUYER_FIELDS: &[&str] = &["usdcLockTxHash", "nockClaimTxId", "usdcRefundTxHash"];

/// Fields a seller must supply at creation (everything immutable except `swapId`).
pub const REQUIRED_AT_CREATE: &[&str] = &[
    "hEvm",
    "hNock",
    "usdcTimelock",
    "nockGift",
    "nockRefundHeight",
    "sellerEth",
    "sellerPkh",
    "usdcAmount",
];

// --- request bodies (mirror the TS interfaces; the Worker deserializes these) ---

use iris_crypto::Signature;
use serde::Deserialize;
use serde_json::{Map, Value};

/// Body for `POST /swap` (seller-signed session).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBody {
    /// SwapPublic-encoded fields.
    pub swap: Map<String, Value>,
}

/// Body for `POST /swap/:id/claim` (buyer-signed session). `buyerPkh` comes from
/// the session, never the body.
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimBody {
    #[serde(rename = "buyerEth")]
    pub buyer_eth: String,
}

/// Body for `POST /swap/:id/advance` (party-signed session).
#[derive(Debug, Clone, Deserialize)]
pub struct AdvanceBody {
    /// A subset of SELLER_FIELDS or BUYER_FIELDS.
    pub fields: Map<String, Value>,
    /// Optimistic concurrency (optional).
    #[serde(rename = "expectedVersion")]
    pub expected_version: Option<u64>,
}

/// Auth payload posted to `/auth/login`.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginBody {
    pub challenge: String,
    #[serde(rename = "challengeMac")]
    pub challenge_mac: String,
    #[serde(rename = "pubkeyHex")]
    pub pubkey_hex: String,
    /// Schnorr signature scalars; deserialized straight into the iris `Signature`.
    pub signature: Signature,
}
