// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AtomicNock} from "../src/AtomicNock.sol";

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

/// @dev USDC-style token that can blacklist an address (transfers to/from it revert).
contract BlacklistERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address a, bool v) external {
        blocked[a] = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!blocked[from] && !blocked[to], "blacklisted");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blacklisted");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev USDT-style token: transfer/transferFrom return NO value on success.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Token that silently returns false instead of reverting — SafeERC20 must catch it.
contract FalseERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Malicious token that tries to re-enter sweep() during a transfer.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    AtomicNock public htlc;
    bool public armed;
    bool public blocked; // set if the re-entrant sweep() reverted
    bool public reentered; // set if the re-entrant sweep() unexpectedly succeeded

    function setHtlc(AtomicNock h) external {
        htlc = h;
    }

    function arm() external {
        armed = true;
    }

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
        if (armed) {
            armed = false;
            try htlc.sweep() {
                reentered = true;
            } catch {
                blocked = true;
            }
        }
        return true;
    }
}

contract AtomicNockTest is Test {
    MockERC20 usdc;
    AtomicNock htlc;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockERC20();
        htlc = new AtomicNock(address(usdc), treasury);
        usdc.mint(buyer, 1_000_000_000_000);
    }

    /// @dev Lock as `buyer`.
    function _lock(uint256 amount, bytes32 hashlock, uint256 timelock) internal returns (bytes32 id) {
        vm.startPrank(buyer);
        usdc.approve(address(htlc), amount);
        id = htlc.lock(seller, amount, hashlock, timelock);
        vm.stopPrank();
    }

    function test_lock_and_withdraw_accrues_fee() public {
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
        // Seller is paid immediately; the fee is ACCRUED (pull-payment), not pushed.
        assertEq(usdc.balanceOf(seller), amount - fee);
        assertEq(usdc.balanceOf(treasury), 0, "fee must not be pushed on withdraw");
        assertEq(usdc.balanceOf(address(htlc)), fee, "fee held until claimFees");
        assertEq(htlc.feesAccrued(), fee);
        assertEq(htlc.totalLocked(), 0);

        // Owner pulls the accrued fee separately.
        uint256 claimed = htlc.claimFees();
        assertEq(claimed, fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(htlc)), 0);
        assertEq(htlc.feesAccrued(), 0);
    }

    function test_fee_is_snapshotted_at_lock_time() public {
        // Lock at the default 0.5% rate.
        bytes memory preimageJam = hex"5151";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 100e6;
        bytes32 id = _lock(amount, hashlock, block.timestamp + 1 days);

        // Owner hikes the LIVE fee to the cap AFTER the lock already exists.
        vm.prank(treasury);
        htlc.setFeeBps(500); // 5%
        assertEq(htlc.feeBps(), 500);

        // Withdraw must price at the snapshotted 0.5%, never the live 5%.
        vm.prank(seller);
        htlc.withdraw(id, preimageJam);

        uint256 snapFee = (amount * 50) / 10_000; // rate at lock time
        assertEq(usdc.balanceOf(seller), amount - snapFee);
        assertEq(htlc.feesAccrued(), snapFee);
    }

    function test_claimFees_reverts_when_zero() public {
        vm.expectRevert(bytes("no fees"));
        htlc.claimFees();
    }

    function test_blacklisted_owner_cannot_brick_withdraw() public {
        BlacklistERC20 token = new BlacklistERC20();
        AtomicNock h = new AtomicNock(address(token), treasury);
        token.mint(buyer, 1_000e6);

        uint256 amount = 100e6;
        bytes memory preimageJam = hex"b1ac";
        bytes32 hashlock = keccak256(preimageJam);

        vm.startPrank(buyer);
        token.approve(address(h), amount);
        bytes32 id = h.lock(seller, amount, hashlock, block.timestamp + 1 days);
        vm.stopPrank();

        // Owner gets USDC-blacklisted.
        token.setBlocked(treasury, true);

        // Seller's withdraw STILL succeeds — the fee just accrues, owner isn't paid here.
        vm.prank(seller);
        h.withdraw(id, preimageJam);
        uint256 fee = (amount * 50) / 10_000;
        assertEq(token.balanceOf(seller), amount - fee, "seller paid despite owner blacklist");
        assertEq(h.feesAccrued(), fee);

        // claimFees reverts (owner can't receive) but the funds stay safely accrued.
        vm.expectRevert(bytes("blacklisted"));
        h.claimFees();
        assertEq(h.feesAccrued(), fee);
    }

    function test_pause_blocks_lock_only() public {
        bytes memory preimageJam = hex"9999";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 100e6;

        // Lock one swap while live so we can prove withdraw works under pause.
        bytes32 id = _lock(amount, hashlock, block.timestamp + 1 days);

        vm.prank(treasury);
        htlc.pause();
        assertTrue(htlc.paused());

        // New locks are blocked.
        vm.startPrank(buyer);
        usdc.approve(address(htlc), amount);
        vm.expectRevert(bytes("paused"));
        htlc.lock(seller, amount, keccak256(hex"8888"), block.timestamp + 1 days);
        vm.stopPrank();

        // ...but the existing swap can still be withdrawn while paused.
        vm.prank(seller);
        htlc.withdraw(id, preimageJam);
        assertEq(usdc.balanceOf(seller), amount - (amount * 50) / 10_000);

        // Unpause re-enables locking.
        vm.prank(treasury);
        htlc.unpause();
        assertFalse(htlc.paused());
        _lock(amount, keccak256(hex"7777"), block.timestamp + 1 days);
    }

    function test_pause_does_not_block_refund() public {
        bytes memory preimageJam = hex"abab";
        uint256 amount = 50e6;
        uint256 timelock = block.timestamp + 1 hours;
        bytes32 id = _lock(amount, keccak256(preimageJam), timelock);

        vm.prank(treasury);
        htlc.pause();

        vm.warp(timelock + 1);
        vm.prank(buyer);
        htlc.refund(id); // pause must NOT block recovery
        assertEq(htlc.totalLocked(), 0);
    }

    function test_pause_only_owner() public {
        vm.prank(buyer);
        vm.expectRevert(bytes("not owner"));
        htlc.pause();
    }

    function test_lock_rejects_too_short_timelock() public {
        uint256 amount = 100e6;
        bytes32 hashlock = keccak256(hex"7e57");
        uint256 minLock = htlc.MIN_TIMELOCK();

        // One second under the floor reverts.
        vm.startPrank(buyer);
        usdc.approve(address(htlc), amount);
        vm.expectRevert(bytes("timelock too soon"));
        htlc.lock(seller, amount, hashlock, block.timestamp + minLock - 1);
        vm.stopPrank();

        // Exactly at the floor succeeds.
        bytes32 id = _lock(amount, hashlock, block.timestamp + minLock);
        assertEq(htlc.totalLocked(), amount);
        (,,,, uint256 timelock,,) = htlc.getLock(id);
        assertEq(timelock, block.timestamp + minLock);
    }

    function test_safe_transfer_supports_no_return_token() public {
        NoReturnERC20 token = new NoReturnERC20();
        AtomicNock h = new AtomicNock(address(token), treasury);
        token.mint(buyer, 1_000e6);
        uint256 amount = 100e6;
        bytes memory preimageJam = hex"c0de";

        vm.startPrank(buyer);
        token.approve(address(h), amount);
        bytes32 id = h.lock(seller, amount, keccak256(preimageJam), block.timestamp + 1 days);
        vm.stopPrank();
        assertEq(token.balanceOf(address(h)), amount);

        vm.prank(seller);
        h.withdraw(id, preimageJam);
        assertEq(token.balanceOf(seller), amount - (amount * 50) / 10_000);
    }

    function test_safe_transfer_reverts_on_false_return() public {
        FalseERC20 token = new FalseERC20();
        AtomicNock h = new AtomicNock(address(token), treasury);
        token.mint(buyer, 1_000e6);
        uint256 amount = 100e6;

        vm.startPrank(buyer);
        token.approve(address(h), amount);
        vm.expectRevert(bytes("transfer returned false"));
        h.lock(seller, amount, keccak256(hex"dead"), block.timestamp + 1 days);
        vm.stopPrank();
    }

    function test_nonReentrant_blocks_reentry() public {
        ReentrantToken token = new ReentrantToken();
        AtomicNock h = new AtomicNock(address(token), treasury);
        token.setHtlc(h);
        token.mint(buyer, 1_000e6);
        uint256 amount = 100e6;
        bytes memory preimageJam = hex"f00d";

        vm.startPrank(buyer);
        token.approve(address(h), amount);
        bytes32 id = h.lock(seller, amount, keccak256(preimageJam), block.timestamp + 1 days);
        vm.stopPrank();

        token.arm(); // attempt to re-enter sweep() during the seller payout transfer
        vm.prank(seller);
        h.withdraw(id, preimageJam);

        assertTrue(token.blocked(), "reentry into sweep must be blocked");
        assertFalse(token.reentered(), "sweep must not have re-entered");
        // The legit withdraw still completed.
        assertEq(token.balanceOf(seller), amount - (amount * 50) / 10_000);
    }

    function test_refund_after_timelock_is_fee_free() public {
        bytes memory preimageJam = hex"aa";
        bytes32 hashlock = keccak256(preimageJam);
        uint256 amount = 50e6;
        uint256 timelock = block.timestamp + 1 hours;

        bytes32 id = _lock(amount, hashlock, timelock);

        vm.warp(timelock + 1);
        vm.prank(buyer);
        htlc.refund(id);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000_000);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(htlc.totalLocked(), 0);
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
