# Atomic Nock — Build & Deploy (Rust + Leptos)

This is the Rust + Leptos port. It's a Cargo workspace (`crates/`) producing two
deployable artifacts:

| Artifact | Crate | Built by | Runtime |
|---|---|---|---|
| **SPA** (static site) | `swap-web` | Trunk → `dist/` | any static host (e.g. Cloudflare Pages) |
| **Swap API** (Worker) | `swap-worker` | worker-build → `build/worker/shim.mjs` | Cloudflare Workers + KV |

Shared logic lives in `swap-core` (protocol/state machine/sessions), `swap-client`
(client persistence + auth), `swap-evm` (Base/EVM), `swap-nock` (Nockchain). The
Solidity HTLC in `contracts/` is unchanged and deployed separately (Foundry).

> **Read this first — production readiness.** The build/deploy *mechanics* below
> are complete and tested. But two integrations are still pending (they need the
> `window.nockchain` wallet bridge + livenet validation, owned by the protocol
> dev — see `HANDOFF.md`):
> 1. The SPA currently uses the **in-memory dev repo** (`MemorySwapApi`), so a
>    deployed SPA does **not yet** talk to the deployed Worker. `HttpSwapApi`
>    exists in `swap-client` but isn't wired in until the signer lands.
> 2. The **on-chain swap steps** (lock/claim/refund) aren't wired end-to-end.
>
> So deploying today gives you the real UI + a functional Worker API, but not a
> complete on-chain swap. Everything in this doc still applies — it's how you
> ship the pieces.

---

## Prerequisites

- **Rust toolchain** — pinned by `rust-toolchain.toml` (1.96 + `wasm32-unknown-unknown`).
  `rustup` installs it automatically on first build. Just have `rustup`.
- **git** — the Nockchain crypto crates are a git dependency
  (`nocktoshi/rose-rs`, pinned in the root `Cargo.toml`; public, fetched over HTTPS).
- **Trunk** (SPA bundler): `cargo install --locked trunk` (or `brew install trunk`).
- **worker-build** (Worker bundler): `cargo install worker-build`.
- **wrangler** (Cloudflare CLI): `npm i -g wrangler` or use `npx wrangler`.
- **protoc** — *only* needed to build the Nockchain gRPC client
  (`swap-nock --features grpc`); the SPA and Worker don't enable it. If you build
  with `grpc`, install a modern `protobuf` (≥ 3) and point `PROTOC` at it (see
  `.cargo/config.toml`). A stale `protoc 2.5.0` on `PATH` will fail on proto3.

Sanity check:
```sh
rustc --version            # 1.96.x
trunk --version            # 0.21+
worker-build --version
npx wrangler --version
```

---

## Local development

### Frontend (SPA)
```sh
cd crates/swap-web
trunk serve --port 5173        # http://localhost:5173, rebuilds on change
```
`Trunk.toml` proxies the two `/nockchain.*` gRPC-Web paths to `rpc.nockchain.net`
for dev. The create→list→open flow works in-browser against the in-memory repo
(no Worker or wallet required); "Connect MetaMask" uses the real EIP-1193 bridge.

### Worker (Swap API)
```sh
cd crates/swap-worker
echo 'SESSION_SECRET=dev-only-secret' > .dev.vars   # if not present
wrangler dev                                          # http://localhost:8787
```
`wrangler dev` runs in local mode: KV is simulated on disk under
`.wrangler/state` and never touches production. Smoke-test every endpoint:
```sh
bash crates/swap-worker/smoke.sh      # 14 endpoint checks against wrangler dev
```

### Tests
```sh
# Native unit + parity tests (the verified core). Test the lib crates explicitly —
# swap-web/swap-worker are wasm-only (built by Trunk/worker-build), not host-testable.
cargo test -p swap-core -p swap-client -p swap-evm -p swap-nock

# Lint (both targets)
cargo clippy -p swap-core -p swap-client -p swap-evm -p swap-nock
cargo clippy -p swap-web -p swap-worker --target wasm32-unknown-unknown

# Optional: gRPC client (needs protoc)
cargo build -p swap-nock --features grpc --target wasm32-unknown-unknown
```
Regenerating the parity fixture (golden vectors from the original TS impl) is
documented in `HANDOFF.md`.

---

## Production build

