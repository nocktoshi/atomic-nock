import { el, runBusy } from "./dom.js";

/** Passed to each step's render() so handlers can drive navigation. */
export interface StepContext {
  /** Advance to the next step and re-render. */
  advance(): void;
  /** Re-render the current step (re-evaluates canAdvance, status, etc.). */
  rerender(): void;
}

export interface WizardStep {
  id: string;
  title: string;
  /** Build the step body element. Rebuilt each time the step is shown. */
  render(ctx: StepContext): HTMLElement;
  /**
   * Optional guard run when the user clicks Next. Throw to block advancing
   * (the thrown error is surfaced via the mount's onError handler).
   */
  onNext?(): Promise<void> | void;
  /**
   * Optional handler for the Skip button (shown only when provided).
   * After skip runs, the wizard advances to the next step.
   */
  skip?(): Promise<void> | void;
  /** Custom label for the Next button (e.g. the final action). */
  nextLabel?: string;
  /** Terminal step — renders no Next button. */
  terminal?: boolean;
  /** Optional guard to disable the Next button. Return true to allow advancing. */
  canAdvance?(): boolean;
}

/**
 * DOM-free navigation state machine. Kept separate from rendering so step
 * navigation (clamping, guard-blocks-advance) is unit-testable without a DOM.
 */
export class WizardController {
  index = 0;
  constructor(public readonly stepCount: number) {}

  goto(i: number): void {
    this.index = Math.max(0, Math.min(this.stepCount - 1, i));
  }

  back(): void {
    this.goto(this.index - 1);
  }

  /**
   * Run the step guard (if any) then advance. If the guard rejects/throws, the
   * index is left unchanged and the error propagates to the caller.
   */
  async tryNext(onNext?: () => Promise<void> | void): Promise<void> {
    if (onNext) await onNext();
    this.goto(this.index + 1);
  }
}

export interface MountOptions {
  onError?(err: unknown): void;
  /** Step index to open on first render (clamped). Defaults to 0. */
  initialStep?: number;
}

/** Render a wizard into `root`, wiring Back/Next around each step body. */
export function mountWizard(
  root: HTMLElement,
  steps: WizardStep[],
  opts: MountOptions = {}
): WizardController {
  const ctrl = new WizardController(steps.length);
  if (opts.initialStep) ctrl.goto(opts.initialStep);

  function rerender(): void {
    root.replaceChildren(view());
  }

  const ctx: StepContext = {
    advance() {
      ctrl.goto(ctrl.index + 1);
      rerender();
    },
    rerender() {
      rerender();
    },
  };

  function view(): HTMLElement {
    const step = steps[ctrl.index];

    const indicator = el("div", { class: "step-indicator" }, [
      `${step.title}`,
    ]);

    const nav = el("div", { class: "step-nav" });
    const back = el("button", { type: "button", text: "Back" });
    back.disabled = ctrl.index === 0;
    back.onclick = () => {
      ctrl.back();
      rerender();
    };
    nav.append(back);

    if (!step.terminal) {
      const next = el("button", {
        type: "button",
        text: step.nextLabel ?? "Next",
      });
      next.disabled = step.canAdvance ? !step.canAdvance() : false;
      next.onclick = async () => {
        try {
          await runBusy(next, () => ctrl.tryNext(step.onNext?.bind(step)));
          // Success: advance. rerender() replaces this (now re-enabled) button.
          rerender();
        } catch (err) {
          // runBusy already re-enabled the button, so the user can retry.
          opts.onError?.(err);
        }
      };
      nav.append(next);

      if (step.skip) {
        const skipBtn = el("button", {
          type: "button",
          text: "Skip",
          class: "secondary",
        });
        skipBtn.onclick = async () => {
          try {
            await runBusy(skipBtn, () => {
              const p = step.skip!();
              return p instanceof Promise ? p : Promise.resolve(p);
            });
            ctrl.goto(ctrl.index + 1);
            rerender();
          } catch (err) {
            opts.onError?.(err);
          }
        };
        nav.append(skipBtn);
      }
    }

    return el("section", { class: "panel wizard" }, [
      indicator,
      step.render(ctx),
      nav,
    ]);
  }

  rerender();
  return ctrl;
}
