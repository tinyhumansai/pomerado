import { Effect } from "effect";
import {
  cardDigitRun,
  cardValueForms,
  isCardSlot,
  shortCardPart,
} from "../destinations/payment-frames.js";
import { callingCode, nationalDigits } from "../destinations/login-field-formats.js";
import { shownForms } from "../privacy/value-forms.js";
import { writtenAsNumber } from "../runtime/input-request.js";

/**
 * A short form of a secret (`shownForms`) counts in source only as a whole token, as the
 * submission guard finds a code: an all-digit form where no digit adjoins it, any other where no
 * letter, mark or digit adjoins it on a side whose own edge is one. A short value, such as a
 * favorite color or a six-digit code, turns up inside a longer word or a timestamp by chance.
 * Redaction, which feeds what a model sees, still masks every form wherever it appears.
 */
const wordClass = "[\\p{L}\\p{M}\\p{N}]";
/** `form` as a pattern that matches it literally. */
const literal = (form: string) => form.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
/** Every place `form` stands as a whole token. */
const tokenPattern = (form: string) => {
  const adjoining = /^[0-9]+$/u.test(form) ? "[0-9]" : wordClass;
  const starts = new RegExp(`^${adjoining}`, "u").test(form);
  const ends = new RegExp(`${adjoining}$`, "u").test(form);
  return new RegExp(
    `${starts ? `(?<!${adjoining})` : ""}${literal(form)}${ends ? `(?!${adjoining})` : ""}`,
    "u",
  );
};

/**
 * What a page may write between a phone number's digits, three at most: whitespace, a dash, a dot,
 * a slash, a bracket, a plus, an invisible mark, or a URL's percent escape of one. Digits in
 * another script, digits a page's markup or entities split, and a URL encoded twice aren't matched.
 */
const phoneGap = "(?:[\\s\\p{Pd}\\p{Cf}().+/]|%[0-9A-Fa-f]{2}){0,3}";
/**
 * Fewer digits than this after the calling code say too little to mask on their own: such a number
 * counts only behind its calling code, written in international form.
 */
const phoneLocalLeast = 7;
/**
 * Fewer digits than this after the calling code are no country's number, and a number of all zeros
 * has none left: patterns of so little would mask its calling code alone.
 */
const phoneLocalFewest = 4;
/** A pattern for `digits` with `phoneGap` between each. */
const gapped = (digits: string) => [...digits].join(phoneGap);
/** A pattern for `digits` that a cut may end after any of them. */
const cutGapped = (digits: string) =>
  [...digits].reduceRight(
    (rest, digit) => (rest === "" ? digit : `${digit}(?:${phoneGap}${rest})?`),
    "",
  );

/**
 * The forms of a phone number beyond the value as given, as a site writes it back in its own way:
 * its digits, with and without its calling code (`digits`); a global pattern for those digits
 * with `phoneGap` between each, with a trunk 0 or none and no digit adjoining them, though a percent
 * escape may stand right before them (`run`); and one for the start of the run where a cut ended
 * the text (`cut`). A number with too few digits after its calling code (`phoneLocalLeast`) has no
 * `digits`, and its patterns match only with that code, after a `+` or `00`. Undefined for a value
 * not written as a number, such as a host's handle, one too short to say its calling code, or one
 * with too little after that code (`phoneLocalFewest`). Any marks may group its digits, as a saved
 * login or a login of another kind never met the shape a phone answer must have, and what a letter
 * starts, such as an extension, is no part of the number. `run` also counts the value as given,
 * since it goes first: an extension or a `(00NN)` lead would stay beside what it masks.
 */
const phoneForms = (given: string) => {
  if (!writtenAsNumber(given)) return undefined;
  const number = given.replace(/\p{L}.*$/su, "");
  const code = callingCode(number) ?? "";
  const local = (nationalDigits(number) ?? number.replaceAll(/[^0-9]/gu, "")).replace(/^0+/u, "");
  const short = local.length < phoneLocalLeast;
  if (local.length < phoneLocalFewest || (short && code === "")) return undefined;
  const edge = "(?:(?<![0-9])|(?<=%[0-9A-Fa-f]{2}))";
  // A gap only after a lead the pattern needs: an optional one would take in what stands before.
  const lead = `${edge}${short ? `(?:\\+|%2[Bb]|00)${phoneGap}` : "[+(]?"}`;
  const trunk = `(?:0${phoneGap})?`;
  const calling = code === "" ? "" : `(?:${gapped(code)}${phoneGap})${short ? "" : "?"}`;
  const cuts = [
    cutGapped(`${code}${local}`),
    ...(code === "" ? [] : [`${gapped(code)}${phoneGap}0(?:${phoneGap}${cutGapped(local)})?`]),
    ...(short ? [] : [`${trunk}${cutGapped(local)}`]),
  ];
  return {
    digits: short ? [] : [local, `${code}${local}`],
    run: new RegExp(`${literal(given)}|${lead}${calling}${trunk}${gapped(local)}(?![0-9])`, "gu"),
    cut: new RegExp(`${lead}(?:${cuts.join("|")})${phoneGap}$`, "u"),
  };
};

