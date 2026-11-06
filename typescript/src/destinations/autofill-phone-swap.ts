import type { AutofillInspection, AutofillStep, FillSlot } from "./autofill-step.js";

// A sign-in page may show one "email or mobile number" box and, once digits are typed, put a phone
// box in its place, often beside a calling-code picker, holding what was typed. The fill then finds
// the box it bound gone from its document. It never types the value again: it judges the screen as
// a fresh one (`followPhoneSwap` in autofill-fill.ts), and what marks that phone box is here.

/** What marks an input as a phone box by its own type, autocomplete or inputmode, or its name. */
const phoneMarks = [
  '[type="tel" i]',
  '[autocomplete="tel" i]',
  '[autocomplete="tel-national" i]',
  '[inputmode="tel" i]',
  ...["phone", "mobile"].flatMap((word) => [`[name*="${word}" i]`, `[id*="${word}" i]`]),
];

/** The one visible phone box a page put in place of the box the host typed: attributes alone. */
export const phoneBoxSelector = `input:is(:not([type]), [type="text" i], [type="tel" i]):is(${phoneMarks.join(", ")})`;

/**
 * Words in a phone box's name, id or autocomplete that name another kind of value, which win over
 * its marks: a one-time code or PIN box may take digits as a phone box does, as may a card's or a
 * postal code's. Each counts as a word of its own, split at a non-letter or a lower-to-upper case
 * change, so `pin` names `pinCode` and never `shipping_phone`.
 */
const otherKinds = new Set([
  "code",
  "otp",
  "totp",
  "pin",
  "passcode",
  "password",
  "email",
  "mail",
  "username",
  "user",
  "card",
  "cvv",
  "cvc",
  "search",
  "zip",
  "postal",
  "captcha",
]);
const wordsOf = (value: string) =>
  value.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/u).map((word) => word.toLowerCase());

/** Whether a field the selector found holds no word of another kind (`otherKinds`). */
export const namesNoOtherKind = (
  field: Pick<AutofillInspection["screen"]["fields"][number], "name" | "id" | "autocomplete">,
) =>
  [field.name, field.id, field.autocomplete].every(
    (value) => value === null || !wordsOf(value).some((word) => otherKinds.has(word)),
  );

/**
 * The step `step` is, once its one identifier field gave way to a phone box: the same submit, on
 * the same screen, with the phone box found by what marks it.
 */
export const swappedStep = (step: AutofillStep<FillSlot>): AutofillStep<FillSlot> => ({
  ...step,
  fields: [{ selector: phoneBoxSelector, slot: "phone", accepts: ["phone"] }],
});
