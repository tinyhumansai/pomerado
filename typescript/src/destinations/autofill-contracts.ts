import { Schema } from "effect";
import { signInMethodChoices } from "../runtime/authentication.js";

/** A supported two-factor method; a run call may pick one. */
export const SignInMethod = Schema.Literal("sms", "call", "email", "totp", "push");
export type SignInMethod = typeof SignInMethod.Type;
/** `SignInMethod` or a recovery code; see `signInMethodChoices`. The shared contract's choice. */
export const SignInMethodChoice = Schema.Literal(...signInMethodChoices);
export type SignInMethodChoice = typeof SignInMethodChoice.Type;

/**
 * How a `date_of_birth` field takes the date: a whole date in one of these layouts, or, for a
 * month, day and year shown as separate fields or dropdowns, the one part a field takes (`MM`
 * zero-padded, `M` not, `MMM` and `MMMM` the month name, short or full, in the page's language or
 * English; `YY` a two-digit year). A native date input always takes `YYYY-MM-DD`; the host fills
 * each with the authoring library's `fillDate` (`browser/form-controls.ts`).
 */
export const DateOfBirthFormat = Schema.Literal(
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "M/D/YYYY",
  "D/M/YYYY",
  "MM-DD-YYYY",
  "DD-MM-YYYY",
  "DD.MM.YYYY",
  "YYYY/MM/DD",
  "MMDDYYYY",
  "DDMMYYYY",
  "YYYYMMDD",
  "YYYY",
  "YY",
  "MM",
  "M",
  "MMM",
  "MMMM",
  "DD",
  "D",
);
export type DateOfBirthFormat = typeof DateOfBirthFormat.Type;
/**
 * How a field that takes a phone number takes it: `national`, the number without its country
 * calling code, for a box that keeps only the local number and has no country picker, or a picker
 * that already shows the number's country as the screen loads, or a picker the step names as its
 * own field. The host types the digits after the saved number's calling code (`nationalDigits`); a
 * number saved without one is typed as saved. `calling_code`: the screen's calling-code picker, a
 * select or dropdown beside such a box, where the host picks the option for the number's calling
 * code (`callingCode`, `namesCallingCode`) before it types the box (`callingCodeFits`).
 */
export const PhoneFormat = Schema.Literal("national", "calling_code");
export type PhoneFormat = typeof PhoneFormat.Type;
/** A phone field's format a version 10 recipe may carry: the national number alone. */
export const NationalFormat = Schema.Literal("national");
/**
 * Whether a step's calling-code picker fits it: a field that says `format: "calling_code"` accepts
 * a phone alone, the step names one at most, and a later field that accepts a phone alone says
 * `format: "national"`, so the host picks the calling code before it types the national number
 * beside it. A step with no such field fits.
 */
export const callingCodeFits = (fields: readonly object[]) => {
  const format = (field: object) => ("format" in field ? field.format : undefined);
  const phoneAlone = (field: object) =>
    "accepts" in field &&
    Array.isArray(field.accepts) &&
    field.accepts.length === 1 &&
    field.accepts[0] === "phone";
  const pickers = fields.flatMap((field, index) =>
    format(field) === "calling_code" ? [index] : [],
  );
  const [at] = pickers;
  if (at === undefined) return true;
  return (
    pickers.length === 1 &&
    phoneAlone(fields[at] ?? {}) &&
    fields.slice(at + 1).some((field) => phoneAlone(field) && format(field) === "national")
  );
};
/** Why a step's calling-code picker does not fit it (`callingCodeFits`). */
export const callingCodeMessage =
  "a calling_code field accepts phone alone, a step names one at most, and a later field that accepts phone alone says format national";
/**
 * Whether a step's `resend` fits it: none, or the code screen's own control that asks the site to
 * send a new code, on a step whose every field takes a code, so the press has no other value of
 * this step to send, and never its submit, one of its fields or methods or its `dismiss`. The host
 * presses it only when the owner asks for a new code, and only when the form it submits holds no
 * value an earlier screen may have left (`resendChecksCode`).
 */
export const resendFits = (step: {
  readonly fields: readonly ({ readonly selector: string } & object)[];
  readonly submit?: string | undefined;
  readonly methods?: readonly { readonly selector: string }[] | undefined;
  readonly dismiss?: string | undefined;
  readonly resend?: string | undefined;
}) =>
  step.resend === undefined ||
  (step.fields.length > 0 &&
    step.fields.every((field) => "slot" in field && field.slot === "code") &&
    step.resend !== step.submit &&
    step.resend !== step.dismiss &&
    !step.fields.some((field) => field.selector === step.resend) &&
    !(step.methods ?? []).some((method) => method.selector === step.resend));
/** Why a step's `resend` does not fit it (`resendFits`). */
export const resendMessage =
  "a step names resend only when every field it takes is a code, as its code screen's own control, never its submit, a field, a method or its dismiss";
/**
 * The control a `date_of_birth` field was filled into, as the host found it (`formControlShape`):
 * a native date input, a text box, a native select or a custom dropdown. The recipe records it,
 * value-free; a run finds the control's shape again and fills what it finds.
 */
export const DateControl = Schema.Literal("date", "text", "select", "combobox");
export type DateControl = typeof DateControl.Type;
/**
 * A sign-in screen holds at most this many fields besides its code fields: a date of birth may
 * take three. Its code fields have their own bound, `maximumCodeBoxes`.
 */
