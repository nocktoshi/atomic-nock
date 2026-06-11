//! Atomic Nock swap API (Cloudflare Worker, workers-rs). Port of
//! `worker/src/index.ts`. All swap-state logic + auth lives in `swap-core`; this
//! crate is the thin async shell: routing, KV IO, sessions wired to the runtime
//! clock/RNG, CORS, and SwapError → HTTP status mapping.
//!
//!   GET  /auth/challenge?pkh=<pkh>  -> { challenge, challengeMac }
//!   POST /auth/login                -> { token }
//!   POST /swap                      -> create (seller session)
//!   POST /swap/:id/claim            -> buyer commits to an open swap
//!   POST /swap/:id/advance          -> party writes their progress fields
//!   GET  /swap/:id                  -> swap record
//!   GET  /list?prefix=...           -> { keys: string[] }

use serde_json::{json, Value};
use worker::*;

use swap_core::contract::{AdvanceBody, ClaimBody, CreateBody, LoginBody};
use swap_core::session::{
    bearer, issue_token, make_challenge, validate_challenge, verify_token, CHALLENGE_TTL_MS,
    SESSION_TTL_MS,
};
use swap_core::state_machine::{
    advance_swap, claim_swap, create_swap, index_keys, swap_key, SwapError, SwapRecord,
};
use swap_core::verify_nock_signature;

const MAX_KEYS: usize = 1000;

/// Either a domain error (mapped to its HTTP status) or an internal failure (500).
enum ApiError {
    Swap(SwapError),
    Internal(String),
}

impl From<SwapError> for ApiError {
    fn from(e: SwapError) -> Self {
        ApiError::Swap(e)
    }
}
impl From<worker::Error> for ApiError {
    fn from(e: worker::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}
impl From<worker::kv::KvError> for ApiError {
    fn from(e: worker::kv::KvError) -> Self {
        ApiError::Internal(e.to_string())
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // CORS preflight.
    if req.method() == Method::Options {
        return Ok(Response::empty()?.with_headers(cors_headers()));
    }
    match handle(req, &env).await {
        Ok(resp) => Ok(resp),
        Err(ApiError::Swap(s)) => json_response(&json!({ "error": s.message }), s.status),
        Err(ApiError::Internal(m)) => {
            console_error!("worker error: {m}");
            json_response(&json!({ "error": "internal error" }), 500)
        }
    }
}

async fn handle(mut req: Request, env: &Env) -> std::result::Result<Response, ApiError> {
    let url = req.url()?;
    let path = url.path().to_string();
    let method = req.method();
    let now = Date::now().as_millis();

    // --- auth ---------------------------------------------------------------
    if path == "/auth/challenge" && method == Method::Get {
        let secret = session_secret(env)?;
        let pkh = url
            .query_pairs()
            .find(|(k, _)| k == "pkh")
            .map(|(_, v)| v.into_owned())
            .filter(|p| !p.is_empty())
            .ok_or_else(|| SwapError::new(400, "missing pkh"))?;
        let mut rand = [0u8; 16];
        getrandom::getrandom(&mut rand).map_err(|e| ApiError::Internal(e.to_string()))?;
        let c = make_challenge(&pkh, &secret, now + CHALLENGE_TTL_MS, &rand);
        return ok_json(&json!({ "challenge": c.challenge, "challengeMac": c.challenge_mac }));
    }

    if path == "/auth/login" && method == Method::Post {
        let secret = session_secret(env)?;
        let body: LoginBody = req.json().await?;
        let pkh = validate_challenge(&body.challenge, &body.challenge_mac, &secret, now)
            .ok_or_else(|| SwapError::new(401, "invalid or expired challenge"))?;
        // Bind: the pubkey must hash to the challenge's pkh.
        if verify_nock_signature(&body.challenge, &body.pubkey_hex, &body.signature, Some(&pkh))
            .is_none()
        {
            return Err(SwapError::new(401, "signature verification failed").into());
        }
        return ok_json(&json!({ "token": issue_token(&pkh, &secret, now + SESSION_TTL_MS) }));
    }

    // --- writes (authed) ----------------------------------------------------
    if path == "/swap" && method == Method::Post {
        let pkh = require_session(&req, env, now)?;
        let body: CreateBody = req.json().await?;
        let kv = env.kv("SWAPS")?;
        let h_evm = body.swap.get("hEvm").and_then(Value::as_str).unwrap_or("");
        let exists = load_swap(&kv, h_evm).await?.is_some();
        let rec = create_swap(&body.swap, &pkh, exists)?;
        write_swap(&kv, &rec).await?;
        return ok_json(&json!({ "ok": true, "swap": rec }));
    }

    if let Some(rest) = path.strip_prefix("/swap/") {
        if let Some(id_enc) = rest.strip_suffix("/claim") {
            if method == Method::Post {
                let pkh = require_session(&req, env, now)?;
                let body: ClaimBody = req.json().await?;
                let kv = env.kv("SWAPS")?;
                let prev = load_swap(&kv, &decode_id(id_enc)).await?;
                let rec = claim_swap(prev.as_ref(), &body.buyer_eth, &pkh)?;
                write_swap(&kv, &rec).await?;
                return ok_json(&json!({ "ok": true, "swap": rec }));
            }
        } else if let Some(id_enc) = rest.strip_suffix("/advance") {
            if method == Method::Post {
                let pkh = require_session(&req, env, now)?;
                let body: AdvanceBody = req.json().await?;
                let kv = env.kv("SWAPS")?;
                let prev = load_swap(&kv, &decode_id(id_enc)).await?;
                let rec = advance_swap(prev.as_ref(), &body.fields, &pkh, body.expected_version)?;
                write_swap(&kv, &rec).await?;
                return ok_json(&json!({ "ok": true, "swap": rec }));
            }
        } else if method == Method::Get && !rest.contains('/') {
            // --- read (open) ---
            let kv = env.kv("SWAPS")?;
            return match load_swap(&kv, &decode_id(rest)).await? {
                Some(rec) => ok_json(&Value::Object(rec)),
                None => json_response(&json!({ "error": "not found" }), 404).map_err(Into::into),
            };
        }
    }

    if path == "/list" && method == Method::Get {
        // Authenticated + scoped: you may only list your OWN swaps.
        let pkh = require_session(&req, env, now)?;
        let prefix = url
            .query_pairs()
            .find(|(k, _)| k == "prefix")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        if prefix != format!("idx:nock:{pkh}:") {
            return Err(SwapError::new(403, "may only list your own swaps").into());
        }
        let kv = env.kv("SWAPS")?;
        let mut out: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut builder = kv.list().prefix(prefix.clone());
            if let Some(c) = &cursor {
                builder = builder.cursor(c.clone());
            }
            let page = builder.execute().await?;
            for k in page.keys {
                out.push(k.name);
                if out.len() >= MAX_KEYS {
                    break;
                }
            }
            cursor = if page.list_complete || out.len() >= MAX_KEYS {
                None
            } else {
                page.cursor
            };
            if cursor.is_none() {
                break;
            }
        }
        return ok_json(&json!({ "keys": out }));
    }

