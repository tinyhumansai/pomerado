// Failure modes covered: an amount read in another grouping than the page wrote it, such as an
// Indian 1,23,456 or a European 1.234,50, coming out a hundred or a thousand times off; a
// deduction read as a charge because its minus sign was a typographic one, came after the symbol
// or was written as brackets; a free line read as no amount; text holding two numbers, such as an
// old and a new price or a count and a price, read as one of them; a currency guessed from a
// symbol several currencies share; and a value with more decimals than its currency has, rounded
// rather than refused.
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
    expect(parseAmount("Rs 1,499.00")).toEqual(inr(149900));
    expect(parseAmount("INR 25")).toEqual(inr(2500));
    expect(parseAmount("Pay ₹74 on delivery (Cash/UPI)")).toEqual(inr(7400));
  });

  it("reads a deduction as negative, whatever sign or brackets the page uses", () => {
    expect(parseAmount("-₹20")).toEqual(inr(-2000));
    expect(parseAmount("− ₹20")).toEqual(inr(-2000));
    expect(parseAmount("₹-20")).toEqual(inr(-2000));
    expect(parseAmount("(₹20)")).toEqual(inr(-2000));
    expect(parseAmount("+ ₹20")).toEqual(inr(2000));
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
    // A lone point before exactly three digits groups thousands, as a lone comma does.
    expect(parseAmount("1.234", { currency: "EUR" })).toEqual({ minor: 123400, currency: "EUR", free: false });
    expect(parseAmount("1,5", { currency: "EUR" })).toEqual({ minor: 150, currency: "EUR", free: false });
  });

  it("takes the caller's currency only for a bare number or a symbol several currencies share", () => {
    expect(parseAmount("$1,250.00")).toEqual({ minor: 125000, currency: null, free: false });
    expect(parseAmount("$1,250.00", { currency: "USD" })).toEqual({ minor: 125000, currency: "USD", free: false });
    expect(parseAmount("74", { currency: "INR" })).toEqual(inr(7400));
    expect(parseAmount("74")).toEqual({ minor: 7400, currency: null, free: false });
    // The page's own symbol wins over the caller's guess.
    expect(parseAmount("₹74", { currency: "USD" })).toEqual(inr(7400));
  });

  it("uses the currency's own number of decimals, and refuses more", () => {
    expect(parseAmount("¥1,500", { currency: "JPY" })).toEqual({ minor: 1500, currency: "JPY", free: false });
    expect(parseAmount("¥1,500.50", { currency: "JPY" })).toBeNull();
    expect(parseAmount("₹74.5051")).toBeNull();
    expect(parseAmount("₹74.500")).toEqual(inr(7450000));
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
  });
});
