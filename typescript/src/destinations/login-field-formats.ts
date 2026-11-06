import { formatDate } from "../browser/form-controls.js";
import { unmarkedNumber } from "../runtime/input-request.js";
import { DateOfBirthFormat } from "./autofill-contracts.js";

/** A date of birth an owner typed, year first, as the ISO date a record keeps; undefined if none. */
export const parseDateOfBirth = (value: string): string | undefined => {
  const parts = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/u.exec(value);
  if (parts === null) return undefined;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString().slice(0, 10);
};
/** The formats that write the whole date, rather than one part of a split date. */
const wholeDates = DateOfBirthFormat.literals.filter(
  (format) => format.includes("Y") && format.includes("M") && format.includes("D"),
);
/**
 * An ISO date of birth in each whole-date layout a page may show it in, which masking registers;
 * never one part alone, such as a month's "4", which is no secret to mask everywhere.
 */
export const wholeDateLayouts = (iso: string) =>
  parseDateOfBirth(iso) === undefined
    ? []
    : [...new Set(wholeDates.map((format) => formatDate(iso, format)))];

/** The country calling codes one or two digits long; every other code is three. */
const shortCallingCodes = new Set([
  ...["1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39"],
  ...["40", "41", "43", "44", "45", "46", "47", "48", "49"],
  ...["51", "52", "53", "54", "55", "56", "57", "58"],
  ...["60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86"],
  ...["90", "91", "92", "93", "94", "95", "98"],
]);

/**
 * What ends the number in a value that goes on past it, as an extension does: a letter, or a `#`,
 * `;` or `*` after a digit. One before the digits ends nothing, so `#1234567` is those digits.
 */
const numberEnd = /\p{L}|(?<=[0-9].*)[#;*]/su;
/** `value` up to what ends its number (`numberEnd`), or whole when nothing does. */
export const numberPart = (value: string) => value.split(numberEnd, 1)[0] ?? "";

/**
 * A phone number written in international form: its digits after the `+`, `00` or `+00`, which a
 * bracket may open. Undefined for a value that goes on past its number (`numberEnd`): a letter may mean a
 * host's handle, and an extension's digits aren't the number's.
 */
const internationalDigits = (number: string) => {
  const written = unmarkedNumber(number).trim();
  if (numberEnd.test(written)) return undefined;
  const lead = /^\(?\s*(?:\+(?:00)?|00)/u.exec(written)?.[0];
  return lead === undefined ? undefined : written.slice(lead.length).replaceAll(/[^0-9]/gu, "");
};

/**
 * A phone number's country calling code, digits only, when the number is written in international
 * form, after `+` or `00`; undefined for a number written another way, or that goes on past its
 * digits, which does not say it (`internationalDigits`).
 */
export const callingCode = (number: string) => {
  const digits = internationalDigits(number);
  if (digits === undefined || digits.length < 4 || digits.startsWith("0")) return undefined;
  const short = [digits.slice(0, 1), digits.slice(0, 2)].find((code) => shortCallingCodes.has(code));
  return short ?? digits.slice(0, 3);
};

/**
 * A phone number as a field that takes only the local number takes it (`PhoneFormat` `national`):
 * the digits after its country calling code (`callingCode`). Undefined for a number that does not
 * say its calling code, such as one saved without `+` or `00`, which the host types as saved.
 */
export const nationalDigits = (number: string) => {
  const code = callingCode(number);
  return code === undefined ? undefined : internationalDigits(number)?.slice(code.length);
};

/**
 * The calling codes a picker's text names, each as its digits: a `+` and those digits, as in
 * "India (+91)", "+91" or "🇮🇳 +91". Digits that a space or hyphen joins to them belong to the
 * code, so "+1 268" names 1268 and never 1, and digits with no `+` before them name nothing, as
 * they may be a list position or a number of the page's own. Self-contained: page code runs it
 * from its own source.
 */
export const shownCallingCodes = (text: string): readonly string[] =>
  Array.from(String(text).matchAll(/\+(\d+(?:[\s\-‐-–]\d+)*)/gu), (match) =>
    (match[1] ?? "").replace(/\D/gu, ""),
  );

/**
 * A text with each calling code it shows (`shownCallingCodes`) left out, as a picker that shows
 * "India (+91)" says the country alone. Page code runs it from its own source.
 */
export const withoutCallingCodes = (text: string): string =>
  String(text).replaceAll(/\+\d+(?:[\s\-‐-–]\d+)*/gu, " ");

/**
 * Whether a picker's text names the calling code `code` (`shownCallingCodes`). Page code runs it
 * from its own source, beside `shownCallingCodes`.
 */
export const namesCallingCode = (text: string, code: string): boolean =>
  shownCallingCodes(text).includes(code);

/**
 * The digits a phone box may hold for `number` when the page, not the host, wrote it there, each
 * whole. `whole` is the number itself: after its calling code for a number that says one, else
 * its own digits. `national` is a number's national digits alone (`nationalDigits`), or after a
 * trunk 0, which say no country, so a box that holds them needs a picker beside it to say the
 * number's own; none for a number that says no calling code.
 */
export const heldPhoneDigits = (
  number: string,
): { readonly whole: readonly string[]; readonly national: readonly string[] } => {
  const code = callingCode(number);
  const national = nationalDigits(number);
  return code === undefined || national === undefined
    ? { whole: [number.replaceAll(/[^0-9]/gu, "")], national: [] }
    : { whole: [`${code}${national}`], national: [national, `0${national}`] };
};
