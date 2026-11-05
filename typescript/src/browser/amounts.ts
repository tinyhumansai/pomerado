import { Schema } from "effect";
import { Amount, parseAmount } from "../runtime/amounts.js";

/**
 * One amount as `readAmount` reads it: the amount the element shows, null when it shows none or
 * more than one; each struck-out amount beside it, such as an old price or a waived fee; and the
 * element's visible text without the struck-out part, with a space between a superscript and the
 * text beside it where two digits meet. Decode a call's result with it.
 */
export const AmountRead = Schema.Struct({
  amount: Schema.NullOr(Amount),
  struck: Schema.Array(Amount),
  text: Schema.String,
});
export type AmountRead = typeof AmountRead.Type;

/**
 * The lines of a bill as `readAmounts` reads them, each as `AmountRead` with its `label`; `label`
 * and `text` are null when the row shows no such element.
 */
export const AmountLines = Schema.Array(
  Schema.Struct({
    label: Schema.NullOr(Schema.String),
    amount: Schema.NullOr(Amount),
    struck: Schema.Array(Amount),
    text: Schema.NullOr(Schema.String),
  }),
);
export type AmountLine = (typeof AmountLines.Type)[number];

/**
 * Page code for a Kernel call body, pasted after `visibleTextCode` (./visible-text.ts), whose
 * `visibleTextPage`, `visibleTextOptions` and `visibleTextFailure` it uses. It declares
 * `parseAmount` (../runtime/amounts.ts), `readAmount` and `readAmounts`, which read money as data,
 * in minor units, from what a person sees: a cart's or a bill's lines, fees, tips, donations,
 * wallet deductions and zero-priced gift lines, a total, or the amount an order button names.
 *
 * - `readAmount(locator, { currency, as, maxLength }?)` reads the locator's one rendered match as
 *   `visibleText` does, and returns `{ amount, struck, text }`.
 * - `readAmounts(rows, { label, amount }, { currency, from, limit, as, maxLength }?)` reads a list
 *   of lines in one call, as `readRows` does: `label` and `amount` are CSS selectors inside each
 *   rendered row, and each line comes back `{ label, amount, struck, text }`, `label` and `text`
 *   null when the row shows no such element.
 *
 * Text struck out, by an `s`, `del` or `strike` element or a line-through, on the element or
 * around it, is not the amount: each struck-out element's amount comes back in `struck`, in page
 * order, so "₹120 ₹100" with ₹120 struck out is ₹100, once ₹120, and "₹25 FREE" with ₹25 struck
 * out is zero and free, once ₹25. `amount` is `parseAmount` of the rest, with `currency` as the
 * currency of a bare number or a symbol several currencies share, such as the currency the page
 * shows its prices in: an amount shown with a minus, or in brackets around an amount that shows
 * its currency, is negative, FREE is zero with `free`, and text with no amount or two numbers is
 * null, so read the element that holds the amount, never a whole line or card.
 * A no-break or thin space that groups digits, as in "1 234,50 €", groups them for `parseAmount`,
 * though `text` shows a plain space there, as `visibleText` does. A superscript reads apart from
 * the text beside it only where two digits meet: "$12" with a raised "97" is two numbers, so null,
 * and its `text` is "$12 97", while "$12." with a raised "97" is $12.97.
 *
 * They read the page as it is now and never wait, and fail as `visibleText` and `readRows` fail
 * (`VisibleTextFailure`: `not_found`, `hidden_only`, `ambiguous`, `too_long`).
 */
export const amountCode = String.raw`
const parseAmount = ${String(parseAmount)};
const amountOf = (read, currency) => ({
  amount: parseAmount(read.grouped, { currency }),
  struck: read.struck.map((text) => parseAmount(text, { currency })).filter((amount) => amount !== null),
  text: read.text,
});
const readAmount = async (locator, options = {}) => {
  const { as, maxLength } = visibleTextOptions(options);
  const reads = await locator.evaluateAll(visibleTextPage, { as, lines: false, split: true });
  const shown = reads.filter((read) => read !== null);
  const counts = { matched: reads.length, rendered: shown.length };
  const seen = reads.length + " matched, " + shown.length + " rendered";
  if (reads.length === 0) throw visibleTextFailure("not_found", seen, counts);
  if (shown.length === 0) throw visibleTextFailure("hidden_only", seen, counts);
  if (shown.length > 1) throw visibleTextFailure("ambiguous", seen, counts);
  if (shown[0].text.length > maxLength)
    throw visibleTextFailure("too_long", shown[0].text.length + " characters, over the " + maxLength + " limit",
      { length: shown[0].text.length, maxLength });
  return amountOf(shown[0], options.currency);
};
const readAmounts = async (rows, fields, options = {}) => {
  const { as, maxLength } = visibleTextOptions(options);
  if (typeof fields?.label !== "string" || typeof fields?.amount !== "string")
    throw new TypeError("readAmounts needs label and amount as CSS selectors inside each row");
  const from = options.from ?? 0;
  const limit = options.limit ?? null;
  if (!Number.isInteger(from) || from < 0) throw new TypeError("from must be a non-negative integer");
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw new TypeError("limit must be a non-negative integer");
  const entries = [
    ["label", { selector: fields.label, attribute: null, required: false, lines: null }],
    ["amount", { selector: fields.amount, attribute: null, required: false, lines: null, split: true }],
  ];
  const answer = await rows.evaluateAll(visibleTextPage, { as, lines: false, maxLength, from, limit, fields: entries });
  if (answer.hidden !== undefined)
    throw visibleTextFailure("hidden_only", answer.hidden + " matched, 0 rendered", { matched: answer.hidden, rendered: 0 });
  if (answer.tooLong !== undefined)
    throw visibleTextFailure("too_long",
      "field " + answer.tooLong.field + " in row " + answer.tooLong.row + " has " + answer.tooLong.length
        + " characters, over the " + maxLength + " limit",
      { ...answer.tooLong, maxLength });
  return answer.records.map((record) =>
    record.amount === null
      ? { label: record.label, amount: null, struck: [], text: null }
      : { label: record.label, ...amountOf(record.amount, options.currency) });
};
`;
