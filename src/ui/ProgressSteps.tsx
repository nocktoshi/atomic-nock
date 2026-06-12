/**
 * Friendly step timeline for long-running swap flows. Each step shows ✓ when
 * done, an animated spinner + honest time estimate + elapsed counter when
 * active, and dims when pending. Built for the auto-driven swaps where the
 * slow parts are Nockchain block confirmations — the goal is to make waiting
 * feel deliberate (progress, ETA, reassurance) instead of broken.
 */
import type { ReactNode } from "react";

export interface ProgressStep {
  label: string;
  /** Shown under the ACTIVE step: what's happening + how long it usually takes. */
  hint?: string;
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export function ProgressSteps({
  steps,
  active,
  stalled = false,
  elapsedSec,
  hideElapsed = false,
  activeExtra,
}: {
  steps: ProgressStep[];
  /** Index of the step in progress; pass steps.length when everything is done. */
  active: number;
  /** Highlights the active step as needing attention instead of spinning. */
  stalled?: boolean;
  /** Seconds since the active step started (drives the elapsed counter). */
  elapsedSec: number;
  /** Suppress the elapsed counter (e.g. when a block timeline takes over). */
  hideElapsed?: boolean;
  /** Extra content rendered under the active step (e.g. a block timeline). */
  activeExtra?: ReactNode;
}) {
  return (
    <ol className="progress-steps">
      {steps.map((step, i) => {
        const state = i < active ? "done" : i === active ? (stalled ? "stalled" : "active") : "pending";
        return (
          <li key={step.label} className={`pstep ${state}`}>
            <span className="pstep-marker">
              {state === "done" ? (
                "✓"
              ) : state === "active" ? (
                <span className="pstep-spinner" aria-label="in progress" />
              ) : state === "stalled" ? (
                "!"
              ) : (
                i + 1
              )}
            </span>
            <span className="pstep-body">
              <span className="pstep-label">{step.label}</span>
              {state === "active" && step.hint && (
                <span className="pstep-hint">
                  {step.hint}
                  {!hideElapsed && elapsedSec > 0 && (
                    <span className="pstep-elapsed"> · {fmtElapsed(elapsedSec)} elapsed</span>
                  )}
                </span>
              )}
              {state === "active" && activeExtra}
              {state === "stalled" && (
                <span className="pstep-hint">Paused — see the message below.</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
