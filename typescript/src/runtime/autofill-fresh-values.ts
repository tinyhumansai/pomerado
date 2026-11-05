import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import {
  bareCode,
  resendRequested,
  Unanswered,
  type makeLoginFieldAsk,
} from "./login-field-asks.js";
import type { AutofillLogin, AnsweredLoginField } from "./autofill-values.js";

/**
 * A code the host keeps for the login that it could not read, as when the store that keeps it is
 * down: the step ends as that outage, which may pass, never as the site's refusal.
 */
export const credentialUnavailable = "credential_unavailable";

/**
 * Host-written, never model text: why the owner is asked for a code again. None says the site
 * sent a new code, since nothing tells the host it did.
 */
const codeNotices: Record<NonNullable<AutofillLogin["codeAgain"]>, string> = {
  rejected: "The site refused the last code.",
  resumed: "The sign-in restarted after a worker change, so it needs a new code.",
  // Not called a refusal: a page error may have lost the code, or the site may want a second one.
  returned: "The last code didn't sign you in.",
};

/**
 * Host-written: why the owner is asked for a code again after asking for a new one. The host
 * pressed the site's resend control, which asks the site to send one; nothing tells the host it
 * did.
 */
const resendNotices = {
  pressed: "The site was asked to send a new code.",
  unpressed: "The site's resend control couldn't be pressed, so no new code was asked for.",
} as const;

/**
 * A code this sign-in already sent and the site refused: as given, or as one-digit boxes sent it,
 * without its spaces and hyphens.
 */
const refusedBefore = (login: AutofillLogin, code: string) =>
  login.rejectedCodes?.has(code) === true || login.rejectedCodes?.has(bareCode(code)) === true;

/**
 * The owner's answers that share the sign-in's bounded rejection history: a corrected field, and
 * a code, which is asked again at most twice after the site refused one.
 */
export const makeFreshAutofillValues = <E extends YieldableError>({
  ask,
}: {
  readonly ask: ReturnType<typeof makeLoginFieldAsk<E>>["ask"];
}) => {
  const correctedValue = (
    login: AutofillLogin,
    slot: AnsweredLoginField | "recovery_code",
    /** Asks once, given the tries left with this one. */
    request: (triesLeft: number) => ReturnType<typeof ask>,
  ) =>
    Effect.gen(function* () {
      const counts = login.correctionRequests;
      if (!counts) return new Unanswered("correction_history_unavailable");
      while ((counts[slot] ?? 0) < 2) {
        const triesLeft = 2 - (counts[slot] ?? 0);
        counts[slot] = (counts[slot] ?? 0) + 1;
        const answered = yield* request(triesLeft);
        if (answered instanceof Unanswered || !login.rejectedValues?.[slot]?.has(answered.value))
          return answered;
      }
      return new Unanswered("field_corrections_exhausted", slot);
    });
  /**
   * The owner's code, asked with `notice`. While the screen's resend control has presses left
   * (`resend`), the question offers a resend: an owner who asks for one has the host press it,
   * and is asked again for the newest code, saying whether the press went through. Those asks
   * spend none of a refused code's tries.
   */
  const codeOrResend = (
    login: AutofillLogin,
    codeBoxes: number | undefined,
    notice: string | undefined,
  ) =>
    Effect.gen(function* () {
      let saying = notice;
      while (true) {
        const offered = login.resend !== undefined && login.resend.left() > 0;
        const answered = yield* ask(
          login.ask,
          "code",
          saying,
          false,
          0,
          codeBoxes,
          login.codeInstruction,
          offered,
        );
        if (!offered || !(answered instanceof Unanswered) || answered.cause !== resendRequested)
          return answered;
        const pressed = yield* login.resend?.press ?? Effect.succeed(false);
        saying = pressed ? resendNotices.pressed : resendNotices.unpressed;
      }
    });
  /**
   * Caller-provided codes consume the existing shared two-correction budget. An answer must fit
   * `codeBoxes` code fields one character each, when the screen has several. The question quotes
   * the screen's own instruction for the code when the step named one (`codeInstruction`), and
   * offers a resend on a screen whose resend control the host can press (`codeOrResend`).
   */
  const askedCode = (login: AutofillLogin, codeBoxes: number | undefined) =>
    Effect.gen(function* () {
      while (true) {
        if (login.codeAgain === "rejected" && login.codeRequests) {
          if (login.codeRequests.current >= 2) return new Unanswered("code_corrections_exhausted");
          login.codeRequests.current += 1;
        }
        const answered = yield* codeOrResend(
          login,
          codeBoxes,
          login.codeAgain === undefined ? undefined : codeNotices[login.codeAgain],
        );
        if (answered instanceof Unanswered || !refusedBefore(login, answered.value))
          return answered;
        if (!login.codeRequests || login.codeAgain !== "rejected")
          return new Unanswered("code_already_rejected");
      }
    });
  return { askedCode, correctedValue };
};
