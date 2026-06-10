// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AtomicNock} from "../src/AtomicNock.sol";

/// @notice Deploy to Base mainnet. One AtomicNock instance per quote token:
///         USDC  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (default)
///         wNOCK 0x9B5E262cF9bb04869ab40b19AF91D2dc85761722 (TOKEN_ADDRESS override)
contract Deploy is Script {
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (AtomicNock htlc) {
        uint256 key = _deployerKey();
        address deployer = vm.addr(key);
        // Quote token this instance escrows. Defaults to USDC; e.g.
        //   TOKEN_ADDRESS=0x9B5E... forge script ... --broadcast   (wNOCK instance)
        address token = vm.envOr("TOKEN_ADDRESS", BASE_USDC);
        // Treasury (fee recipient + sweep destination + admin). Defaults to the deployer.
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        vm.startBroadcast(key);
        htlc = new AtomicNock(token, treasury);
        vm.stopBroadcast();
        console2.log("AtomicNock", address(htlc));
        console2.log("token", token);
        console2.log("treasury/owner", treasury);
        console2.log(
            token == BASE_USDC
                ? "Add to .env: VITE_HTLC_ADDRESS="
                : "Add to .env: VITE_HTLC_ADDRESS_WNOCK=",
            address(htlc)
        );
    }

    /// @dev Set `DEPLOYER_PRIVATE_KEY` or `PRIVATE_KEY` in repo-root `.env` (0x-prefixed hex).
    function _deployerKey() internal view returns (uint256) {
        string memory raw = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(raw).length == 0) {
            raw = vm.envOr("PRIVATE_KEY", string(""));
        }
        require(bytes(raw).length > 0, "Set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY in .env");
        return vm.parseUint(raw);
    }
}