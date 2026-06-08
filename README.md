<img width="616" height="176" alt="image" src="https://github.com/user-attachments/assets/702681c9-6bc1-4e9e-8a68-32d55a57bcc1" />

# Atomic Nock

Cross-chain hash-time-locked swap: native **NOCK** on Nockchain (iris-wasm + `hax`) and **USDC** on **Base mainnet** (minimal HTLC).

## Architecture

1. **Seller** generates `preimageJam` locally, `H_nock = hashNoun(jam)`, `H_evm = keccak256(jam)` — preimage never leaves the seller browser until step 4.
2. **Seller** locks NOCK (claim: buyer `pkh` + `hax`; refund: seller `pkh`/`tim`) and shares **swap JSON (hashes only)**.
3. **Buyer** locks USDC in [`NockOtcHtlc`](contracts/src/NockOtcHtlc.sol) with `H_evm`.
4. **Seller** `withdraw(swapId, preimageJam)` on Base → preimage is public in the tx calldata.
5. **Buyer** reads `preimageJam` from that Base withdraw tx, then claims NOCK on Nockchain.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/)
- [Rust](https://rustup.rs/) + `wasm-pack` (`cargo install wasm-pack`)
- [Node.js](https://nodejs.org/) 20+
- [Envoy](https://www.envoyproxy.io/) (or Docker) for gRPC-Web
- [Envoy](https://www.envoyproxy.io/) proxying public **`rpc.nockchain.net:443`** (default) or a local node
- [Iris wallet](https://github.com/nockbox/iris) browser extension (Nockchain)
- MetaMask on **Base mainnet** (chain id 8453)

## Quick start

```bash
# 1. Build iris-wasm for the browser
make wasm

# 2. Install web deps
make install

# 3. Deploy HTLC to Base (optional until USDC step)
cp .env.example .env
# Set DEPLOYER_PRIVATE_KEY=0x... (wallet needs Base ETH)
make deploy-base-dry   # simulate first
make deploy-base       # broadcast
# Paste logged address into VITE_HTLC_ADDRESS in .env

# 4. Web UI (Vite proxies gRPC-Web to rpc.nockchain.net — no Envoy required in dev)
make dev
# Open http://localhost:5173 — leave proxy URL as http://localhost:5173

# Optional: Terminal A: Envoy → Nock gRPC (if not using Vite proxy)
# make envoy
```

## Web UI (wallets)

The app does **not** ask for seed phrases. Connect extensions on each side:

| Role | Nockchain | Base (USDC) |
|------|-----------|---------------|
| Seller | **Iris** — Connect Iris | **MetaMask** — Connect MetaMask |
| Buyer | **Iris** — Connect Iris | **MetaMask** — Connect MetaMask |

Nockchain txs are built in the browser and signed via `window.nockchain` (`nock_connect`, `nock_signRawTx`), matching [nock-names `use-wallet.js`](https://github.com/nocktoshi/nock-names/blob/master/src/hooks/use-wallet.js). EVM txs use MetaMask on Base (chain id 8453).

**Seller:** connect Iris → buyer **Nock pkh** → generate (preimage stays in session) → lock NOCK → share JSON (no preimage) → after buyer locks USDC, **withdraw USDC** on Base (reveals preimage on-chain).

**Buyer:** connect Iris (pkh matches JSON) → load JSON → lock USDC → **load preimage from Base** (withdraw tx or scan by swapId) → claim NOCK.

## Nockchain RPC (gRPC-Web)

**Dev (recommended):** `make dev` — Vite proxies `/nockchain.*` to **`rpc.nockchain.net`** (same pattern as [nock-names](https://github.com/nocktoshi/nock-names)). Set the UI proxy field to **`http://localhost:5173`** (default).

**Envoy (optional):** [`envoy.yaml`](envoy.yaml) → `rpc.nockchain.net:443`. `make envoy-nockchain` uses `rpc.nockchain.net` (often **403** from Cloudflare when run in Docker).

```bash
make envoy        # rpc.nockchain.net
make envoy-local  # 127.0.0.1:5557 (your node)
make envoy-nockchain  # rpc.nockchain.net
```

**Cloudflare 403?** Do not point the browser at `:8080` unless Envoy works from your network. Use the Vite dev URL (`http://localhost:5173`) or `make envoy-local`.

**Install Envoy** (optional if you have Docker):

```bash
brew install envoy
```

Or force Docker: `make envoy-docker`.

The web UI **gRPC-Web proxy** field should be `http://localhost:5173` during `make dev`, or `http://localhost:8080` if using Envoy.

## Environment

| Variable | Purpose |
|----------|---------|
| `VITE_ENVOY_URL` | gRPC-Web base URL (empty = same origin / Vite proxy in dev) |
| `VITE_NOCK_GRPC_UPSTREAM` | Vite proxy target (default `https://rpc.nockchain.net`) |
| `VITE_HTLC_ADDRESS` | Deployed `NockOtcHtlc` on Base |
| `BASE_RPC_URL` | Foundry deploy RPC |
| `DEPLOYER_PRIVATE_KEY` | Deployer key |

## Contract

- **USDC (Base):** `0xD347AC30A11abe63e92CFcb2285dC770FF0F7236`
- **Functions:** `lock(seller, amount, hashlock, timelock)`, `withdraw(id, preimageJam)`, `refund(id)`

```bash
cd contracts && forge test   # add tests later
cd contracts && forge build
```

## POC caveats

- **Not audited.** Use minimal USDC on mainnet.
- Swap JSON has **hashes and params only** — no `preimageJam`. Buyer learns the secret from the seller's Base `withdraw` transaction.
- Nockchain txs are built in-browser and **signed in the Iris extension** (no mnemonics in the web app).
- Nock input notes often need `pkh` + coinbase `tim(100)` unlock — fund notes accordingly.
- iris-wasm is vendored from [nockbox/iris-rs](https://github.com/nockbox/iris-rs); pin `vendor/iris-rs` for reproducible builds.

## Makefile targets

| Target | Description |
|--------|-------------|
| `make wasm` | Clone/build iris-wasm → `web/public/pkg` |
| `make envoy` | Run Envoy with `envoy.yaml` |
| `make dev` | Vite dev server |
| `make deploy-base` | Broadcast deploy script |
| `make forge-build` | Compile contracts |
