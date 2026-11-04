/** An amount of money as a page shows it, in the currency's minor units, such as paise or cents. */
export interface Amount {
  /** Whole minor units; negative for a deduction, such as a discount or a wallet. */
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
 * - Grouping: the last point or comma is the decimal mark unless exactly three digits follow it
 *   (then it groups thousands, so 1,234 and 1.234 are both 1234, and 1,5 is 1.5). Groups of three
 *   (1,234,567), Indian groups of two before the last three (1,23,456), and no-break or thin
 *   spaces (1 234) group; a plain space never does, and mixed or uneven groups are no amount.
 * - Currency: ₹, Rs and INR are INR; € EUR; £ GBP; US$ USD; and an ISO 4217 code written next to
 *   the number counts as itself. `$` and `¥`, which several currencies share, and a number with
 *   no currency take `options.currency`, else null. The text's own currency wins over the
 *   caller's. A value with more decimals than its currency has (two by default) is no amount.
 * - Sign: a minus (hyphen, minus sign or en dash) right before the number or the currency
 *   ("-₹20", "₹-20", "− ₹20"), or brackets around them ("(₹20)"), is a deduction. A dash with
 *   words before it, as in "Delivery - ₹20", is not.
 * - Free: text with no number that says free is zero, marked `free`; with a number other than
 *   zero, as in "Free delivery above ₹199", it is no amount.
 *
 * It is pure and self-contained: the page code of `amountCode` embeds this same function.
 */
export const parseAmount = (text: string, options: { readonly currency?: string } = {}): Amount | null => {
  const value = String(text ?? "");
  const numbers = [...value.matchAll(/\d+(?:[.,'’   ]\d+)*/gu)];
  const free = /\bfree\b/iu.test(value);
  const fallback = options.currency ?? null;
  if (numbers.length === 0) return free ? { minor: 0, currency: fallback, free: true } : null;
  if (numbers.length > 1) return null;
  const token = numbers[0]?.[0] ?? "";
  const index = numbers[0]?.index ?? 0;
  const known = (code: string) => {
    try {
      return Intl.supportedValuesOf("currency").includes(code);
    } catch {
      return false;
    }
  };
  // What a marker names: a currency, "shared" for a symbol several currencies use, or nothing.
  const codeOf = (marker: string | undefined) => {
    const mark = marker?.trim();
    if (mark === undefined || mark === "") return undefined;
    if (mark === "₹" || /^Rs\.?$/u.test(mark)) return "INR";
    if (mark === "€") return "EUR";
    if (mark === "£") return "GBP";
    if (mark === "US$") return "USD";
    if (mark === "$" || mark === "¥") return "shared";
    return known(mark) ? mark : undefined;
  };
  let head = value.slice(0, index);
  const strip = (pattern: RegExp) => {
    const found = pattern.exec(head);
    if (found === null) return undefined;
    head = head.slice(0, found.index);
    return found[0];
  };
  const minus = /[-−–]/u;
  let negative = false;
  let bracket = strip(/\(\s*$/u) !== undefined;
  // A sign right before the number: "-20", "₹-20", or a minus sign and a space, "− 20".
  const attached = strip(/[-−–+]$/u) ?? strip(/−\s+$/u);
  if (attached !== undefined && minus.test(attached)) negative = true;
  const before = codeOf(strip(/(?:US\$|₹|€|£|\$|¥)\s*$/u) ?? strip(/(?<!\p{L})(?:Rs\.?|[A-Z]{3})\s*$/u));
  if (before !== undefined) {
    // A sign before the currency: "-₹20", "− ₹20", or a dash that opens the text, "- ₹20".
    const outer =
      strip(/[-−–+]$/u) ?? strip(/−\s+$/u) ?? (/^\s*[-–]\s+$/u.test(head) ? strip(/[-–]\s+$/u) : undefined);
    if (outer !== undefined && minus.test(outer)) negative = true;
    if (strip(/\(\s*$/u) !== undefined) bracket = true;
  }
  let tail = value.slice(index + token.length);
  const trailing = /^\s*(?:₹|€|£|\$|¥|(?:Rs\.?|[A-Z]{3})(?!\p{L}))/u.exec(tail);
  const after = codeOf(trailing?.[0]);
  if (trailing !== null && after !== undefined) tail = tail.slice(trailing[0].length);
  if (bracket && /^\s*\)/u.test(tail)) negative = true;
  const named = [before, after].filter((code) => code !== undefined && code !== "shared");
  if (new Set(named).size > 1) return null;
  const currency = named[0] ?? fallback;
  // The digits: the last point or comma is the decimal mark unless three digits follow it.
  const parts = token.split(/([.,'’   ])/u);
  const groups = parts.filter((_, at) => at % 2 === 0);
  const separators = parts.filter((_, at) => at % 2 === 1);
  let whole = groups;
  let fraction = "";
  const last = separators.at(-1);
  const lastGroup = groups.at(-1) ?? "";
  if (last === "." || last === ",") {
    const others = separators.slice(0, -1);
    if (lastGroup.length !== 3 || (others.length > 0 && others.every((separator) => separator !== last))) {
      fraction = lastGroup;
      whole = groups.slice(0, -1);
    }
  }
  if (new Set(separators.slice(0, whole.length - 1)).size > 1) return null;
  if (whole.length > 1) {
    const first = whole[0] ?? "";
    const rest = whole.slice(1);
    const western = first.length <= 3 && rest.every((group) => group.length === 3);
    const indian =
      first.length <= 2 && (rest.at(-1)?.length ?? 0) === 3 && rest.slice(0, -1).every((group) => group.length === 2);
    if (!western && !indian) return null;
  }
  let exponent = 2;
  if (currency !== null)
    try {
      exponent = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      exponent = 2;
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
