/**
 * Solver queue wire protocol — shared between the API Worker (producer +
 * consumer) and the solver VPS (pull + publish).
 */
import type { SwapRecord } from "./contract.js";
import type { BidRecord } from "./market.js";

export const SOLVER_EVENT_VERSION = 1 as const;

export type SolverInboundEvent =
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "rfq.created";
      id: string;
      ts: number;
      rfqId: string;
      side: "buy" | "sell";
      amountIn: string;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "market.ask.created";
      id: string;
      ts: number;
      swap: SwapRecord;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "market.bid.created";
      id: string;
      ts: number;
      bid: BidRecord;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "swap.updated";
      id: string;
      ts: number;
      hEvm: string;
      version: number;
      swap: SwapRecord;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "command.failed";
      id: string;
      ts: number;
      commandId: string;
      commandType: SolverOutboundEvent["type"];
      code: number;
      reason: string;
    };

export type SolverOutboundEvent =
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "rfq.response";
      commandId: string;
      ts: number;
      rfqId: string;
      solverPkh: string;
      status: "ready" | "rejected";
      amountOut?: string;
      pricePerNock?: number;
      maxAmountIn?: string;
      reason?: string;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "swap.claim";
      commandId: string;
      ts: number;
      hEvm: string;
      buyerEth: string;
      solverPkh: string;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "bid.fill";
      commandId: string;
      ts: number;
      bidId: string;
      swap: Record<string, unknown>;
      solverPkh: string;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "swap.advance";
      commandId: string;
      ts: number;
      hEvm: string;
      fields: Record<string, unknown>;
      expectedVersion?: number;
      solverPkh: string;
      role: "buyer" | "seller";
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "solver.secret.put";
      commandId: string;
      ts: number;
      hEvm: string;
      secretHex: string;
      solverPkh: string;
    }
  | {
      v: typeof SOLVER_EVENT_VERSION;
      type: "solver.heartbeat";
      commandId: string;
      ts: number;
      solverPkh: string;
    };

export function eventId(parts: string[]): string {
  return parts.join(":");
}

export function rfqCreated(
  rfqId: string,
  side: "buy" | "sell",
  amountIn: string
): SolverInboundEvent {
  const ts = Date.now();
  return {
    v: SOLVER_EVENT_VERSION,
    type: "rfq.created",
    id: eventId(["rfq.created", rfqId, "0"]),
    ts,
    rfqId,
    side,
    amountIn,
  };
}

export function marketAskCreated(swap: SwapRecord): SolverInboundEvent {
  const ts = Date.now();
  const hEvm = String(swap.hEvm).toLowerCase();
  return {
    v: SOLVER_EVENT_VERSION,
    type: "market.ask.created",
    id: eventId(["market.ask.created", hEvm, String(swap.version ?? 1)]),
    ts,
    swap,
  };
}

export function marketBidCreated(bid: BidRecord): SolverInboundEvent {
  const ts = Date.now();
  return {
    v: SOLVER_EVENT_VERSION,
    type: "market.bid.created",
    id: eventId(["market.bid.created", bid.id, String(bid.version)]),
    ts,
    bid,
  };
}

export function swapUpdated(swap: SwapRecord): SolverInboundEvent {
  const ts = Date.now();
  const hEvm = String(swap.hEvm).toLowerCase();
  const version = swap.version ?? 1;
  return {
    v: SOLVER_EVENT_VERSION,
    type: "swap.updated",
    id: eventId(["swap.updated", hEvm, String(version)]),
    ts,
    hEvm,
    version,
    swap,
  };
}

export function commandFailed(
  commandId: string,
  commandType: SolverOutboundEvent["type"],
  code: number,
  reason: string
): SolverInboundEvent {
  const ts = Date.now();
  return {
    v: SOLVER_EVENT_VERSION,
    type: "command.failed",
    id: eventId(["command.failed", commandId, String(ts)]),
    ts,
    commandId,
    commandType,
    code,
    reason,
  };
}