<img width="616" height="176" alt="image" src="https://github.com/user-attachments/assets/702681c9-6bc1-4e9e-8a68-32d55a57bcc1" />

# Atomic Nock

Trustless, non-custodial swap of native **NOCK** on Nockchain ↔ **USDC** or **wNOCK** on **Base mainnet**, using hash-time-locked contracts on both chains. No custodian, no KYC, no shared secret in the browser.

## How it works

A swap is anchored by a random **preimage** the seller generates locally. From it: `H_evm = keccak256(jam)` (the Base hashlock) and `H_nock = hashNoun(jam)` (the Nockchain hashlock). The preimage never leaves the seller's browser until step 5, where revealing it on Base is what lets the buyer claim NOCK.

Swaps are posted **open** — nobody types an address; addresses always come from the connected wallets:

1. **Seller posts an open swap** — NOCK amount + quote amount (USDC or wNOCK). Seller's Nockchain + Base addresses come from their wallets. Shareable link: `/swap/<id>`. The swap also appears on the public **Marketplace**.
2. **Buyer claims** — opens the link (or finds the swap on `/market`), connects wallets, clicks *Claim*. Their Nockchain pkh is taken from their **authenticated session** (can't be spoofed) and committed once.
3. **Seller locks NOCK** in the Nockchain HTLC (claim branch = buyer pkh + `hax` preimage; refund branch = seller pkh after a block height).
4. **Buyer locks USDC/wNOCK** in [`AtomicNock`](contracts/src/AtomicNock.sol) on Base against `H_evm`.
5. **Seller withdraws** with `withdraw(swapId, preimageJam)` → the preimage is now public in the Base tx calldata.
6. **Buyer claims NOCK** — reads the preimage from that Base withdraw tx and claims on Nockchain.

If either side stalls, timelocks let each party refund their own leg.

## Architecture

| Layer | What |
|---|---|
| **Web** (`src/`) | React + React Router SPA (Vite). Iris (Nockchain) + MetaMask (Base) connect from a wallet bar; per-step wizards drive each side of the swap. |
| **Swap API** (`worker/`) | A Cloudflare Worker. Owns the swap state machine, authorizes writes by **Iris-signed session**, and verifies Nockchain signatures with `rose-wasm`. |
| **Storage** | Swap **metadata** in Cloudflare KV (non-secret; 30-day TTL, refreshed on each write). The **preimage** stays client-side in IndexedDB — never on the server. |
| **Contract** (`contracts/`) | Foundry HTLC `AtomicNock.sol` on Base: `lock`, `withdraw(id, preimage)`, `refund`. One instance per quote token (USDC, wNOCK). |

`iris-wasm` / `rose-wasm` ship as npm packages (`@nockbox/iris-sdk`, `@nockchain/rose-wasm`) — no source build. Nockchain txs are built in-browser and signed in the Iris extension (`nock_connect`, `nock_signTx`, `nock_signMessage`); Base txs use MetaMask.

### Security model

- **No shared write secret in the browser.** Writes are authorized by an **Iris-signed session**: the user signs one challenge with their wallet, the Worker verifies the Nockchain signature (`rose-wasm`) and binds it to the pkh, then issues a 7-day token (persisted in `localStorage` — sign once).
- **The Worker enforces integrity**, so a malicious client can't tamper with an in-flight swap: immutable economic terms, per-party field writes, single-commit buyer claim, and protocol **ordering invariants** (e.g. you can't lock USDC before NOCK is locked).
- **Rate limiting** via Workers native rate-limiting bindings (60 reads/min per IP, 20 writes/min per session, 10 auth attempts/min per IP). Exceeding any limit returns `429` with `Retry-After: 60`.
- The **on-chain HTLCs are the ultimate guard** — the KV record is just coordination metadata.

## Features

### Multi-asset swaps

