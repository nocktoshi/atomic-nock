# Atomic Nock (Rust + Leptos) — common dev/deploy tasks.
# Run `just` (or `just --list`) to see everything. See docs/BUILD_AND_DEPLOY.md.

web      := "crates/swap-web"
worker   := "crates/swap-worker"
libs     := "-p swap-core -p swap-client -p swap-evm -p swap-nock"
wasm     := "--target wasm32-unknown-unknown"
original := "../atomic-nock-original"     # the reference clone, for parity tests
wrangler := "npx wrangler"                 # or set to "wrangler" if installed globally

# List available recipes
default:
    @just --list

# === dev ===

# Serve the SPA with hot reload — http://localhost:5173
dev-web:
    cd {{web}} && trunk serve --port 5173

# Run the Worker locally with simulated KV — http://localhost:8787
dev-worker:
    cd {{worker}} && {{wrangler}} dev

# Run the SPA + Worker together (Ctrl-C stops both)
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd {{worker}} && {{wrangler}} dev) &
    (cd {{web}} && trunk serve --port 5173) &
    wait

# === test / lint ===

# Native unit + parity tests for the library crates
test:
    cargo test {{libs}}

# Clippy on the libs (native) + the wasm artifacts
clippy:
    cargo clippy {{libs}}
    cargo clippy -p swap-web -p swap-worker {{wasm}}

# Format all Rust code
fmt:
    cargo fmt

# Check formatting without writing (CI)
fmt-check:
    cargo fmt --check

# Smoke-test the Worker API (run `just dev-worker` in another shell first)
smoke:
    bash {{worker}}/smoke.sh

# Regenerate the parity fixture from the original TS impl, then verify in Rust
parity:
    cd {{original}} && npx vitest run --config vitest.parity.config.ts
    cargo test -p swap-nock --test parity

# Build the Nockchain gRPC client (needs a modern protoc; see .cargo/config.toml)
grpc-check:
    cargo build -p swap-nock --features grpc {{wasm}}

# === build ===

# Release build of the SPA -> crates/swap-web/dist
build-web:
    cd {{web}} && trunk build --release

# Release build of the Worker -> crates/swap-worker/build
build-worker:
    cd {{worker}} && worker-build --release

# Build both deployable artifacts
build: build-web build-worker

# === deploy ===

# Deploy the Worker (runs worker-build --release, then uploads)
deploy-worker:
    cd {{worker}} && {{wrangler}} deploy

# Build + deploy the SPA to Cloudflare Pages (override the project name if needed)
deploy-web project="atomic-nock":
    cd {{web}} && trunk build --release
    {{wrangler}} pages deploy {{web}}/dist --project-name {{project}}

# === misc ===

# Remove build outputs
clean:
    cargo clean
    rm -rf {{web}}/dist {{worker}}/build