/** Explicit caller secrets live only for this run. This does not detect or classify page data. */
export const makeRunSecrets = () => {
  /** Each registered form, with the pattern source screening counts it by when it is short. */
  const values = new Map<string, RegExp | undefined>();
  /** Each phone number's patterns (`phoneForms`), masked and checked in source alike. */
  const phoneRuns = new Map<string, { readonly run: RegExp; readonly cut: RegExp }>();
  /**
   * Registers each form a page or URL can show the value in (`shownForms`). For a value that may
   * be a `phone` number, its digits and their usual groupings count too (`phoneForms`), when it
   * is written as a number, since a site writes the number back in its own format and a `national`
   * field takes it without its calling code.
   */
  const register = (value: string, kind?: "phone") => {
    const phone = kind === "phone" ? phoneForms(value) : undefined;
    if (phone !== undefined) phoneRuns.set(phone.run.source, phone);
    for (const form of [value, ...(phone?.digits ?? [])])
      for (const [shownForm, short] of shownForms(form))
        if (!short) values.set(shownForm, undefined);
        else if (!values.has(shownForm)) values.set(shownForm, tokenPattern(shownForm));
  };
  /** Whether `text` holds a registered phone number's digits (`phoneForms`). */
  const holdsPhone = (text: string) =>
    [...phoneRuns.values()].some(({ run }) => text.search(run) !== -1);
  /**
   * A payment card's own patterns, masked only in what a model or log sees (`redact`), never
   * checked in source: a card number's digits in any grouping, and a short card part (a security
   * code, a short expiry or postal code) only where no digit adjoins it, so "ZX1239" and a file's
   * `123` stay as they are.
   */
  const cardPatterns = new Map<string, RegExp>();
  /** Registers a card number's digit run (`pattern`, global), masked whatever its grouping. */
  const registerCardPattern = (pattern: RegExp) => {
    cardPatterns.set(pattern.source, pattern);
  };
  /** Registers a short card part, of a few characters, as whole digit tokens. */
  const registerCardToken = (value: string) => {
    for (const [shownForm] of shownForms(value))
      registerCardPattern(new RegExp(`(?<![0-9])${literal(shownForm)}(?![0-9])`, "gu"));
  };
  const ordered = () => [...values].sort(([left], [right]) => right.length - left.length);
  const redact = (text: string) =>
    [...cardPatterns.values()].reduce(
      (result, pattern) => result.replace(pattern, "[private]"),
      ordered().reduce(
        (result, [secret]) => result.split(secret).join("[private]"),
        // Before the values, which would leave a calling code that stands beside the digits.
        [...phoneRuns.values()].reduce(
          (result, { run }) => result.replace(run, "[private]"),
          text,
        ),
      ),
    );
  /** The longest proper prefix of a registered form that `text` ends with, as a length. */
  const splitPrefix = (text: string) =>
    ordered().reduce((longest, [secret]) => {
      for (let length = Math.min(secret.length - 1, text.length); length > longest; length--)
        if (text.endsWith(secret.slice(0, length))) return length;
      return longest;
    }, 0);
  /**
   * Redacts text a cut ended, so a secret the cut split leaves no prefix at its end either, nor
   * behind the replacement character a cut through a character of several bytes reads back as.
   */
  const redactCut = (text: string) => {
    const redacted = redact(text.replace(/\uFFFD+$/u, ""));
    return [...phoneRuns.values()].reduce(
      (result, { cut }) => result.replace(cut, ""),
      redacted.slice(0, redacted.length - splitPrefix(redacted)),
    );
  };
  const assertAbsent = (text: string) =>
    Effect.suspend(() =>
      holdsPhone(text) ||
      ordered().some(([secret, token]) =>
        token === undefined ? text.includes(secret) : token.test(text),
      )
        ? Effect.fail(new Error("Source contains a caller-supplied secret"))
        : Effect.void,
    );
  const json = (value: unknown) =>
    // error-reporting-allow: typed-recovery an observation getter may throw raw secrets, so only the finite serialization failure crosses this redaction boundary
    Effect.try({
      try: () => {
        const seen = new WeakSet<object>();
        const visit = (item: unknown): unknown => {
          if (typeof item === "string") return redact(item);
          // A site's JSON may hold the number as a number.
          if (typeof item === "number" && holdsPhone(String(item))) return "[private]";
          if (item === null || typeof item !== "object") return item;
          if (seen.has(item)) throw new Error("Observation must be JSON serializable");
          seen.add(item);
          const result: unknown = Array.isArray(item)
            ? item.map(visit)
            : Object.fromEntries(
                Object.entries(item).map(([key, entry]) => [redact(key), visit(entry)]),
              );
          seen.delete(item);
          return result;
        };
        return visit(value);
      },
      catch: () => new Error("Observation must be JSON serializable"),
    });
  return {
    register,
    registerCardPattern,
    registerCardToken,
    redact,
    redactCut,
    assertAbsent,
    json,
    clear: () => {
      values.clear();
      phoneRuns.clear();
      cardPatterns.clear();
    },
  };
};
export type RunSecrets = ReturnType<typeof makeRunSecrets>;

/**
 * Registers one `secret` answer of kind `kind`. A card answer is also masked in the forms a page
 * shows it in (`cardValueForms`), a short part only as a whole token, and a card number's digits
 * in any grouping.
 */
export const registerSecretAnswer = (secrets: RunSecrets, kind: string | undefined, value: string) => {
  if (!isCardSlot(kind)) return secrets.register(value);
  for (const form of cardValueForms(kind, value))
    if (form.length <= shortCardPart) secrets.registerCardToken(form);
    else secrets.register(form);
  const run = kind === "card_number" ? cardDigitRun(value) : undefined;
  if (run !== undefined) secrets.registerCardPattern(run);
};