### SPA
```sh
cd crates/swap-web
trunk build --release          # → crates/swap-web/dist/
```
Release uses the workspace `[profile.release]` (`opt-level="z"`, `lto`,
`panic="abort"`) and Trunk runs `wasm-opt`, producing hashed, minified assets in
`dist/` (`index.html`, `*_bg.wasm`, `*.js`, `style-*.css`, `assets/`).

`dist/` is a plain static site — host it anywhere. **Client-side routing**
(`/swap/:id`, `/dashboard`) needs a SPA fallback so deep links resolve: serve
`index.html` for unknown paths. On Cloudflare Pages add a `_redirects` file:
```
/*  /index.html  200
```

### Worker
```sh
cd crates/swap-worker
wrangler deploy                # runs `worker-build --release` (see [build]) then uploads
```

---

## Deploy

### 1. Worker (Swap API)

Before the first prod deploy, edit `crates/swap-worker/wrangler.toml`:

```toml
name = "atomic-nock"                 # rename from "atomicnock-dev"
main = "build/worker/shim.mjs"
compatibility_date = "2024-11-01"

[build]
command = "worker-build --release"

[[kv_namespaces]]
binding = "SWAPS"
id = "<your-prod-kv-id>"             # from the command below

# Optional custom domain / route:
# [[routes]]
# pattern = "api.atomicnock.com"
# zone_name = "atomicnock.com"
# custom_domain = true
```

Provision + deploy:
```sh
# one-time: create the prod KV namespace, paste its id into wrangler.toml
wrangler kv namespace create SWAPS

# one-time: set the session-signing secret (NOT in .dev.vars / git)
wrangler secret put SESSION_SECRET           # paste a long random value

cd crates/swap-worker && wrangler deploy
```
The Worker serves `/auth/*`, `/swap`, `/swap/:id[/claim|/advance]`, `/list` with
CORS open for reads and Iris-signed sessions for writes.

### 2. SPA (static site)

**Cloudflare Pages (CLI):**
```sh
cd crates/swap-web && trunk build --release
wrangler pages deploy dist --project-name atomic-nock
```

**Cloudflare Pages (Git integration):** set
- Build command: `cd crates/swap-web && trunk build --release`
  (the build image needs Rust + `trunk` + the wasm target installed first)
- Output directory: `crates/swap-web/dist`
- Add the `_redirects` SPA fallback above.

Any static host (Netlify, S3+CloudFront, nginx) works the same way: serve
`dist/` with an SPA fallback to `index.html`.

---

## Configuration

Config currently lives as **compile-time constants** in the Rust source (the old
`VITE_*` env vars haven't been re-plumbed yet — that's the Phase H "runtime/build
config" task). To target a different chain/contract/endpoints, edit and rebuild:

| What | Where |
|---|---|
| Base chain id, USDC + HTLC contract addresses, default fee bps | `crates/swap-evm/src/config.rs` |
| NOCK/USD price feed URL | `crates/swap-web/src/app.rs` (`PRICE_URL`) |
| NockNames + ENS resolver URLs (wallet name resolution) | `crates/swap-client/src/name_resolve.rs` |
| Dev gRPC-Web proxy target | `crates/swap-web/Trunk.toml` (`[[proxy]]`) |
| Worker name / KV id / route / `SESSION_SECRET` | `crates/swap-worker/wrangler.toml` + `wrangler secret`/`.dev.vars` |

**Pointing the SPA at the deployed Worker (when ready):** the SPA builds the
`SwapRepository` over `MemorySwapApi` today (`crates/swap-web/src/session.rs`).
Swapping in `HttpSwapApi::new(worker_url, signer)` makes it use the real Worker —
this is gated on the `window.nockchain` signer (see `HANDOFF.md`).

**gRPC-Web for the browser:** the production SPA reaches the Nockchain RPC via a
gRPC-Web gateway (Envoy; see `envoy-local.yaml` in the rose-rs repo). The dev
Trunk proxy stands in for this locally.

---

## CI (suggested)

```sh
cargo clippy -p swap-core -p swap-client -p swap-evm -p swap-nock -- -D warnings
cargo clippy -p swap-web -p swap-worker --target wasm32-unknown-unknown -- -D warnings
cargo test  -p swap-core -p swap-client -p swap-evm -p swap-nock
(cd crates/swap-web    && trunk build --release)
(cd crates/swap-worker && worker-build --release)
```

See `HANDOFF.md` for architecture + the remaining livenet-gated work, and
`~/.claude/plans/i-want-to-migrate-cozy-fiddle.md` for the full migration log.
