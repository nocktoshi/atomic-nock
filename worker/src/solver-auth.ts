/**
 * Solver authorization — session pkh must be in SOLVER_PKHS when that var is set.
 */
import type { Env } from "./swaps.js";

/** True if pkh may use solver-only routes (quote board, state persistence). */
export function allowedSolver(env: Env, pkh: string): boolean {
  const list = (env.SOLVER_PKHS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 ? true : list.includes(pkh);
}