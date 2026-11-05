import { Clock, Duration, Effect } from "effect";
import { maySend } from "../destinations/autofill-refusal.js";
import { refusalEvidence } from "../destinations/autofill-refusal-evidence.js";
import type { AutofillStep } from "../destinations/autofill-step.js";
import type { AutofillHooks } from "./autofill-state.js";
import type { CodeResend } from "./autofill-values.js";

// A code screen's own resend control (`AutofillStep.resend`), which the host presses only when the
// owner answers the code question by asking for a new code: the code question offers it while the
// screen has presses left, and a press waits for the site's timer to show and enable the control.

/** How many times the host presses one code screen's resend control at most. */
export const resendsPerScreen = 2;

/** How long a press waits for the site to show and enable a resend control: 2 minutes. */
export const resendWaitMs = 120_000;

/**
 * A code step's resend on hooks that can press one (`AutofillHooks.resend`), or undefined: none
 * when the step names no resend or takes no code, or the hooks can't press it. `presses` counts
 * each screen's presses by its resend's and code fields' selectors, so a screen filled again, such
 * as after a refused code, keeps its count. A press counts as soon as it starts. It inspects the
 * screen's code fields with the control as their submit, again every `pollMs` while the control
 * doesn't show, for up to `waitMs`, as a site that shows it only once its timer ends; the hooks
 * then press it, waiting the rest of `waitMs` while the site keeps it disabled. It says whether
 * the press may have gone out (`maySend`), and never fails: a refusal, an inspection that failed
 * and a press the site never enabled answer false. Each press's outcome goes to `emit`, value-free.
 */
export const makeCodeResend = <E>(input: {
  readonly hooks: Pick<AutofillHooks<E>, "inspect" | "resend">;
  readonly step: AutofillStep;
  readonly presses: Map<string, number>;
  readonly waitMs: number;
  readonly pollMs: number;
  readonly emit: (details: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}): CodeResend | undefined => {
  const { hooks, step } = input;
  const press = hooks.resend;
  const codes = step.fields.filter((field) => field.slot === "code");
  if (step.resend === undefined || press === undefined || codes.length === 0) return undefined;
  const resendStep: AutofillStep = {
    fields: codes,
    submit: step.resend,
    ...(step.popup === undefined ? {} : { popup: step.popup }),
  };
  const key = JSON.stringify([step.resend, ...codes.map((field) => field.selector)]);
  const used = () => input.presses.get(key) ?? 0;
  return {
    left: () => Math.max(0, resendsPerScreen - used()),
    press: Effect.gen(function* () {
      input.presses.set(key, used() + 1);
      const until = (yield* Clock.currentTimeMillis) + input.waitMs;
      let found = yield* hooks.inspect(resendStep);
      while (
        "outcome" in found &&
        found.reason === "not_found" &&
        found.target === "submit" &&
        (yield* Clock.currentTimeMillis) < until
      ) {
        yield* Effect.sleep(Duration.millis(input.pollMs));
        found = yield* hooks.inspect(resendStep);
      }
      if ("outcome" in found) {
        yield* input.emit({
          stage: "resend",
          outcome: "refused",
          reason: found.reason,
          ...refusalEvidence(found),
        });
        return false;
      }
      const waitMs = Math.max(0, until - (yield* Clock.currentTimeMillis));
      const report = yield* press({ step: resendStep, inspection: found, waitMs });
      const pressed = maySend(report);
      yield* input.emit({
        stage: "resend",
        outcome: report.outcome,
        ...(report.outcome === "filled" ? { submit: report.submit } : { reason: report.reason }),
        ...refusalEvidence(report),
      });
      return pressed;
    }).pipe(
      // error-reporting-allow: typed-recovery a press that did not go through is the code question's to say, and the screen's own fill reports a browser that stays down
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  };
};
