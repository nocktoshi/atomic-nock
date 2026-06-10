# AtomicNock — security follow-ups

The off-chain mitigations (timelock ordering check, refund-height fix, /list
hardening) shipped earlier. The contract-side audit items below are **done in
`AtomicNock.sol`** but still need a **new deployment + `VITE_HTLC_ADDRESS`
update** to take effect on Base. The deployed contract is immutable; these only
protect swaps created against the new address.

## Done (this pass) — needs re-deploy

### M1 — Snapshot the fee at lock time ✅
`withdraw()` used to read `feeBps` live, so the owner could `setFeeBps`
(≤ MAX_FEE_BPS) between a buyer's `lock` and the seller's `withdraw` and skim
in-flight swaps. Now `Lock` stores `uint16 feeBps` captured at `lock()`, and
`withdraw()` prices the fee from `c.feeBps`. `setFeeBps` only affects future locks.
Covered by `test_fee_is_snapshotted_at_lock_time`.

### M2 — Decouple the fee transfer from the seller payout ✅
`withdraw()` used to `transfer(owner, fee)` inline, so a USDC-blacklisted owner
would brick **every** happy-path withdraw. Now the fee is accrued
(`uint256 public feesAccrued`) and the owner pulls it via `claimFees()`
(permissionless trigger, funds always go to `owner`). A failing fee transfer can
no longer block — or be bundled into — a seller's payout. `sweep()` now excludes
`feesAccrued` from the sweepable balance. Covered by
`test_blacklisted_owner_cannot_brick_withdraw`, `test_lock_and_withdraw_accrues_fee`,
`test_claimFees_reverts_when_zero`.

### L4 — Safe ERC20 transfers + reentrancy guard ✅
Inline minimal `SafeERC20` (`_safeTransfer`/`_safeTransferFrom` via
`_callOptionalReturn`): tolerates no-return (USDT-style) tokens, reverts on a
`false` return, and bubbles the token's own revert reason. A `nonReentrant`
guard (single storage slot) wraps `lock`/`withdraw`/`refund`/`claimFees`/`sweep`.
Self-contained — no OpenZeppelin dependency added. Covered by
`test_safe_transfer_supports_no_return_token`, `test_safe_transfer_reverts_on_false_return`,
`test_nonReentrant_blocks_reentry`.

### L3 — Lock-only emergency pause ✅
Owner `pause()`/`unpause()` blocks new `lock()`s only. `withdraw`, `refund` and
`claimFees` are never gated, so funds already in the contract always stay
recoverable. Covered by `test_pause_blocks_lock_only`, `test_pause_does_not_block_refund`,
`test_pause_only_owner`.

### Minimum USDC timelock duration on-chain ✅
`lock()` used to only require `timelock > block.timestamp`, so a non-standard
caller could lock with a near-immediate timelock and refund out from under a
seller mid-swap. Now `lock()` requires
`timelock >= block.timestamp + MIN_TIMELOCK`, where `MIN_TIMELOCK = 30 minutes`
(a `constant`). It sits well below the client's enforced 1h minimum window
(`MIN_USDC_WINDOW_SEC`) so mining latency can never reject a legitimate client
swap; it only blocks degenerate timelocks. Covered by
`test_lock_rejects_too_short_timelock`.

## Notes

> `lock()` deliberately has **no** EOA-only / "no delegate" guard, so
> smart-contract wallets (e.g. Coinbase Smart Wallet on Base) and EIP-7702
> EOAs can be buyers. A contract buyer can lock and refund safely.
