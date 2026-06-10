.PHONY: install dev build test worker-dev worker-test worker-deploy \
        forge-build forge-test deploy-base deploy-base-dry verify-base

# --- web app ---------------------------------------------------------------
install:
	npm install

dev:
	npm run dev

build:
	npm run build

test:
	npm test

# --- swap API worker (Cloudflare); run `make worker-dev` alongside `make dev` ---
worker-dev:
	npm --prefix worker run dev

worker-test:
	npm --prefix worker run test

worker-deploy:
	npm --prefix worker run deploy

# --- contracts (Foundry / Base) --------------------------------------------
forge-build:
	cd contracts && forge build

forge-test:
	cd contracts && forge test -vvv

deploy-base:
	@test -f .env || (echo "Create .env: cp .env.example .env"; exit 1)
	@set -a && . ./.env && set +a && \
	 if [ -z "$$DEPLOYER_PRIVATE_KEY" ] && [ -z "$$PRIVATE_KEY" ]; then \
	   echo "Set DEPLOYER_PRIVATE_KEY=0x... (or PRIVATE_KEY) in .env"; exit 1; \
	 fi && \
	 if [ -z "$$BASESCAN_API_KEY" ]; then \
	   echo "Warning: BASESCAN_API_KEY not set — deploying WITHOUT --verify"; \
	   cd contracts && forge script script/Deploy.s.sol:Deploy \
	     --rpc-url "$${BASE_RPC_URL:-https://mainnet.base.org}" --broadcast -vvv; \
	 else \
	   cd contracts && forge script script/Deploy.s.sol:Deploy \
	     --rpc-url "$${BASE_RPC_URL:-https://mainnet.base.org}" --broadcast \
	     --verify --etherscan-api-key "$$BASESCAN_API_KEY" -vvv; \
	 fi
	@echo "Copy NockOtcHtlc address from logs into VITE_HTLC_ADDRESS in .env"

# Re-verify an already-deployed contract: make verify-base ADDR=0x... TREASURY=0x...
verify-base:
	@test -n "$(ADDR)" || (echo "Usage: make verify-base ADDR=0x... [TREASURY=0x...]"; exit 1)
	@set -a && . ./.env && set +a && \
	 TREASURY=$${TREASURY:-$$TREASURY_ADDRESS} && \
	 cd contracts && forge verify-contract "$(ADDR)" \
	   src/NockOtcHtlc.sol:NockOtcHtlc --chain base \
	   --etherscan-api-key "$$BASESCAN_API_KEY" \
	   --constructor-args $$(cast abi-encode "constructor(address,address)" \
	     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "$$TREASURY") \
	   --watch

deploy-base-dry:
	@test -f .env || (echo "Create .env: cp .env.example .env"; exit 1)
	@set -a && . ./.env && set +a && \
	 cd contracts && forge script script/Deploy.s.sol:Deploy \
	   --rpc-url "$${BASE_RPC_URL:-https://mainnet.base.org}" -vvv