    json_response(&json!({ "error": "not found" }), 404).map_err(Into::into)
}

// --- session/env helpers ---

fn session_secret(env: &Env) -> std::result::Result<String, ApiError> {
    env.secret("SESSION_SECRET")
        .map(|s| s.to_string())
        .map_err(|_| ApiError::Swap(SwapError::new(500, "server not configured")))
}

fn require_session(
    req: &Request,
    env: &Env,
    now: u64,
) -> std::result::Result<String, ApiError> {
    let secret = session_secret(env)?;
    let auth = req.headers().get("authorization")?;
    verify_token(bearer(auth.as_deref()), &secret, now)
        .ok_or_else(|| ApiError::Swap(SwapError::new(401, "sign in required")))
}

fn decode_id(id_enc: &str) -> String {
    urlencoding::decode(id_enc)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| id_enc.to_string())
}

// --- KV IO (the load → transition → write loop swap-core leaves to the caller) ---

async fn load_swap(
    kv: &kv::KvStore,
    h_evm: &str,
) -> std::result::Result<Option<SwapRecord>, ApiError> {
    match kv.get(&swap_key(h_evm)).text().await? {
        Some(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        None => Ok(None),
    }
}

async fn write_swap(kv: &kv::KvStore, rec: &SwapRecord) -> std::result::Result<(), ApiError> {
    let h_evm = rec.get("hEvm").and_then(Value::as_str).unwrap_or("");
    let payload = serde_json::to_string(rec)?;
    kv.put(&swap_key(h_evm), payload)?.execute().await?;
    // Participant indexes (idempotent; values point back at the id).
    for (k, v) in index_keys(rec) {
        kv.put(&k, v)?.execute().await?;
    }
    Ok(())
}

// --- responses ---

fn cors_headers() -> Headers {
    let h = Headers::new();
    let _ = h.set("access-control-allow-origin", "*");
    let _ = h.set("access-control-allow-methods", "GET,POST,OPTIONS");
    let _ = h.set("access-control-allow-headers", "authorization,content-type");
    h
}

fn json_response(body: &Value, status: u16) -> Result<Response> {
    let bytes = serde_json::to_vec(body).map_err(|e| Error::RustError(e.to_string()))?;
    let headers = cors_headers();
    headers.set("content-type", "application/json")?;
    Ok(Response::from_bytes(bytes)?
        .with_status(status)
        .with_headers(headers))
}

fn ok_json(body: &Value) -> std::result::Result<Response, ApiError> {
    json_response(body, 200).map_err(Into::into)
}