The seller picks **USDC** or **wNOCK** ([`0x9B5E262cF9bb04869ab40b19AF91D2dc85761722`](https://basescan.org/address/0x9B5E262cF9bb04869ab40b19AF91D2dc85761722)) as the quote token. Both use the same `AtomicNock.sol` bytecode deployed at different addresses. Existing USDC swaps are unaffected — `token` absent in a swap record defaults to USDC.

| Quote | Contract | Decimals |
|---|---|---|
| USDC | [`0x5ac37e7A63b107d226d0b88129B8EB8b07172B75`](https://basescan.org/address/0x5ac37e7A63b107d226d0b88129B8EB8b07172B75#code) | 6 |
| wNOCK | set `VITE_HTLC_ADDRESS_WNOCK` after deploying | 16 |

### Marketplace

`/market` lists all unclaimed open orders anyone can browse without signing in. Each card shows NOCK amount, quote price, seller (NNS-resolved), age, and expiry. "Fill order" drops directly into the existing buyer claim flow. Sellers can cancel their own unclaimed orders from the dashboard or the swap detail page.

### Notifications

Users opt in per-channel from `/settings`. Notifications fire on every swap state transition (claim, NOCK locked, quote locked, preimage revealed, complete, refunds) via `ctx.waitUntil` — failures never block swap writes.

| Channel | How |
|---|---|
| **Telegram** | Deep-link flow: generate a code in Settings → open `t.me/<bot>?start=<code>` → bot confirms and binds. |
| **Browser push** | Service worker + Web Push (RFC-8291 VAPID). Enable in Settings → browser permission prompt. |
| **Email** | Resend. Add address in Settings → 6-digit verification code → verified address receives mail. |

### User profiles

A per-wallet profile (Cloudflare KV, no TTL) stores notification prefs and settings. Accessed via `GET/PUT /profile` with the signed session.

**Custom Nockchain RPC**: Settings lets you point the app at your own Nockchain gRPC-Web node. The URL is stored in `localStorage` for immediate effect and synced to your profile for cross-device access. Reset to default at any time.

## Repo layout

```
src/            React app (Vite)
  ui/           wallet bar, dashboard, seller/buyer wizards, marketplace, settings
  app/          session/auth, swap repo (KV reads + authed write API), push, settings
  nock/  evm/   Nockchain + Base tx building / signing
  actions/      swap steps (generate / lock / withdraw / claim / refund)
public/         static assets including sw.js (service worker for push notifications)
worker/         Cloudflare Worker — swap API, sessions, integrity, notifications, profiles
contracts/      Foundry HTLC (AtomicNock.sol)
```

## Local dev

Prerequisites: **Node ≥ 20.19** (Vite 8), the [Iris wallet](https://github.com/nockbox/iris) extension, and MetaMask on **Base mainnet** (chain id 8453).

```bash
# 1. Install
npm install

# 2. Env — defaults are fine for local dev
cp .env.example .env
#    VITE_KV_URL=http://localhost:8787   → use the local dev worker (below)
#    VITE_KV_URL=                        → ephemeral in-memory store, no worker needed

# 3. Terminal A — local swap API (isolated local KV; never touches production)
npm --prefix worker run dev      # http://localhost:8787

# 4. Terminal B — web app
npm run dev                      # http://localhost:5173
```

Then connect **Iris** and **MetaMask**; you'll sign in once at connect, and can create / claim swaps.

The Nockchain gRPC-Web calls are proxied by the Vite dev server to `VITE_NOCK_GRPC_UPSTREAM` (default `rpc.nockchain.net`) — no Envoy or local node required. You can override this per-session in Settings → Custom RPC.

> The dev worker uses `worker/wrangler.dev.toml` + `worker/.dev.vars` (`SESSION_SECRET`). `wrangler dev` runs in **local mode** and simulates KV under `worker/.wrangler/state` — it never touches the production namespace. Delete `worker/.wrangler/` to reset dev data.

## Environment

### Frontend (`.env`)

| Variable | Purpose |
|---|---|
| `VITE_KV_URL` | Swap API URL. Local: `http://localhost:8787`. Empty: in-memory. Prod: deployed Worker URL. |
| `VITE_HTLC_ADDRESS` | Deployed `AtomicNock` on Base for USDC swaps. |
| `VITE_HTLC_ADDRESS_WNOCK` | Deployed `AtomicNock` for wNOCK swaps. Empty = wNOCK option hidden. |
| `VITE_NOCK_GRPC_UPSTREAM` | Vite proxy target for Nockchain gRPC-Web (default `https://rpc.nockchain.net`). |
| `VITE_ETH_RPC_URL` | Mainnet RPC for ENS lookups — must allow CORS (optional; has a default). |
| `VITE_PRICE_URL` | NOCK/USD price feed (optional; empty = hidden). |
| `VITE_VAPID_PUBLIC_KEY` | VAPID public key for browser push. Empty = push option hidden in Settings. |

There is **no** `VITE_KV_TOKEN` — writes are authorized per-user by signature, not a shared token.

### Worker secrets (`wrangler secret put`)

| Secret | Purpose |
|---|---|
| `SESSION_SECRET` | HMAC key for Iris session tokens (32+ random bytes). |
| `TELEGRAM_BOT_TOKEN` | From @BotFather — authorizes Bot API calls. |
| `TELEGRAM_WEBHOOK_SECRET` | Random string registered with `setWebhook`; validates incoming updates. |
| `VAPID_PRIVATE_KEY` | VAPID ES256 private key for browser push encryption. |
| `RESEND_API_KEY` | Resend API key for sending verification and notification emails. |

### Worker vars (`wrangler.toml` or dashboard)

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_NAME` | Bot username (without `@`) for deep-link URL construction. |
| `VAPID_PUBLIC_KEY` | Must match `VITE_VAPID_PUBLIC_KEY`. |
| `VAPID_SUBJECT` | VAPID contact (`mailto:` or `https:` URL). |
| `EMAIL_FROM` | Sender address for Resend emails (must match verified Resend domain). |
| `APP_URL` | Canonical app URL (e.g. `https://atomicnock.com`) used in notification links. |

## Deploy

### Worker (swap API)

Requires the Cloudflare **Workers Paid** plan: the `rose-wasm` verifier is ~1 MB gzipped, over the free-tier 1 MB Worker limit.

```bash
cd worker
wrangler kv namespace create SWAPS   # once — paste the id into wrangler.toml
wrangler secret put SESSION_SECRET   # a random 32+ byte secret
wrangler deploy
```

#### Notifications setup (optional)

**Telegram**:
```bash
# 1. Create a bot via @BotFather → copy the token
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any random string

# 2. Register the webhook (replace placeholders)
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://api.atomicnock.com/tg/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

**Browser push**:
```bash
npx web-push generate-vapid-keys
# → paste public key into VITE_VAPID_PUBLIC_KEY (.env) and VAPID_PUBLIC_KEY (worker var)
wrangler secret put VAPID_PRIVATE_KEY
# set VAPID_SUBJECT to mailto:you@example.com (worker var)
```

**Email (Resend)**:
```bash
# 1. Create account at resend.com, verify your sending domain (SPF/DKIM)
wrangler secret put RESEND_API_KEY
# set EMAIL_FROM to noreply@yourdomain.com (worker var)
```

### Web app

```bash
npm run build        # → dist/ (static)
# Host dist/ (e.g. Cloudflare Pages). Set VITE_KV_URL to the deployed Worker URL,
# VITE_HTLC_ADDRESS and VITE_HTLC_ADDRESS_WNOCK to the deployed contracts.
```

### Contract (Base)

```bash
cp .env.example .env          # set DEPLOYER_PRIVATE_KEY (fund with Base ETH), BASESCAN_API_KEY
make deploy-base-dry          # simulate
make deploy-base              # broadcast → paste address into VITE_HTLC_ADDRESS

# wNOCK instance (same bytecode, different token):
TOKEN_ADDRESS=0x9B5E262cF9bb04869ab40b19AF91D2dc85761722 make deploy-base
# → paste address into VITE_HTLC_ADDRESS_WNOCK
```

USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
wNOCK on Base: `0x9B5E262cF9bb04869ab40b19AF91D2dc85761722`.

## Tests

```bash
npm test                       # web app unit tests (vitest)
npm --prefix worker run test   # worker integrity / ordering-invariant / profile tests
cd contracts && forge test     # HTLC contract tests (Foundry)
```

## Caveats

- **Not audited.** This is mainnet — use small amounts.
- The shared swap record holds **hashes and params only** — never the preimage. The buyer learns the secret from the seller's Base `withdraw` transaction.
- A 7-day session token in `localStorage` is XSS-exposed (standard dApp tradeoff); it only authorizes writes to that wallet's own swaps.
- Swap records expire 30 days after last activity. On-chain state is always authoritative — expiry only affects the coordination metadata.
- Browser push requires HTTPS and a registered service worker. iOS Safari requires the PWA to be installed to the home screen.
