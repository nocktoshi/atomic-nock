// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NockOtcHtlc} from "../src/NockOtcHtlc.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A contract caller, used to prove lock() rejects non-EOA / delegated callers.
contract LockProxy {
    function doLock(NockOtcHtlc htlc, address seller, uint256 amount, bytes32 hashlock, uint256 timelock)
        external
        returns (bytes32)
    {
        return htlc.lock(seller, amount, hashlock, timelock);
    }
}

contract NockOtcHtlcTest is Test {
    MockERC20 usdc;
    NockOtcHtlc htlc;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockERC20();
        htlc = new NockOtcHtlc(address(usdc), treasury);
        usdc.mint(buyer, 1_000_000_000_000);
    }

    /// @dev lock() requires msg.sender == tx.origin, so prank both.
    function _lock(uint256 amount, bytes32 hashlock, uint256 timelock) internal returns (bytes32 id) {
        vm.startPrank(buyer, buyer);
        usdc.approve(address(htlc), amount);
        id = htlc.lock(seller, amount, hashlock, timelock);
        vm.stopPrank();
    }

    function test_lock_and_withdraw_takes_fee() public {
        bytes memory preimageJam = hex"deadbeef01";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 100e6;
        uint256 timelock = block.timestamp + 1 days;

        bytes32 id = _lock(amount, hashlock, timelock);
        assertEq(usdc.balanceOf(address(htlc)), amount);
        assertEq(htlc.totalLocked(), amount);

        vm.prank(seller);
        htlc.withdraw(id, preimageJam);

        uint256 fee = (amount * 50) / 10_000; // 0.5%
        assertEq(usdc.balanceOf(seller), amount - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(htlc)), 0);
        assertEq(htlc.totalLocked(), 0);
    }

    function test_refund_after_timelock_is_fee_free() public {
        bytes memory preimageJam = hex"aa";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 50e6;
        uint256 timelock = block.timestamp + 100;

        bytes32 id = _lock(amount, hashlock, timelock);

        vm.warp(timelock + 1);
        vm.prank(buyer);
        htlc.refund(id);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000_000);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(htlc.totalLocked(), 0);
    }

    function test_lock_rejects_contract_caller() public {
        LockProxy proxy = new LockProxy();
        uint256 amount = 10e6;
        bytes32 hashlock = keccak256(hex"bb");
        uint256 timelock = block.timestamp + 1 days;

        // Fund + approve from the proxy as the buyer.
        usdc.mint(address(proxy), amount);
        vm.prank(address(proxy));
        usdc.approve(address(htlc), amount);

        // Even with tx.origin == the proxy EOA-ish, the proxy has code -> blocked.
        vm.prank(address(proxy), address(proxy));
        vm.expectRevert(bytes("no delegate"));
        proxy.doLock(htlc, seller, amount, hashlock, timelock);
    }

    function test_sweep_recovers_stranded_tokens_only() public {
        // An active lock plus a stray direct transfer to the contract.
        bytes memory preimageJam = hex"cc";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 locked = 100e6;
        uint256 timelock = block.timestamp + 1 days;
        _lock(locked, hashlock, timelock);

        uint256 stray = 7e6;
        vm.prank(buyer);
        require(usdc.transfer(address(htlc), stray), "stray transfer failed"); // bypasses lock()

        assertEq(usdc.balanceOf(address(htlc)), locked + stray);

        uint256 swept = htlc.sweep();
        assertEq(swept, stray);
        assertEq(usdc.balanceOf(treasury), stray);
        // Locked funds untouched.
        assertEq(usdc.balanceOf(address(htlc)), locked);
        assertEq(htlc.totalLocked(), locked);
    }

    function test_sweep_reverts_when_nothing_stranded() public {
        bytes memory preimageJam = hex"dd";
        _lock(100e6, keccak256(preimageJam), block.timestamp + 1 days);
        vm.expectRevert(bytes("nothing to sweep"));
        htlc.sweep();
    }

    function test_setFeeBps_only_owner_and_capped() public {
        vm.prank(treasury);
        htlc.setFeeBps(100);
        assertEq(htlc.feeBps(), 100);

        vm.prank(treasury);
        vm.expectRevert(bytes("fee too high"));
        htlc.setFeeBps(501);

        vm.prank(buyer);
        vm.expectRevert(bytes("not owner"));
        htlc.setFeeBps(10);
    }

    function test_transferOwnership() public {
        vm.prank(buyer);
        vm.expectRevert(bytes("not owner"));
        htlc.transferOwnership(buyer);

        vm.prank(treasury);
        htlc.transferOwnership(buyer);
        assertEq(htlc.owner(), buyer);
    }

    function test_zero_fee_pays_seller_full() public {
        vm.prank(treasury);
        htlc.setFeeBps(0);

        bytes memory preimageJam = hex"ee";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 100e6;
        bytes32 id = _lock(amount, hashlock, block.timestamp + 1 days);

        vm.prank(seller);
        htlc.withdraw(id, preimageJam);
        assertEq(usdc.balanceOf(seller), amount);
        assertEq(usdc.balanceOf(treasury), 0);
    }
}
