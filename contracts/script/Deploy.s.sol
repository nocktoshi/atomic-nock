// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {NockOtcHtlc} from "../src/NockOtcHtlc.sol";

/// @notice Deploy to Base mainnet. USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
contract Deploy is Script {
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (NockOtcHtlc htlc) {
        uint256 key = _deployerKey();
        address deployer = vm.addr(key);
        // Treasury (fee recipient + sweep destination + admin). Defaults to the deployer.
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        vm.startBroadcast(key);
        htlc = new NockOtcHtlc(BASE_USDC, treasury);
        vm.stopBroadcast();
        console2.log("NockOtcHtlc", address(htlc));
        console2.log("USDC", BASE_USDC);
        console2.log("treasury/owner", treasury);
        console2.log("Add to .env: VITE_HTLC_ADDRESS=", address(htlc));
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