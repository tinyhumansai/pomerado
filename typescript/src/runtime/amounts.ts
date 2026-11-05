/** An amount of money as a page shows it, in the currency's minor units, such as paise or cents. */
export interface Amount {
  /**
   * Whole minor units; negative where the text shows a deduction, by a minus or by brackets, as
   * `parseAmount` reads them.
   */
  readonly minor: number;
  /** The ISO 4217 code the text names, or the caller's when it names none it can tell. */
  readonly currency: string | null;
  /** The text said free instead of giving a number. */
  readonly free: boolean;
}

/**
 * The one amount `text` shows, such as "₹1,23,456.50", "- ₹20", "(₹20)", "1 234,50 €" or "FREE",
 * in the currency's minor units, or null when the text shows no amount or more than one number,
 * such as an old and a new price ("₹120 ₹100") or a count and a price ("2 x ₹14").
 *
 * - Grouping: the last point or comma is the decimal mark unless exactly three digits follow it.
 *   Before three digits it groups thousands when the same mark comes earlier in the number
 *   (1,234,567), and is the decimal mark when only other separators do (1.234,567). Alone in the
 *   number, a mark before three digits is the decimal mark when the whole part is 0 ("₹0.500" is
 *   50 paise), and so is a point in a currency with three decimals ("KWD 1.500" is 1500 fils).
 *   Otherwise it groups thousands in a currency with no decimals ("IDR 10.000" is 10000), as a
 *   lone comma does (1,234 is 1234) and a lone point does when a digit past the currency's
 *   decimals is not 0 ("€1.234" is 1234 euros, as a euro has two decimals). Any other lone point
 *   ("₹74.500" could be 74.50 or 74500), and a comma in a currency with three decimals, could
 *   mean either and is no amount. Groups of three (1,234,567), Indian groups of two before the
 *   last three (1,23,456), and apostrophes, no-break or thin spaces (1 234) group; a plain space
 *   never does. Mixed or uneven groups, a decimal mark that also groups the digits before it
 *   (1,234,56), and a point or comma right before the number with no digit before it ("₹.50"; the
 *   point of "Rs." is the marker's own) are no amount.
 * - Currency: ₹, Rs and INR are INR; € EUR; £ GBP; US$ USD; and an ISO 4217 code written next to
 *   the number, before or after it, counts as itself whatever words follow it ("29.99 USD each" is
 *   in dollars, "29,99 EUR TTC" in euros). A code that is also a common English word or a unit
 *   (ALL, BAM, BOB, COP, CUP, GEL, KGS, MAD, MOP, PEN, RUB, SOS, TOP and TRY) counts only when it
 *   is `options.currency`, and is otherwise a word, so "TOP 10" and "74 ALL INCLUSIVE" name no
 *   currency. A code written right against `$` or `¥` counts as itself, even one of those
 *   ("USD$20", "MOP$20"). Any other `$` or `¥`, which several currencies share, and a number with
 *   no currency take `options.currency`, else null. The text's own currency wins over the caller's.
 * - Decimals: a currency has as many as ICU's currency data gives it (two when there is no
 *   currency), which is 0 for a few that ISO 4217 gives two, such as IDR and HUF. A value with
 *   more decimals than that is no amount, unless the extra digits are zeros.
 * - Sign: a minus (a hyphen-minus or hyphen in any of its forms, a minus sign or an en dash) right
 *   before the number or the currency ("-₹20", "₹-20", "− ₹20") is a deduction. So is a dash and a
 *   space between the currency and the number ("₹ - 20"), or opening text that shows a currency on
 *   either side of the number ("- ₹20", "- 20,00 €"), and so are brackets around an amount that
 *   shows its currency, even if they close before it ("(₹20)", "(20.00) USD"). Brackets around a
 *   bare number, such as a count ("(2)"), are not, nor is a spaced dash before one ("- 20") or a
 *   dash with words before it, as in "Delivery - ₹20".
 * - Scale: a percent sign or a magnitude (k, K, L, lakh, lac, Cr, crore, M, mn, bn, thousand,
 *   million or billion, as a whole word) right after the number or its currency, as in "10% off",
 *   "₹1.5K" or "₹1.2 Cr", makes the text no amount.
 * - Free: text with no number that says free is zero, marked `free`; with a number other than
 *   zero, as in "Free delivery above ₹199", it is no amount.
 *
 * It is pure and self-contained: the page code of `amountCode` embeds this same function.
 */
