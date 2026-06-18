//! `HttpSwapApi` — the [`SwapApi`] over the deployed Worker (gloo-net), with the
//! sign-in token flow (`ensureSession`) + localStorage token cache. Port of the
//! `HttpSwapApi` + `login`/`ensureSession` from `swap-api.ts`/`auth.ts`. wasm-only.

use gloo_net::http::Request;
use serde_json::{json, Value};

use swap_core::state_machine::SwapRecord;

use crate::api::{ApiError, ApiResult, SwapApi};
use crate::auth::{is_fresh, Signer, STORAGE_PREFIX};

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

fn ls() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}
fn ls_get(key: &str) -> Option<String> {
    ls()?.get_item(key).ok().flatten()
}
fn ls_set(key: &str, value: &str) {
    if let Some(s) = ls() {
        let _ = s.set_item(key, value);
    }
}
fn ls_remove(key: &str) {
    if let Some(s) = ls() {
        let _ = s.remove_item(key);
    }
}

fn uri(component: &str) -> String {
    String::from(js_sys::encode_uri_component(component))
}

fn neterr(e: gloo_net::Error) -> ApiError {
    ApiError(e.to_string())
}

/// A still-valid stored token for this pkh, evicting stale ones.
fn stored_token(pkh: &str) -> Option<String> {
    let key = format!("{STORAGE_PREFIX}{pkh}");
    let token = ls_get(&key)?;
    if is_fresh(&token, now_ms()) {
        Some(token)
    } else {
        ls_remove(&key);
        None
    }
}

pub struct HttpSwapApi<S: Signer> {
    base_url: String,
    signer: S,
}

impl<S: Signer> HttpSwapApi<S> {
    pub fn new(base_url: impl Into<String>, signer: S) -> Self {
        Self {
            base_url: base_url.into(),
            signer,
        }
    }

    /// Reuse a fresh token or sign in (one Iris popup) for a new one.
    async fn ensure_session(&self) -> ApiResult<String> {
        let pkh = self.signer.pkh();
        if let Some(token) = stored_token(&pkh) {
            return Ok(token);
        }
        // 1. challenge
        let res = Request::get(&format!("{}/auth/challenge?pkh={}", self.base_url, uri(&pkh)))
            .send()
            .await
            .map_err(neterr)?;
        if res.status() != 200 {
            return Err(ApiError(format!("sign-in challenge failed ({})", res.status())));
        }
        let ch: Value = res.json().await.map_err(neterr)?;
        let challenge = ch["challenge"].as_str().unwrap_or_default().to_string();
        let challenge_mac = ch["challengeMac"].as_str().unwrap_or_default().to_string();

        // 2. sign (Iris wallet)
        let signed = self.signer.sign_for_worker(&challenge).await?;

        // 3. login → token
        let body = json!({
            "challenge": challenge,
            "challengeMac": challenge_mac,
            "pubkeyHex": signed.pubkey_hex,
            "signature": { "c": signed.sig_c, "s": signed.sig_s },
        });
        let res = Request::post(&format!("{}/auth/login", self.base_url))
            .header("content-type", "application/json")
            .body(body.to_string())
            .map_err(neterr)?
            .send()
            .await
            .map_err(neterr)?;
        if res.status() != 200 {
            return Err(ApiError(format!("sign-in failed ({})", res.status())));
        }
        let j: Value = res.json().await.map_err(neterr)?;
        let token = j["token"].as_str().unwrap_or_default().to_string();
        ls_set(&format!("{STORAGE_PREFIX}{pkh}"), &token);
        Ok(token)
    }

    async fn post(&self, path: &str, body: Value) -> ApiResult<SwapRecord> {
        let token = self.ensure_session().await?;
        let res = Request::post(&format!("{}{path}", self.base_url))
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {token}"))
            .body(body.to_string())
            .map_err(neterr)?
            .send()
            .await
            .map_err(neterr)?;
        if !(200..300).contains(&res.status()) {
            return Err(error_of(res).await);
        }
        let j: Value = res.json().await.map_err(neterr)?;
        Ok(j.get("swap")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default())
    }
}

async fn error_of(res: gloo_net::http::Response) -> ApiError {
    let status = res.status();
    let msg = match res.json::<Value>().await {
        Ok(v) => v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => String::new(),
    };
    if msg.is_empty() {
        ApiError(format!("request failed ({status})"))
    } else {
        ApiError(msg)
    }
}

impl<S: Signer> SwapApi for HttpSwapApi<S> {
    async fn create(&self, swap: &SwapRecord) -> ApiResult<SwapRecord> {
        self.post("/swap", json!({ "swap": swap })).await
    }

    async fn claim(&self, h_evm: &str, buyer_eth: &str) -> ApiResult<SwapRecord> {
        self.post(
            &format!("/swap/{}/claim", uri(h_evm)),
            json!({ "buyerEth": buyer_eth }),
        )
        .await
    }

    async fn advance(&self, h_evm: &str, fields: &SwapRecord) -> ApiResult<SwapRecord> {
        self.post(
            &format!("/swap/{}/advance", uri(h_evm)),
            json!({ "fields": fields }),
        )
        .await
    }

    async fn get(&self, h_evm: &str) -> ApiResult<Option<SwapRecord>> {
        let res = Request::get(&format!("{}/swap/{}", self.base_url, uri(&h_evm.to_lowercase())))
            .send()
            .await
            .map_err(neterr)?;
        if res.status() == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&res.status()) {
            return Err(error_of(res).await);
        }
        let rec: Value = res.json().await.map_err(neterr)?;
        Ok(rec.as_object().cloned())
    }

    async fn list_keys(&self, prefix: &str) -> ApiResult<Vec<String>> {
        let token = self.ensure_session().await?;
        let res = Request::get(&format!("{}/list?prefix={}", self.base_url, uri(prefix)))
            .header("authorization", &format!("Bearer {token}"))
            .send()
            .await
            .map_err(neterr)?;
        if !(200..300).contains(&res.status()) {
            return Err(error_of(res).await);
        }
        let j: Value = res.json().await.map_err(neterr)?;
        Ok(j.get("keys")
            .and_then(|k| k.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default())
    }
}
