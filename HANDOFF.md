# atomic-nock → Rust + Leptos: migration handoff

This repo now contains a Rust + Leptos (CSR) port of atomic-nock living **alongside**
the original TypeScript app (the old `src/`, `worker/`, `package.json`, `vite.config.ts`
are untouched — cutover/deletion is Phase H, see [Remaining work](#remaining-work)).
The Solidity contracts in `contracts/` are unchanged and out of scope.

The full design + phase-by-phase log is in the plan file:
`~/.claude/plans/i-want-to-migrate-cozy-fiddle.md`.

## TL;DR status

Functionally complete and verified **except one thing**: the `window.nockchain`
Iris-extension bridge (signing + tx broadcast). Everything converges on it, and it's
the piece that genuinely needs livenet validation (a real Iris extension + funded
wallet + node). Build it / debug it on livenet to finish.

- 6 Rust crates, all building native + `wasm32-unknown-unknown`, clippy-clean, ~75 tests.
- Protocol core **parity-validated byte-for-byte** against the original (iris-sdk/rose-wasm).
- The Rust Worker is validated against the **real Cloudflare runtime** (`wrangler dev`).
- The Leptos SPA **builds + serves**, and the create→list→open flow works in-browser.

## Crate map (`crates/`)

| Crate | Ports | Status |
|---|---|---|
| `swap-core` | `swap.ts`, `contract.ts`, `swaps.ts`, `roles.ts`, `price.ts`, `session.ts`, `verify.ts`, hashes | Done — 47 tests + parity. The shared kernel (also used by the worker), no JS interop. |
| `swap-client` | `swap-api.ts`, `swap-repo.ts`, `memory-kv.ts`, `auth.ts` | Done (plumbing) — `MemorySwapApi` (dev), `HttpSwapApi` (wasm, worker), `Signer` seam. 6 tests. |
| `swap-evm` | `evm/htlc.ts`, `evm/preimage.ts` | Done — alloy ABIs + `to_atomic`/keccak/decoders (9 tests) + wasm EIP-1193 bridge (`provider.rs`). |
| `swap-nock` | `nock/tx.ts` (lock/lock-root/gift-name), preimage gen, gRPC client | Partial — deterministic core done + parity (13 tests); tx build/sign deferred. |
| `swap-worker` | `worker/src/*` | Done — workers-rs 0.8, **14-endpoint live `wrangler dev` smoke** (`smoke.sh`). |
| `swap-web` | `src/ui/*`, `main.tsx` | App shell done — Router, SessionCtx, WalletBar, Dashboard, NewSwap, SwapView, LogBox + styling. On-chain wizard steps pending the bridge. |

### Crucial dependency note
The Nockchain crypto crates come from the **`nocktoshi/rose-rs` fork** @
`f3a46016794200580e64412ed7ef2045e48337fc` (branch `fix/hax-hash`), **not** upstream
`nockbox/iris-rs`. The fork carries the structural hax-hash fix without which **every
HTLC claim fails** (`v1-spend-1-lock-failed`). See `crates/swap-core` / the
`iris-rs-hax-fix` memory. Pinned in the root `Cargo.toml`.

## Build / run / test

Prereqs: Rust 1.96 + `wasm32-unknown-unknown` (pinned in `rust-toolchain.toml`); a
modern `protoc` (`.cargo/config.toml` points `PROTOC` at brew `protobuf` — adjust per
machine); `git` for the rose-rs SSH/HTTPS dep. For the worker: `cargo install
worker-build` + `npx wrangler`.

```sh
# Libs — native unit + parity tests (the verifiable core)
cargo test -p swap-core -p swap-client -p swap-evm -p swap-nock

# gRPC client (gated behind a feature to avoid a wasm-streams clash with leptos)
cargo build -p swap-nock --features grpc --target wasm32-unknown-unknown

# SPA
cd crates/swap-web && trunk serve --port 5173      # or `trunk build` → dist/

# Worker (local, simulated KV; .dev.vars holds SESSION_SECRET)
cd crates/swap-worker && wrangler dev               # then: bash smoke.sh
```

## Parity harness (the oracle — no live node needed)

The protocol-critical functions are validated against the **original** TS impl. The
original is cloned at `/Users/callen/work/third-party/atomic-nock-original`.

```sh
# 1. regenerate golden vectors from the original (iris-sdk/rose-wasm):
cd /Users/callen/work/third-party/atomic-nock-original
#    (deps installed from the PUBLIC npm registry — the Indeed mirror blocks
#     wrangler/cloudflare-types; a fetch-polyfill in the test loads the wasm under Node)
npx vitest run --config vitest.parity.config.ts     # → crates/swap-nock/tests/fixtures/parity.json
# 2. assert the Rust crates reproduce them byte-for-byte:
cd /Users/callen/work/third-party/atomic-nock && cargo test -p swap-nock --test parity
```

Validated vectors: `hash_preimage` (structural hax), `hash_public_key`, **HTLC lock
root**, `keccak256` (hEvm), `to_atomic`, `encode_swap_params`. **Extend this** — add a
vector per newly-ported function (tx-id calc, note parsing) and assert parity.

## Remaining work

### 1. The `window.nockchain` Iris bridge (the convergence point — needs livenet)
This single bridge unblocks everything else. It must provide:
- **A `swap_client::Signer` impl** (`sign_for_worker(message) -> {pubkey_hex, c, s}`) →
  unblocks `HttpSwapApi` auth so the SPA talks to the deployed worker.
- **Tx signing + broadcast** for the nock layer below.

The native iris-rs API is already mapped (see the plan, Phase E, and
`iris-wasm/src/{tx.rs,grpc.rs,noun.rs}` in the rose-rs checkout):
`TxBuilder::new/spend/recalc_and_set_fee/add_preimage(cue(jam))/sign/build` →
`raw_tx_to_protobuf` → `NockGrpc::send_transaction`; `SpendBuilder::new(note,
lock.zip(idx), refund_lock)/seed/compute_refund`.

### 2. Nock tx build/sign/broadcast (`crates/swap-nock`, deferred — task #20)
Port `nock/{lock,claim,refund,balance,sign,wallet}.ts`. Protocol-fragile (the TS is
full of hard-won fixes: Number-vs-String timelock, hax hash, spend-name source
patching). Needs a real `pb::Note` (from a node's balance RPC or a captured fixture)
to test — fabricating one isn't cheap. Validate via: parity vectors (tx-id, note
parsing) + a **mock Nockchain gRPC server** (native `tonic`) for the broadcast flow +
livenet. Reference for the node API: `~/work/nockchain`; gRPC-Web gateway:
`envoy-local.yaml` in the rose-rs repo.

### 3. SPA wiring
Once the bridge lands: wire the on-chain wizard step actions (lock NOCK / lock USDC /
withdraw / claim), the full Seller/Buyer wizard step flows, ENS resolution
(`name-resolve.ts`, over an HTTP provider), and a browser interaction test
(`wasm-bindgen-test` headless). Switch `swap-web` from `MemorySwapApi` to `HttpSwapApi`
when a worker URL is configured.

### 4. Phase H — cutover (verifiable, no livenet)
Repoint deploy (Cloudflare Pages `trunk build`; `wrangler deploy` for the worker),
env/config (Vite `VITE_*` → build-time/runtime config), release build + `wasm-opt`
(the debug SPA wasm is ~4.4 MB), a CI workflow (clippy + tests + `trunk build` +
`worker-build`), the Trunk dev gRPC proxy (a Phase-A probe suggested the origin/referer
spoof the old Vite proxy did is NOT server-enforced, so the plain `[[proxy]]` is likely
enough — confirm with a real gRPC-web call), then delete the old TS (`src/`,
`worker/src/*.ts`, `package.json`, `vite.config.ts`, …).

## Livenet acceptance (for the original dev)
Run a full HTLC swap against the deployed Base contract + real Nockchain RPC, two
wallets: seller create→lock NOCK→withdraw USDC (reveal preimage); buyer claim→lock
USDC→claim NOCK; plus both refund paths after the timelocks. Confirm tx-ids match the
node and the worker state machine advances with correct `version` bumps.
