// Failure modes covered: an amount read in another grouping than the page wrote it, such as an
// Indian 1,23,456 or a European 1.234,50, coming out a hundred or a thousand times off; a
// deduction read as a charge because its minus sign was a typographic one, came after the symbol
// or was written as brackets; a free line read as no amount; text holding two numbers, such as an
// old and a new price or a count and a price, read as one of them; a currency guessed from a
// symbol several currencies share; and a value with more decimals than its currency has, rounded
// rather than refused; a lone point before three digits that could be decimals, a percentage, a
// magnitude such as K, L or Cr, or a leading decimal mark read as a plain amount, off by a factor
// of a hundred or more, and a lone point that can only group thousands refused; and a word that
// only looks like a currency code, such as TOP or ALL, taken for one, or a code the text names
// given up for the caller's because words in capitals follow it.
import { describe, expect, it } from "vitest";
import { parseAmount } from "../../src/runtime/amounts.js";

const inr = (minor: number) => ({ minor, currency: "INR", free: false });

describe("parseAmount", () => {
  it("reads rupee amounts in every way pages write them, in paise", () => {
    expect(parseAmount("₹74")).toEqual(inr(7400));
    expect(parseAmount("₹74.5")).toEqual(inr(7450));
    expect(parseAmount("₹ 1,23,456.50")).toEqual(inr(12345650));
    expect(parseAmount("₹1,00,000")).toEqual(inr(10000000));
    expect(parseAmount("Rs. 499")).toEqual(inr(49900));
    expect(parseAmount("Rs.499")).toEqual(inr(49900));
    expect(parseAmount("Rs 1,499.00")).toEqual(inr(149900));
    expect(parseAmount("INR 25")).toEqual(inr(2500));
    expect(parseAmount("Pay ₹74 on delivery (Cash/UPI)")).toEqual(inr(7400));
    // A word after the number that starts like a magnitude is no magnitude.
    expect(parseAmount("₹74 Lowest price")).toEqual(inr(7400));
  });

  it("reads a deduction as negative, whatever sign or brackets the page uses", () => {
    expect(parseAmount("-₹20")).toEqual(inr(-2000));
    expect(parseAmount("− ₹20")).toEqual(inr(-2000));
    expect(parseAmount("₹-20")).toEqual(inr(-2000));
    expect(parseAmount("(₹20)")).toEqual(inr(-2000));
    expect(parseAmount("+ ₹20")).toEqual(inr(2000));
    expect(parseAmount("\u2010₹20")).toEqual(inr(-2000));
    expect(parseAmount("\uFF0D₹20")).toEqual(inr(-2000));
    // Brackets mark a deduction around an amount, never around a bare number such as a count.
    expect(parseAmount("(2)", { currency: "INR" })).toEqual(inr(200));
    expect(parseAmount("₹(20)")).toEqual(inr(-2000));
  });

  it("reads a dash and a space that open the text as a minus, wherever the currency stands", () => {
    const eur = (minor: number) => ({ minor, currency: "EUR", free: false });
    const usd = (minor: number) => ({ minor, currency: "USD", free: false });
    expect(parseAmount("- ₹20")).toEqual(inr(-2000));
    expect(parseAmount("- USD 20")).toEqual(usd(-2000));
    expect(parseAmount("− 20,00 €")).toEqual(eur(-2000));
    expect(parseAmount("- 20,00 €")).toEqual(eur(-2000));
    expect(parseAmount("– 20,00 €")).toEqual(eur(-2000));
    expect(parseAmount("- 20 USD")).toEqual(usd(-2000));
    expect(parseAmount("– 20 USD")).toEqual(usd(-2000));
    expect(parseAmount("(- 20,00 €)")).toEqual(eur(-2000));
    // With words before it, or no currency to show it is an amount, a dash is no minus.
    expect(parseAmount("Rabatt - 20,00 €")).toEqual(eur(2000));
    expect(parseAmount("Delivery - 20 USD")).toEqual(usd(2000));
    expect(parseAmount("- 20", { currency: "INR" })).toEqual(inr(2000));
    expect(parseAmount("- 20 TOP", { currency: "INR" })).toEqual(inr(2000));
  });

  it("reads a dash and a space between the currency and the number as a minus", () => {
    expect(parseAmount("₹ - 20")).toEqual(inr(-2000));
    expect(parseAmount("₹- 20")).toEqual(inr(-2000));
    expect(parseAmount("Rs. - 20")).toEqual(inr(-2000));
    expect(parseAmount("USD - 20")).toEqual({ minor: -2000, currency: "USD", free: false });
    expect(parseAmount("€ - 20,00")).toEqual({ minor: -2000, currency: "EUR", free: false });
    expect(parseAmount("$ - 20", { currency: "USD" })).toEqual({ minor: -2000, currency: "USD", free: false });
    // After a word, even a code that is one, or capitals that name no currency, it is no minus.
    expect(parseAmount("TOP - 20", { currency: "INR" })).toEqual(inr(2000));
    expect(parseAmount("FEE - 20", { currency: "INR" })).toEqual(inr(2000));
  });

  it("reads brackets that close before the currency as a deduction in that currency", () => {
    expect(parseAmount("(20.00) USD")).toEqual({ minor: -2000, currency: "USD", free: false });
    expect(parseAmount("(20,00) €")).toEqual({ minor: -2000, currency: "EUR", free: false });
    expect(parseAmount("(-20) USD")).toEqual({ minor: -2000, currency: "USD", free: false });
    // Brackets around a bare number stay a count, and a word after them names no currency.
    expect(parseAmount("(2) items", { currency: "INR" })).toEqual(inr(200));
    expect(parseAmount("(2) TOP", { currency: "INR" })).toEqual(inr(200));
  });

  it("reads a code written right against $ or ¥ as that currency, word or not", () => {
    expect(parseAmount("USD$20", { currency: "EUR" })).toEqual({ minor: 2000, currency: "USD", free: false });
    expect(parseAmount("AUD$20", { currency: "USD" })).toEqual({ minor: 2000, currency: "AUD", free: false });
    expect(parseAmount("20 US$", { currency: "EUR" })).toEqual({ minor: 2000, currency: "USD", free: false });
    expect(parseAmount("20 AUD$", { currency: "USD" })).toEqual({ minor: 2000, currency: "AUD", free: false });
    expect(parseAmount("CNY¥20", { currency: "JPY" })).toEqual({ minor: 2000, currency: "CNY", free: false });
    expect(parseAmount("MOP$20", { currency: "HKD" })).toEqual({ minor: 2000, currency: "MOP", free: false });
    expect(parseAmount("(USD$20)")).toEqual({ minor: -2000, currency: "USD", free: false });
    // Capitals that name no currency leave the symbol shared.
    expect(parseAmount("ABC$20", { currency: "USD" })).toEqual({ minor: 2000, currency: "USD", free: false });
  });

  it("reads a free line as zero, and marks it free", () => {
    expect(parseAmount("FREE")).toEqual({ minor: 0, currency: null, free: true });
    expect(parseAmount("Free", { currency: "INR" })).toEqual({ minor: 0, currency: "INR", free: true });
    expect(parseAmount("₹0")).toEqual(inr(0));
  });

  it("reads European and other groupings by where the decimal mark sits", () => {
    expect(parseAmount("€1.234,50")).toEqual({ minor: 123450, currency: "EUR", free: false });
    expect(parseAmount("1 234,50 €")).toEqual({ minor: 123450, currency: "EUR", free: false });
    expect(parseAmount("1 234 EUR")).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("£12.99")).toEqual({ minor: 1299, currency: "GBP", free: false });
    expect(parseAmount("12.345.678", { currency: "EUR" })).toEqual({ minor: 1234567800, currency: "EUR", free: false });
    expect(parseAmount("1,234", { currency: "INR" })).toEqual(inr(123400));
    // A lone point before three digits is a decimal mark where it can only be one, groups thousands
    // where its last digit could be no decimal of the currency, and is no amount where it could be
    // either, before zeros.
    expect(parseAmount("€1.234")).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("1.234 €")).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("1.234", { currency: "EUR" })).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("1.250 €")).toBeNull();
    expect(parseAmount("$12.500", { currency: "USD" })).toBeNull();
    expect(parseAmount("₹0.500")).toEqual(inr(50));
    expect(parseAmount("KWD 1.500")).toEqual({ minor: 1500, currency: "KWD", free: false });
    expect(parseAmount("KWD 1.234")).toEqual({ minor: 1234, currency: "KWD", free: false });
    expect(parseAmount("OMR 0.500")).toEqual({ minor: 500, currency: "OMR", free: false });
    // A currency with no decimals has no decimal point; a comma in one with three could mean either.
    expect(parseAmount("IDR 10.000")).toEqual({ minor: 10000, currency: "IDR", free: false });
    expect(parseAmount("IDR 1.234")).toEqual({ minor: 1234, currency: "IDR", free: false });
    expect(parseAmount("KWD 1,500")).toBeNull();
    expect(parseAmount("1,5", { currency: "EUR" })).toEqual({ minor: 150, currency: "EUR", free: false });
  });

  it("takes the caller's currency only for a bare number or a symbol several currencies share", () => {
    expect(parseAmount("$1,250.00")).toEqual({ minor: 125000, currency: null, free: false });
    expect(parseAmount("$1,250.00", { currency: "USD" })).toEqual({ minor: 125000, currency: "USD", free: false });
    expect(parseAmount("74", { currency: "INR" })).toEqual(inr(7400));
    expect(parseAmount("74")).toEqual({ minor: 7400, currency: null, free: false });
    // The page's own symbol wins over the caller's guess.
    expect(parseAmount("₹74", { currency: "USD" })).toEqual(inr(7400));
    // A code after the number names its currency, whatever words follow it, in capitals or not.
    expect(parseAmount("1\u202F234 EUR")).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("29.99 USD each", { currency: "INR" })).toEqual({ minor: 2999, currency: "USD", free: false });
    expect(parseAmount("20,00 EUR inkl. MwSt.", { currency: "USD" })).toEqual({ minor: 2000, currency: "EUR", free: false });
    expect(parseAmount("1,500 USD per month")).toEqual({ minor: 150000, currency: "USD", free: false });
    expect(parseAmount("29,99 EUR TTC")).toEqual({ minor: 2999, currency: "EUR", free: false });
    expect(parseAmount("100 USD ONLY", { currency: "INR" })).toEqual({ minor: 10000, currency: "USD", free: false });
  });

  it("reads a code that is also a common English word as a word, unless it is the caller's currency", () => {
    // Before the number or after it, with words after it or not.
    expect(parseAmount("TOP 10", { currency: "INR" })).toEqual(inr(1000));
    expect(parseAmount("TRY 30", { currency: "INR" })).toEqual(inr(3000));
    expect(parseAmount("PEN 2")).toEqual({ minor: 200, currency: null, free: false });
    expect(parseAmount("2 CUP", { currency: "INR" })).toEqual(inr(200));
    // KGS, the Kyrgyz som, is far more often kilograms.
    expect(parseAmount("5 KGS", { currency: "INR" })).toEqual(inr(500));
    expect(parseAmount("KGS 5", { currency: "KGS" })).toEqual({ minor: 500, currency: "KGS", free: false });
    expect(parseAmount("74 ALL INCLUSIVE", { currency: "INR" })).toEqual(inr(7400));
    expect(parseAmount("74 ALL-INCLUSIVE", { currency: "INR" })).toEqual(inr(7400));
    expect(parseAmount("74 ALL INCLUSIVE")).toEqual({ minor: 7400, currency: null, free: false });
    // A bare number in brackets is no deduction.
    expect(parseAmount("(TOP 10)", { currency: "INR" })).toEqual(inr(1000));
    // The caller's own currency names it, so brackets around it mark a deduction.
    expect(parseAmount("TRY 30", { currency: "TRY" })).toEqual({ minor: 3000, currency: "TRY", free: false });
    expect(parseAmount("30 TRY ONLY", { currency: "TRY" })).toEqual({ minor: 3000, currency: "TRY", free: false });
    expect(parseAmount("(TRY 30)", { currency: "TRY" })).toEqual({ minor: -3000, currency: "TRY", free: false });
    expect(parseAmount("TRY 30 €", { currency: "TRY" })).toBeNull();
  });

  it("uses the currency's own number of decimals, and refuses more", () => {
    expect(parseAmount("¥1,500", { currency: "JPY" })).toEqual({ minor: 1500, currency: "JPY", free: false });
    expect(parseAmount("¥1,500.50", { currency: "JPY" })).toBeNull();
    expect(parseAmount("₹74.5051")).toBeNull();
    expect(parseAmount("₹74.500")).toBeNull();
    expect(parseAmount("₹74.50")).toEqual(inr(7450));
  });

  it("answers null for text holding no amount, or more than one", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("Not applicable")).toBeNull();
    expect(parseAmount("₹120 ₹100")).toBeNull();
    expect(parseAmount("2 x ₹14")).toBeNull();
    expect(parseAmount("Free delivery above ₹199")).toBeNull();
    expect(parseAmount("1,2,3")).toBeNull();
    expect(parseAmount("₹10 €5")).toBeNull();
    expect(parseAmount("1,234,56")).toBeNull();
    expect(parseAmount("10% off", { currency: "INR" })).toBeNull();
    expect(parseAmount("-10%", { currency: "INR" })).toBeNull();
    expect(parseAmount("Save up to ₹1.5K")).toBeNull();
    expect(parseAmount("₹2L")).toBeNull();
    expect(parseAmount("₹1.2 Cr")).toBeNull();
    expect(parseAmount("$5k", { currency: "USD" })).toBeNull();
    expect(parseAmount("₹.50")).toBeNull();
    expect(parseAmount("$.99", { currency: "USD" })).toBeNull();
  });
});
