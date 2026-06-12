/**
 * Cloudflare Queues integration for solver events: produce inbound work to
 * solver-in and consume outbound commands from solver-out.
 */
import { claimSwap, advanceSwap, type Env } from "./swaps.js";
import { fillBid } from "./bids.js";
import { respondRfq, touchHeartbeat } from "./solver-rfq.js";
import { putSwapSecret } from "./solver-store.js";
import { allowedSolver } from "./solver-auth.js";
import { SwapError } from "./errors.js";
import type { SwapRecord } from "./contract.js";
import type { BidRecord } from "./market.js";
import {
  commandFailed,
  swapUpdated,
  type SolverInboundEvent,
  type SolverOutboundEvent,
} from "./solver-events.js";

export async function emitSolverEvent(env: Env, event: SolverInboundEvent): Promise<void> {
  if (!env.SOLVER_IN) {
    console.error("solver-queue: SOLVER_IN binding missing — event dropped", event.type);
    return;
  }
  await env.SOLVER_IN.send(event);
}

export function isSolverParticipant(env: Env, rec: SwapRecord): boolean {
  const seller = String(rec.sellerPkh ?? "");
  const buyer = String(rec.buyerPkh ?? "");
  return allowedSolver(env, seller) || (buyer.length > 0 && allowedSolver(env, buyer));
}

export function isExternalAsk(env: Env, rec: SwapRecord): boolean {
  return !rec.buyerPkh && !allowedSolver(env, String(rec.sellerPkh ?? ""));
}

export function isExternalBid(env: Env, bid: BidRecord): boolean {
  return !allowedSolver(env, bid.creatorPkh);
}

function requireSolverPkh(env: Env, pkh: string): void {
  if (!allowedSolver(env, pkh)) throw new SwapError(403, "not an authorized solver pkh");
}

async function echoSwapUpdated(env: Env, rec: SwapRecord | null | undefined): Promise<void> {
  if (rec) await emitSolverEvent(env, swapUpdated(rec));
}

async function failCommand(
  env: Env,
  cmd: SolverOutboundEvent,
  e: SwapError
): Promise<void> {
  await emitSolverEvent(
    env,
    commandFailed(cmd.commandId, cmd.type, e.status, e.message)
  );
}

export async function processSolverOutbound(
  env: Env,
  cmd: SolverOutboundEvent
): Promise<void> {
  requireSolverPkh(env, cmd.solverPkh);

  switch (cmd.type) {
    case "rfq.response": {
      await respondRfq(env, cmd.rfqId, cmd.solverPkh, {
        status: cmd.status,
        amountOut: cmd.amountOut,
        pricePerNock: cmd.pricePerNock,
        maxAmountIn: cmd.maxAmountIn,
        reason: cmd.reason,
      });
      return;
    }
    case "swap.claim": {
      const rec = await claimSwap(env, cmd.hEvm, cmd.buyerEth, cmd.solverPkh);
      await echoSwapUpdated(env, rec);
      return;
    }
    case "bid.fill": {
      const { swap } = await fillBid(env, cmd.bidId, cmd.swap, cmd.solverPkh);
      await echoSwapUpdated(env, swap);
      return;
    }
    case "swap.advance": {
      const rec = await advanceSwap(
        env,
        cmd.hEvm,
        cmd.fields,
        cmd.solverPkh,
        cmd.expectedVersion
      );
      await echoSwapUpdated(env, rec);
      return;
    }
    case "solver.secret.put": {
      await putSwapSecret(env, cmd.solverPkh, cmd.hEvm, cmd.secretHex);
      return;
    }
    case "solver.heartbeat": {
      await touchHeartbeat(env, cmd.solverPkh);
      return;
    }
    default: {
      const _exhaustive: never = cmd;
      throw new SwapError(400, `unknown solver command: ${(_exhaustive as SolverOutboundEvent).type}`);
    }
  }
}

export async function handleSolverOutBatch(
  batch: MessageBatch<SolverOutboundEvent>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processSolverOutbound(env, msg.body);
      msg.ack();
    } catch (e) {
      if (e instanceof SwapError) {
        if (e.status >= 500) {
          msg.retry();
          continue;
        }
        await failCommand(env, msg.body, e);
        msg.ack();
        continue;
      }
      console.error("solver-out consumer error:", e);
      msg.retry();
    }
  }
}