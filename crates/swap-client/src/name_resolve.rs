//! Reverse name resolution for the wallet pills. Port of `name-resolve.ts`:
//!   - Nockchain pkh → `.nock` name via nocktoshi's nocknames service
//!   - Ethereum address → `.eth` name via on-chain ENS (mainnet)
//!
//! Both return `None` on any failure (callers fall back to the raw address).
//! wasm-only (gloo-net fetch + JSON-RPC eth_call).

use gloo_net::http::Request;
use serde_json::{json, Value};
use tiny_keccak::{Hasher, Keccak};

/// nocktoshi's NockNames resolver.
const NOCKNAMES_API: &str = "https://api.nocknames.com";
/// CORS-friendly Ethereum mainnet RPC (matches `ETH_RPC_URL` default) for ENS.
const ETH_RPC: &str = "https://ethereum-rpc.publicnode.com";
/// ENS registry (mainnet).
const ENS_REGISTRY: &str = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    let mut out = [0u8; 32];
    k.update(data);
    k.finalize(&mut out);
    out
}

/// ENS namehash of a dotted name.
fn namehash(name: &str) -> [u8; 32] {
    let mut node = [0u8; 32];
    if !name.is_empty() {
        for label in name.split('.').rev() {
            let label_hash = keccak(label.as_bytes());
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&node);
            buf[32..].copy_from_slice(&label_hash);
            node = keccak(&buf);
        }
    }
    node
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Vec<u8> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    (0..h.len() / 2)
        .filter_map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn uri(component: &str) -> String {
    String::from(js_sys::encode_uri_component(component))
}

/// `eth_call` against `to` with `data` on mainnet; returns the raw return bytes.
async fn eth_call(to: &str, data: &str) -> Option<Vec<u8>> {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{ "to": to, "data": data }, "latest"],
    });
    let res = Request::post(ETH_RPC)
        .header("content-type", "application/json")
        .body(body.to_string())
        .ok()?
        .send()
        .await
        .ok()?;
    let v: Value = res.json().await.ok()?;
    Some(from_hex(v.get("result")?.as_str()?))
}

/// Reverse-resolve a Nockchain pkh/address to a `.nock` name. Port of
/// `reverseResolveNock` (nocknames `/resolve?address=`).
pub async fn reverse_resolve_nock(address: &str) -> Option<String> {
    let url = format!("{NOCKNAMES_API}/resolve?address={}", uri(address.trim()));
    let res = Request::get(&url).send().await.ok()?;
    if res.status() != 200 {
        return None;
    }
    let v: Value = res.json().await.ok()?;
    v.get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Decode an ABI-encoded `string` return (offset, length, bytes).
fn decode_abi_string(out: &[u8]) -> Option<String> {
    if out.len() < 64 {
        return None;
    }
    // length lives in the second word; names are short so the low 4 bytes suffice.
    let len = u32::from_be_bytes([out[60], out[61], out[62], out[63]]) as usize;
    let start = 64;
    let name = String::from_utf8(out.get(start..start + len)?.to_vec()).ok()?;
    (!name.is_empty()).then_some(name)
}

/// Reverse-resolve an Ethereum address to its ENS name (on-chain, 2 calls:
/// registry.resolver(node) → resolver.name(node)). Port of `reverseResolveEns`.
pub async fn reverse_resolve_ens(address: &str) -> Option<String> {
    let addr = address.trim().to_lowercase();
    let addr_hex = addr.strip_prefix("0x").unwrap_or(&addr);
    let node = namehash(&format!("{addr_hex}.addr.reverse"));

    // registry.resolver(bytes32 node) — selector 0x0178b8bf
    let mut data = vec![0x01, 0x78, 0xb8, 0xbf];
    data.extend_from_slice(&node);
    let out = eth_call(ENS_REGISTRY, &to_hex(&data)).await?;
    if out.len() < 32 || out[12..32].iter().all(|&b| b == 0) {
        return None; // no resolver set
    }
    let resolver = to_hex(&out[12..32]);

    // resolver.name(bytes32 node) — selector 0x691f3431
    let mut data2 = vec![0x69, 0x1f, 0x34, 0x31];
    data2.extend_from_slice(&node);
    let out2 = eth_call(&resolver, &to_hex(&data2)).await?;
    decode_abi_string(&out2)
}
