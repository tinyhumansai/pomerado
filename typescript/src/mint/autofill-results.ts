import { lostTyping } from "../destinations/autofill-refusal.js";
import { callingCode } from "../destinations/login-field-formats.js";
import type {
  AutofillStep,
  AutofillStepReport,
  PrimaryIdentifierKind,
} from "../destinations/autofill-step.js";
import { Effect } from "effect";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import type { AutofillSecret, AutofillSignInState } from "../runtime/autofill-state.js";
import type { CodeAgain } from "../runtime/autofill-values.js";
import type { EventSink } from "../runtime/context.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import type { Unanswered } from "../runtime/login-field-asks.js";
import type { AnsweredLoginFields } from "../runtime/login-values.js";
import { report } from "../runtime/sign-in-telemetry.js";
import { MintFailure } from "./contracts.js";

export { callingCode } from "../destinations/login-field-formats.js";

/**
 * What a build's sign-in rules read and keep of the sign-in under way: refs the host holds for the
 * whole build and updates in place, and the host's event sink, if it keeps one. A host passes its
 * own state; nothing here is a copy.
 */
export interface AutofillHost {
  /** Where the sign-in's value-free events go; absent, they go nowhere. */
  readonly diagnostics?: EventSink | undefined;
  /** The host's own correlation for its reports, passed through unread. */
  readonly reportCorrelation: unknown;
  /** The login the build holds, once one is. */
  readonly heldLogin: {
    readonly current: { readonly credentials?: WebsiteCredentials | undefined } | undefined;
  };
  /** The identifiers, date of birth and ZIP the owner gave in this build. */
  readonly answeredLoginFields: { readonly current: AnsweredLoginFields };
  /** The kind of identifier field the login's username went into. */
  readonly autofillPrimaryIdentifierKind: { current: PrimaryIdentifierKind | undefined };
  /** The open sign-in, if one is open. */
  readonly autofillSignIn: { current: AutofillSignInState | undefined };
  /** Whether the latest sign-in verified. */
  readonly managedAuthenticationComplete: { current: boolean };
  /** Each field's last value a fill may have sent, a password as its digest. */
  readonly autofillSentValues: { readonly current: Partial<Record<CredentialRejectedField, string>> };
  /** The secrets the open sign-in may have sent, and those it filled once more. */
  readonly autofillSecretsFilled: { current: readonly AutofillSecret[] };
  readonly autofillSecretsRefilled: { current: readonly AutofillSecret[] };
  /** The values the site rejected in this build, by field, a password as its digest. */
  readonly autofillRejectedValues: {
    readonly current: Partial<Record<CredentialRejectedField, string[]>>;
  };
  /** The digest of the password the site rejected last. */
  readonly autofillRejectedPassword: { current: string | undefined };
  /** Whether the site rejected a code of the open sign-in. */
  readonly autofillCodeRejected: { current: boolean };
  /** Why the next code step asks the owner for a code again, if it does. */
  readonly autofillCodeAgain: { current: CodeAgain | undefined };
  /** How many corrections of each field the owner was asked for. */
  readonly autofillCorrectionRequests: {
    readonly current: Partial<Record<CredentialRejectedField, number>>;
  };
  /** The fields the latest rejection found rejected, until its correction is asked. */
  readonly autofillPendingRejectedFields: { current: readonly CredentialRejectedField[] };
}

export const autofillRecovery =
  "then inspect read-only and correct the sign-in steps from the page's evidence";

/**
 * The result an autofill call returns. A step whose
 * submit ran, or whose answer was lost, may have sent the login to the site.
 */
export const result = (value: unknown, maySend = false) => ({
  result: new TextEncoder().encode(
    JSON.stringify({
      status: "succeeded",
      websiteEffect: maySend ? "may_have_dispatched" : "not_started",
      output: { value, schemas: { input: {}, output: {} } },
    }),
  ),
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  events: new TextEncoder().encode("[]"),
  exitCode: 0,
});

type DiagnosticHost = Pick<AutofillHost, "diagnostics" | "reportCorrelation">;

export const emit = (h: DiagnosticHost, details: Readonly<Record<string, unknown>>) =>
  report.bestEffort(h.diagnostics?.emit("authentication.autofill_step", details) ?? Effect.void, {
    component: "mint",
    operation: "diagnostics.emit",
    phase: "authentication.autofill_step",
    correlation: h.reportCorrelation,
  });

/** A step the host refused before touching the page: it typed and asked nothing. */
export const refusedStep = (
  h: DiagnosticHost,
  reason:
    | "credential_already_filled"
    | "identifier_conflict"
    | "nothing_rejected"
    | "selector_names_contact"
    | "page_names_contact"
    | "code_unavailable"
    | "credential_unavailable"
    | "login_lacks_identifier",
  target: number,
  nextStep: string,
) =>
  emit(h, { stage: "step", outcome: "refused", reason }).pipe(
    Effect.as(result({ step: { outcome: "refused", reason, target }, nextStep })),
  );

