<img width="616" height="176" alt="image" src="https://github.com/user-attachments/assets/702681c9-6bc1-4e9e-8a68-32d55a57bcc1" />

# Atomic Nock

Trustless, non-custodial swap of native **NOCK** on Nockchain ↔ **USDC** on **Base mainnet**, using hash-time-locked contracts on both chains. No custodian, no KYC, no shared secret in the browser.

## How it works

A swap is anchored by a random **preimage** the seller generates locally. From it: `H_evm = keccak256(jam)` (the Base hashlock) and `H_nock = hashNoun(jam)` (the Nockchain hashlock). The preimage never leaves the seller's browser until step 5, where revealing it on Base is what lets the buyer claim NOCK.

Swaps are posted **open** — nobody types an address; addresses always come from the connected wallets:

1. **Seller posts an open swap** — NOCK amount + USDC price. Seller's Nockchain + Base addresses come from their wallets. Shareable link: `/swap/<id>`.
2. **Buyer claims** — opens the link, connects wallets, clicks *Claim*. Their Nockchain pkh is taken from their **authenticated session** (can't be spoofed) and committed once.
3. **Seller locks NOCK** in the Nockchain HTLC (claim branch = buyer pkh + `hax` preimage; refund branch = seller pkh after a block height).
4. **Buyer locks USDC** in [`NockOtcHtlc`](contracts/src/NockOtcHtlc.sol) on Base against `H_evm`.
5. **Seller withdraws USDC** with `withdraw(swapId, preimageJam)` → the preimage is now public in the Base tx calldata.
6. **Buyer claims NOCK** — reads the preimage from that Base withdraw tx and claims on Nockchain.

If either side stalls, timelocks let each party refund their own leg.

## Architecture

| Layer | What |
|---|---|
| **Web** (`src/`) | React + React Router SPA (Vite). Iris (Nockchain) + MetaMask (Base) connect from a wallet bar; per-step wizards drive each side of the swap. |
| **Swap API** (`worker/`) | A Cloudflare Worker. Owns the swap state machine, authorizes writes by **Iris-signed session**, and verifies Nockchain signatures with `rose-wasm`. |
| **Storage** | Swap **metadata** in Cloudflare KV (non-secret). The **preimage** stays client-side in IndexedDB — never on the server. |
| **Contract** (`contracts/`) | Foundry HTLC `NockOtcHtlc.sol` on Base: `lock`, `withdraw(id, preimage)`, `refund`. |

`iris-wasm` / `rose-wasm` ship as npm packages (`@nockbox/iris-sdk`, `@nockchain/rose-wasm`) — no source build. Nockchain txs are built in-browser and signed in the Iris extension (`nock_connect`, `nock_signTx`, `nock_signMessage`); Base txs use MetaMask.

### Security model

- **No shared write secret in the browser.** Writes are authorized by an **Iris-signed session**: the user signs one challenge with their wallet, the Worker verifies the Nockchain signature (`rose-wasm`) and binds it to the pkh, then issues a 7-day token (persisted in `localStorage` — sign once).
- **The Worker enforces integrity**, so a malicious client can't tamper with an in-flight swap: immutable economic terms, per-party field writes, single-commit buyer claim, and protocol **ordering invariants** (e.g. you can't lock USDC before NOCK is locked).
- The **on-chain HTLCs are the ultimate guard** — the KV record is just coordination metadata.

## Repo layout

```
src/            React app (Vite)
  ui/           wallet bar, dashboard, seller/buyer wizards
  app/          session/auth, swap repo (KV reads + authed write API), storage
  nock/  evm/   Nockchain + Base tx building / signing
  actions/      swap steps (generate / lock / withdraw / claim / refund)
worker/         Cloudflare Worker — swap API (sessions, integrity, rose-wasm verify)
contracts/      Foundry HTLC (NockOtcHtlc.sol)
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

The Nockchain gRPC-Web calls are proxied by the Vite dev server to `VITE_NOCK_GRPC_UPSTREAM` (default `rpc.nockchain.net`) — no Envoy or local node required.

> The dev worker uses `worker/wrangler.dev.toml` + `worker/.dev.vars` (`SESSION_SECRET`). `wrangler dev` runs in **local mode** and simulates KV under `worker/.wrangler/state` — it never touches the production namespace. Delete `worker/.wrangler/` to reset dev data.

## Environment

| Variable | Purpose |
|---|---|
| `VITE_KV_URL` | Swap API URL. Local: `http://localhost:8787`. Empty: in-memory. Prod: deployed Worker URL. |
| `VITE_HTLC_ADDRESS` | Deployed `NockOtcHtlc` on Base (default is the current deployment). |
| `VITE_NOCK_GRPC_UPSTREAM` | Vite proxy target for Nockchain gRPC-Web (default `https://rpc.nockchain.net`). |
| `VITE_ETH_RPC_URL` | Mainnet RPC for ENS lookups — must allow CORS (optional; has a default). |
| `VITE_PRICE_URL` | NOCK/USD price feed (optional; empty = hidden). |
| `BASE_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `BASESCAN_API_KEY`, `TREASURY_ADDRESS` | Contract deploy only. |

There is **no** `VITE_KV_TOKEN` — writes are authorized per-user by signature, not a shared token.

## Deploy

### Worker (swap API)

Requires the Cloudflare **Workers Paid** plan: the `rose-wasm` verifier is ~1 MB gzipped, over the free-tier 1 MB Worker limit (well under the 10 MB paid limit).

```bash
cd worker
wrangler kv namespace create SWAPS   # once — paste the id into wrangler.toml
wrangler secret put SESSION_SECRET   # a random 32+ byte secret (HMAC key for sessions)
wrangler deploy                      # → e.g. https://api.atomicnock.com
```

### Web app

```bash
npm run build        # → dist/ (static)
# Host dist/ (e.g. Cloudflare Pages). Set VITE_KV_URL to the deployed Worker URL and
# VITE_HTLC_ADDRESS to the deployed contract.
```

### Contract (Base)

```bash
cp .env.example .env          # set DEPLOYER_PRIVATE_KEY (fund with Base ETH), BASESCAN_API_KEY
make deploy-base-dry          # simulate
make deploy-base              # broadcast → paste the address into VITE_HTLC_ADDRESS
```

USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## Tests

```bash
npm test                       # web app unit tests (vitest)
npm --prefix worker run test   # worker integrity / ordering-invariant tests
```

## Caveats

- **Not audited.** This is mainnet — use small amounts.
- The shared swap record holds **hashes and params only** — never the preimage. The buyer learns the secret from the seller's Base `withdraw` transaction.
- A 7-day session token in `localStorage` is XSS-exposed (standard dApp tradeoff); it only authorizes writes to that wallet's own swaps.