export const parseAmount = (text: string, options: { readonly currency?: string } = {}): Amount | null => {
  const value = String(text ?? "");
  const numbers = [...value.matchAll(/\d+(?:[.,'’\u00A0\u202F\u2009]\d+)*/gu)];
  const free = /\bfree\b/iu.test(value);
  const fallback = options.currency ?? null;
  if (numbers.length === 0) return free ? { minor: 0, currency: fallback, free: true } : null;
  if (numbers.length > 1) return null;
  const token = numbers[0]?.[0] ?? "";
  const index = numbers[0]?.index ?? 0;
  let head = value.slice(0, index);
  // A decimal mark with no digit before it, as in "₹.50"; the point of "Rs." is the marker's own.
  if (/[.,]$/u.test(head) && !/(?<!\p{L})Rs\.$/u.test(head)) return null;
  const known = (code: string) => {
    try {
      return Intl.supportedValuesOf("currency").includes(code);
    } catch {
      return false;
    }
  };
  // ISO 4217 codes that are also common English words or a unit, as in "TOP 10", "74 ALL INCLUSIVE"
  // or "5 KGS": each names its currency only when it is the caller's, and is otherwise a word.
  const words = ["ALL", "BAM", "BOB", "COP", "CUP", "GEL", "KGS", "MAD", "MOP", "PEN", "RUB", "SOS", "TOP", "TRY"];
  // What a marker names: a currency, "shared" for a symbol several currencies use, or nothing.
  const codeOf = (marker: string | undefined) => {
    const mark = marker?.trim();
    if (mark === undefined || mark === "") return undefined;
    if (mark === "₹" || /^Rs\.?$/u.test(mark)) return "INR";
    if (mark === "€") return "EUR";
    if (mark === "£") return "GBP";
    if (mark === "US$") return "USD";
    if (mark === "$" || mark === "¥") return "shared";
    // A code right against a shared symbol names its currency, word or not: "USD$20", "MOP$20".
    const joined = /^([A-Z]{3})[$¥]$/u.exec(mark)?.[1];
    if (joined !== undefined) return known(joined) ? joined : "shared";
    if (words.includes(mark) && mark !== options.currency) return undefined;
    return known(mark) ? mark : undefined;
  };
  const strip = (pattern: RegExp) => {
    const found = pattern.exec(head);
    if (found === null) return undefined;
    head = head.slice(0, found.index);
    return found[0];
  };
  // Minus: hyphen-minus, hyphen, non-breaking hyphen, en dash, minus sign, small and fullwidth hyphen-minus.
  const minus = /[-\u2010\u2011\u2013\u2212\uFE63\uFF0D]/u;
  let negative = false;
  let bracket = strip(/\(\s*$/u) !== undefined;
  // A sign right before the number: "-20", "₹-20", or a minus sign and a space, "− 20".
  const attached = strip(/[-+\u2010\u2011\u2013\u2212\uFE63\uFF0D]$/u) ?? strip(/\u2212\s+$/u);
  if (attached !== undefined && minus.test(attached)) negative = true;
  // A dash and a space between a currency and the number: "₹ - 20", "USD - 20". After a word, even
  // one that looks like a code, as in "TOP - 20", it is no minus.
  const spaced = attached === undefined
    ? strip(/(?<=(?:₹|€|£|\$|¥|(?<!\p{L})(?:Rs\.?|[A-Z]{3}))\s*)[-\u2010\u2011\u2013\uFE63\uFF0D]\s+$/u)
    : undefined;
  const before = codeOf(
    strip(/(?:US\$|(?<!\p{L})[A-Z]{3}[$¥]|₹|€|£|\$|¥)\s*$/u) ?? strip(/(?<!\p{L})(?:Rs\.?|[A-Z]{3})\s*$/u),
  );
  if (spaced !== undefined && before !== undefined) negative = true;
  if (before !== undefined) {
    // A sign before the currency: "-₹20", "− ₹20", or a dash that opens the text, "- ₹20".
    const outer =
      strip(/[-+\u2010\u2011\u2013\u2212\uFE63\uFF0D]$/u) ??
      strip(/\u2212\s+$/u) ??
      (/^\s*[-\u2010\u2011\u2013\uFE63\uFF0D]\s+$/u.test(head) ? strip(/[-\u2010\u2011\u2013\uFE63\uFF0D]\s+$/u) : undefined);
    if (outer !== undefined && minus.test(outer)) negative = true;
  }
  if (strip(/\(\s*$/u) !== undefined) bracket = true;
  // A percent sign or a magnitude as a whole word, as in "10%", "₹1.5K" or "₹1.2 Cr".
  const scaled = (rest: string) =>
    /^\s*(?:%|[kKLM](?!\p{L}))/u.test(rest) ||
    /^\s*(?:lakhs?|lacs?|cr|crores?|mn|bn|thousands?|millions?|billions?)(?!\p{L})/iu.test(rest);
  let tail = value.slice(index + token.length);
  if (scaled(tail)) return null;
  // A code after the number names a currency whatever words follow it: "29.99 USD each" is in
  // dollars, and "29,99 EUR TTC" in euros. Brackets may close before it, as in "(20.00) USD".
  const closing = bracket ? (/^\s*\)/u.exec(tail)?.[0] ?? "") : "";
  const trailing = /^\s*(?:US\$|[A-Z]{3}[$¥]|₹|€|£|\$|¥|Rs\.?(?!\p{L})|[A-Z]{3}(?!\p{L}))/u.exec(tail.slice(closing.length));
  const after = codeOf(trailing?.[0]);
  if (trailing !== null && after !== undefined) {
    tail = tail.slice(closing.length + trailing[0].length);
    if (scaled(tail)) return null;
  }
  // Brackets are a deduction around an amount that shows its currency, never around a bare count.
  if (bracket && (closing !== "" || /^\s*\)/u.test(tail)) && (before !== undefined || after !== undefined)) negative = true;
  // A dash that opens the text before a number whose currency comes after it, as in "- 20,00 €".
  if (after !== undefined && /^\s*\(?\s*[-\u2010\u2011\u2013\uFE63\uFF0D]\s+$/u.test(head)) negative = true;
  const named = [before, after].filter((code) => code !== undefined && code !== "shared");
  if (new Set(named).size > 1) return null;
  const currency = named[0] ?? fallback;
  let exponent = 2;
  if (currency !== null)
    try {
      exponent = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      exponent = 2;
    }
  // The digits: the last point or comma is the decimal mark unless three digits follow it.
  const parts = token.split(/([.,'’\u00A0\u202F\u2009])/u);
  const groups = parts.filter((_, at) => at % 2 === 0);
  const separators = parts.filter((_, at) => at % 2 === 1);
  const last = separators.at(-1);
  const others = separators.slice(0, -1);
  const lastGroup = groups.at(-1) ?? "";
  let decimal = false;
  if (last === "." || last === ",") {
    if (lastGroup.length !== 3) decimal = true;
    else if (others.length > 0) decimal = others.every((separator) => separator !== last);
    // A lone mark before three digits: the decimal mark after 0, or a point in a currency with
    // three decimals; in a currency with none it can only group thousands. Otherwise a lone comma
    // groups thousands, and so does a lone point when a digit past the currency's decimals is not
    // 0, as in "€1.234", which read as decimals would have one decimal too many. Any other lone
    // point, as in "₹74.500", or a comma in a currency with three decimals, could mean either.
    else if (/^0+$/u.test(groups[0] ?? "")) decimal = true;
    else if (exponent === 3) {
      if (last === ",") return null;
      decimal = true;
    } else if (exponent !== 0 && last === "." && /^0*$/u.test(lastGroup.slice(exponent))) return null;
  }
  // A decimal mark that also groups the digits before it, as in "1,234,56", could mean neither.
  if (decimal && last !== undefined && others.includes(last)) return null;
  const whole = decimal ? groups.slice(0, -1) : groups;
  let fraction = decimal ? lastGroup : "";
  if (new Set(separators.slice(0, whole.length - 1)).size > 1) return null;
  if (whole.length > 1) {
    const first = whole[0] ?? "";
    const rest = whole.slice(1);
    const western = first.length <= 3 && rest.every((group) => group.length === 3);
    const indian =
      first.length <= 2 && (rest.at(-1)?.length ?? 0) === 3 && rest.slice(0, -1).every((group) => group.length === 2);
    if (!western && !indian) return null;
  }
  if (fraction.length > exponent) {
    if (/[^0]/u.test(fraction.slice(exponent))) return null;
    fraction = fraction.slice(0, exponent);
  }
  const units = Number(whole.join("")) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  if (!Number.isSafeInteger(units)) return null;
  if (free && units !== 0) return null;
  return { minor: negative && units !== 0 ? -units : units, currency, free };
};