/** A value the step could not get: the owner did not answer, or the host could not ask. */
export const unansweredFailure = ({ cause: unanswered }: Unanswered) =>
  new MintFailure({
    code: "Unavailable",
    ...(unanswered instanceof InputRequestFailure && unanswered.code === "NoResponse"
      ? { noResponse: { possibleCommit: false } }
      : {}),
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "autofill.ask",
      phase: "sign_in_input",
      error: unanswered,
    }),
  });

const filledNotices = {
  blocked:
    "The host filled the fields, but another element sat over the submit and caught its click (blockedBy), such as a cookie or tracking consent banner, so nothing was sent and no fill was spent. Never click the submit yourself. Find that banner's own control with a read-only explore (never read a field the host filled): its close or dismiss control, else one that rejects or declines what is not essential, else accept when that is the only way out. Then send this same signInStep again with that control's selector as dismiss: the host clicks it, then clicks the submit once more, typing nothing unless the dismiss emptied a field. When that element has no such control, such as a fixed header or footer, send this same signInStep again without dismiss, and without resizing or scrolling the page: the host then presses the submit from the keyboard.",
  failed:
    "The host filled the fields, but its click of the submit failed. You may click that one submit yourself in an explore, and nothing else: never read, change or return a field the host filled. Then continue with the next signInStep, or signedIn.",
  none: "The host filled the fields; the screen has no button. Explore read-only to see what it revealed, then send the next signInStep for it.",
  clicked:
    "The host filled the fields and clicked the submit. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
  not_attempted:
    "A field could not be filled, so the host did not submit. Explore read-only to see why, then correct the step.",
  refused:
    "The host filled the fields, but afterwards a field or the submit no longer sat or submitted where the host judged it (page code moved the form or changed how it submits), so the host did not click, or stopped the submission as it fired. Never click it yourself: inspect the changed form and correct the sign-in step.",
  stayed_disabled:
    "The host filled the fields, but the page kept the submit disabled through the host's wait for it to be enabled, so the host never clicked it. Never click it yourself: explore read-only to see what the page still needs before it enables the submit, such as another field, a checkbox or a choice (never read a field the host filled), then correct the sign-in step.",
  page: "The host filled the fields, and the page may have sent them itself: once the last field was filled, the screen moved on, emptied its fields or stopped taking typing before the host clicked anything. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
} as const;

/** What to do on a screen with a country picker: name it as its own field, picking `what`. */
const pickerAdvice = (what: string) =>
  `prefer sending this signInStep again with the picker as its own field before the phone field, accepting phone with format calling_code, and the phone field's format set to national: the host then picks ${what} there, checks it stuck, and types the number without it.`;

/**
 * After a phone field whose `maxLength` is shorter than the number the host typed, when the number
 * says its calling code (`code`): it names that code and no other digit of the number, so that on
 * a screen with a country picker the step names the picker as its own field, where the host picks
 * the number's country before the number goes without its calling code.
 */
const localNumberNotice = (code: string) =>
  `The phone field seems to take only the local number: it kept just the start of the number the host typed. Nothing was submitted and nobody was asked. If the screen has no country picker, prefer sending this signInStep again with that phone field's format set to national: the host then types the number without its country calling code, and reads the field back again before it submits. If the screen has a country picker, ${pickerAdvice(`calling code +${code}`)}`;

/**
 * A step the host stopped before its submit because a phone field kept other digits than the
 * number it typed (field status `changed`). When the field seems to take only the local number
 * (`local`, from `takesLocalNumber`) and the number is written in international form, it says to
 * send the step again with the field's format set to national, naming only the number's calling
 * code, and on a screen with a country picker to name the picker as its own field, where the host
 * picks that code (`format: "calling_code"`). Otherwise it names the number's calling code when it
 * is written in international form (`callingCode`), with the same advice for a picker, else the
 * site's own country, as a number written without its calling code most likely belongs to it.
 * Nothing was submitted and nobody was asked.
 */
export const changedPhoneNotice = (number: string | undefined, local = false) => {
  const code = number === undefined ? undefined : callingCode(number);
  if (local && code !== undefined) return localNumberNotice(code);
  const lead =
    "The phone field kept different digits than the number the host typed, as when the site's country picker is set to another country. Nothing was submitted and nobody was asked.";
  return code === undefined
    ? `${lead} If the screen has a country picker, prefer setting it to the site's own country with an explore step, then send this signInStep again.`
    : `${lead} The number's country calling code is +${code}. If the screen has a country picker, ${pickerAdvice("the number's calling code")}`;
};

/**
 * Whether the changed phone field at `index` (`changedField`) seems to take only the local
 * number: its `maxLength` is shorter than the number as typed (`cutShort`), and its step did not
 * already have the number typed without its calling code (`format: "national"`).
 */