export const maximumStepFields = 6;
/**
 * A sign-in screen holds at most this many code fields: one, or one per box of a code split across
 * one-character boxes, up to the longest common one-time code. The host types one character of the
 * one code into each.
 */
export const maximumCodeBoxes = 12;
/**
 * Whether a step's fields fit a sign-in screen: at most `maximumStepFields` besides its code
 * fields, and at most `maximumCodeBoxes` code fields.
 */
export const stepFieldsFit = (fields: readonly object[]) => {
  const codes = fields.filter((field) => "slot" in field && field.slot === "code").length;
  return codes <= maximumCodeBoxes && fields.length - codes <= maximumStepFields;
};
/** Why a step's fields do not fit (`stepFieldsFit`). */
export const stepFieldsMessage = `a sign-in step names at most ${maximumStepFields} fields besides its code fields, and at most ${maximumCodeBoxes} code fields, one per box of a split code`;
/**
 * Identifier kinds a field may accept. `private_identifier` is any other identity field a sign-in
 * asks for, such as a national identity number or a PIN that is itself the sign-in identifier,
 * labelled as the site labels it (`PrivateIdentifierLabel`): the host keeps its value like a
 * password. A PIN entered in place of a password after another identifier is the `password` slot.
 */
export const IdentifierKinds = Schema.Literal(
  "username",
  "email",
  "phone",
  "account_number",
  "private_identifier",
);
/**
 * A private identifier field's own label as the site shows it, such as "National ID number": what
 * the owner is asked for and what the saved login shows. Never the value. One line: no control or
 * format character (a newline, NEL, NUL or a bidi control) and no line or paragraph separator.
 */
export const PrivateIdentifierLabel = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
  Schema.filter((label) => label.trim() === label && !/[\p{C}\p{Zl}\p{Zp}]/u.test(label), {
    message: () =>
      "a label is one line of the site's own words, without surrounding spaces or control characters",
  }),
);
/**
 * Whether an identifier field's kinds and label agree: a `private_identifier` field accepts that
 * kind alone and names its label; no other identifier field names a label.
 */
export const privateIdentifierFits = (field: {
  readonly accepts: readonly string[];
  readonly label?: string | undefined;
}) =>
  field.accepts.includes("private_identifier")
    ? field.accepts.length === 1 && field.label !== undefined
    : field.label === undefined;
/** Why an identifier field's kinds and label do not agree (`privateIdentifierFits`). */
export const privateIdentifierMessage =
  "a private_identifier field accepts that kind alone, with the site's label for it; no other identifier field names a label";
/**
 * Whether a step's fields name at most one `private_identifier` field: a login holds one private
 * identifier, so a second such field would be typed the same value. A PIN entered in place of a
 * password after another identifier is the `password` slot.
 */
export const onePrivateIdentifier = (fields: readonly object[]) =>
  fields.filter(
    (field) =>
      "accepts" in field &&
      Array.isArray(field.accepts) &&
      field.accepts.includes("private_identifier"),
  ).length <= 1;
/** Why a step's fields do not fit (`onePrivateIdentifier`). */
export const onePrivateIdentifierMessage =
  "a sign-in step names at most one private_identifier field; a PIN entered in place of a password after another identifier is the password slot";
/** Secret slots a field may take. */
export const SecretSlots = Schema.Literal(
  "password",
  "code",
  "date_of_birth",
  "zip",
  "recovery_code",
  "private_answer",
);

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/** A value-free, slot-specific error marker observed on a sign-in screen. */
export const RejectedMarker = Schema.Struct({
  // A one-use answer cannot be corrected from a recorded rejection marker.
  slot: Schema.Union(
    IdentifierKinds,
    Schema.Literal("password", "code", "date_of_birth", "zip", "recovery_code"),
  ),
  selector: Selector,
});
export type RejectedMarker = typeof RejectedMarker.Type;
/** A stable relation to the primary page, never a provider or CDP target id. */
export const AutofillPopup = Schema.Struct({
  opener: Schema.Literal("primary"),
  origin: Schema.String.pipe(
    Schema.maxLength(2_000),
    Schema.filter((value) => {
      const url = URL.parse(value);
      return url !== null && url.protocol === "https:" && url.origin === value;
    }),
  ),
});
export type AutofillPopup = typeof AutofillPopup.Type;

/**
 * The key a sign-in step presses in its last field to submit that field's form, for a form with no
 * submit control that submits on Enter (HTML implicit submission, or its own script on the key).
 */
export const SubmitKey = Schema.Literal("Enter");
export type SubmitKey = typeof SubmitKey.Type;

/** An off-page sign-in the owner completes before confirming through the protected input. */
export const AutofillApproval = Schema.Literal("email_link", "device");
export type AutofillApproval = typeof AutofillApproval.Type;

/**
 * The number a device approval's screen shows for the owner to pick on their device, as its
 * `matchSelector` element's trimmed text: 1 to 3 digits, else no number reaches the owner.
 */
export const approvalNumberPattern = /^[0-9]{1,3}$/u;
/** The element text as an approval number, when it is one (`approvalNumberPattern`). */
export const approvalNumberOf = (text: string | undefined) => {
  const trimmed = text?.trim();
  return trimmed !== undefined && approvalNumberPattern.test(trimmed) ? trimmed : undefined;
};
