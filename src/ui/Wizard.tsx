/**
 * Generic multi-step wizard chrome (React port of the old mountWizard).
 *
 * Each step is a React component (`Body`) plus an optional `onNext` action.
 * Both receive the shared `ctx` (which carries the live `swap` state and helpers),
 * so the steps stay in sync with the wizard's state without stale closures.
 * The parent owns `index` so it can react to step changes (effects, initial step).
 */
import { useState, type ComponentType } from "react";

export interface WizardStep<Ctx extends object> {
  id: string;
  /** Step heading; a function gets the live ctx (e.g. token-aware titles). */
  title: string | ((ctx: Ctx) => string);
  /** Step body — a component rendered with the shared context as its props. */
  Body: ComponentType<Ctx>;
  /** Action run when Next is clicked. Throw to block advancing (surfaced via onError). */
  onNext?(ctx: Ctx): Promise<void> | void;
  /** Custom label for the Next button; a function gets the live ctx. */
  nextLabel?: string | ((ctx: Ctx) => string);
  /** Terminal step — renders no Next button. */
  terminal?: boolean;
  /** Return false to disable the Next button. Defaults to enabled. */
  canAdvance?(ctx: Ctx): boolean;
}

export function Wizard<Ctx extends object>({
  steps,
  index,
  ctx,
  onIndexChange,
  onError,
  actionsEnabled = true,
}: {
  steps: WizardStep<Ctx>[];
  index: number;
  ctx: Ctx;
  onIndexChange(i: number): void;
  onError(err: unknown): void;
  /** When false, the Next/action button stays disabled (e.g. wallets not ready). */
  actionsEnabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const step = steps[index];
  const Body = step.Body;

  async function handleNext() {
    if (busy) return;
    setBusy(true);
    try {
      if (step.onNext) await step.onNext(ctx);
      onIndexChange(Math.min(steps.length - 1, index + 1));
    } catch (err) {
      // Leave the index unchanged so the user can retry.
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const title = typeof step.title === "function" ? step.title(ctx) : step.title;
  const nextLabel =
    typeof step.nextLabel === "function" ? step.nextLabel(ctx) : step.nextLabel;

  return (
    <section className="panel wizard">
      <div className="step-indicator">{title}</div>
      <Body {...ctx} />
      <div className="step-nav">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onIndexChange(Math.max(0, index - 1))}
        >
          Back
        </button>
        {!step.terminal && (
          <button
            type="button"
            className={busy ? "busy" : undefined}
            disabled={
              busy ||
              !actionsEnabled ||
              (step.canAdvance ? !step.canAdvance(ctx) : false)
            }
            onClick={handleNext}
          >
            {nextLabel ?? "Next"}
          </button>
        )}
      </div>
    </section>
  );
}