export const takesLocalNumber = (
  stepReport: AutofillStepReport,
  step: Pick<AutofillStep, "fields">,
  index: number,
) =>
  stepReport.outcome === "filled" &&
  stepReport.fields[index]?.cutShort === true &&
  step.fields[index]?.format !== "national";

/** The first field of a fill that a phone the page changed stopped (`changed`), else -1. */
export const changedField = (stepReport: AutofillStepReport) =>
  stepReport.outcome === "filled"
    ? stepReport.fields.findIndex((field) => field.status === "changed")
    : -1;

/** A fill whose answer was lost, other than a field's typing call's: the submit's call included. */
export const lostFillNotice = `The host lost the fill call's answer: the fields and the submit may have reached the site. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep, ${autofillRecovery}.`;

/**
 * A fill whose lost answer was a field's typing call's (`lostTyping`): the host clicks the submit
 * only after every field.
 */
export const lostTypingNotice =
  "The host lost the answer of the call that typed a field, so that field may hold its value. The host never clicked the submit. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep.";

/** A step whose `dismiss` the host refused before it typed or clicked anything. */
export const dismissRefusedNotice =
  "The step's dismiss is not a covering notice's own control: it is or holds a control of the sign-in, opens another page, matches more than one visible element, or sits in the sign-in's form or submits a form outside a notice that covers the step's controls. The host typed and clicked nothing. Send the step again with the notice's own close or dismiss control as dismiss, else one that rejects or declines what is not essential, else its accept control, or without dismiss.";

/** After a step whose covered submit the host pressed from the keyboard (`via: "keyboard"`). */
export const keyboardSubmitNotice =
  "Something sat over the submit and caught the host's click, so the host pressed the same submit from the keyboard instead, and nothing on the covering element was clicked. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signedIn.";

/** After a step whose submit key the host pressed. */
const keyNotices = {
  failed:
    "The host filled the fields, but its press of the step's submitKey failed. Never press it yourself: explore read-only to see the page (never read a field the host filled), then continue with the next signInStep, or signedIn.",
  clicked:
    "The host filled the fields and pressed the step's submitKey in the last field. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
} as const;

/**
 * After a step the host refused at its calling-code picker (`format: "calling_code"`), picking
 * and typing nothing: the number says no calling code, or the picker offers no option, or
 * several, for it. Each names no digit of the number.
 */
export const callingCodeNotices = {
  calling_code_missing:
    "The login's phone number doesn't say its country calling code (it isn't written with + or 00), so the host can't tell which option of the screen's calling-code picker is its country. It picked and typed nothing, so nothing reached the site and nobody was asked. If the picker already shows the number's country as the screen loads, send this signInStep again without the calling_code field, with the phone box's format still national; otherwise the sign-in can't go on with this number.",
  calling_code_unoffered:
    "The screen's calling-code picker has no option that shows the number's calling code with its plus, as in +44 or United Kingdom (+44), so the host picked and typed nothing; nothing reached the site and nobody was asked. Check with a read-only explore that the calling_code field is the picker itself (a select, or the control that opens its list) and that its options show their codes. Otherwise send this signInStep again without the calling_code field and without the phone box's format, so the host types the whole number and the read-back stops one typed under another country.",
  calling_code_ambiguous:
    "The screen's calling-code picker has more than one option for the number's calling code, as two countries that share +1 do. The host never guesses a country, since a guess could send the code to someone else's phone, so it picked and typed nothing; nothing reached the site and nobody was asked. Send this signInStep again without the calling_code field and without the phone box's format, so the host types the whole number and the read-back stops one typed under another country.",
} as const;

export const stepNotice = (
  stepReport: AutofillStepReport,
  step?: Pick<AutofillStep, "submitKey">,
) => {
  if (stepReport.outcome === "refused" && stepReport.reason === "dismiss_refused")
    return dismissRefusedNotice;
  if (
    stepReport.outcome === "refused" &&
    (stepReport.reason === "calling_code_missing" ||
      stepReport.reason === "calling_code_unoffered" ||
      stepReport.reason === "calling_code_ambiguous")
  )
    return callingCodeNotices[stepReport.reason];
  if (stepReport.outcome === "refused")
    return `The host typed and clicked nothing (${stepReport.reason}), so nothing reached the site and no sign-in was spent. Correct the step from the page's evidence, ${autofillRecovery}.`;
  if (lostTyping(stepReport)) return lostTypingNotice;
  if (stepReport.outcome === "uncertain") return lostFillNotice;
  if (
    step?.submitKey !== undefined &&
    (stepReport.submit === "failed" || stepReport.submit === "clicked")
  )
    return keyNotices[stepReport.submit];
  if (stepReport.via === "keyboard") return keyboardSubmitNotice;
  return filledNotices[stepReport.submit];
};
