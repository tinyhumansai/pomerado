// Failure modes covered: a phone box the page drew reads as holding the number when it holds other
// digits, such as the number cut short or with a leading digit lost, or its national digits alone,
// which say no country, read as the whole number; a number with no calling code reads as anything
// but its own digits; a box named for a code, a PIN or a card counts as a phone
// box because it takes digits, or a word a phone box's name happens to hold reads as another kind.
import { expect, it } from "vitest";
import { namesNoOtherKind } from "../../src/destinations/autofill-phone-swap.js";
import { heldPhoneDigits, shownCallingCodes } from "../../src/destinations/login-field-formats.js";

it("reads a number's digits as a phone box may hold them, whole or as its national digits alone", () => {
  expect(heldPhoneDigits("+91 98765 43210")).toEqual({
    whole: ["919876543210"],
    national: ["9876543210", "09876543210"],
  });
  expect(heldPhoneDigits("0044 7700 900123")).toEqual({
    whole: ["447700900123"],
    national: ["7700900123", "07700900123"],
  });
  expect(heldPhoneDigits("98765 43210")).toEqual({ whole: ["9876543210"], national: [] });
});

it("reads every calling code a text names", () => {
  expect(shownCallingCodes("India (+91)")).toEqual(["91"]);
  expect(shownCallingCodes("+1 268 or +44")).toEqual(["1268", "44"]);
  expect(shownCallingCodes("India 91")).toEqual([]);
});

const field = (name: string | null, id: string | null = null, autocomplete: string | null = null) => ({
  name,
  id,
  autocomplete,
});

it.each([
  ["a phone box", field("phone", "phone", "tel")],
  ["a mobile box", field("mobileNumber")],
  ["a box whose name holds pin inside a word", field("shipping_phone")],
  ["a box with no name", field(null)],
])("takes %s", (_name, box) => {
  expect(namesNoOtherKind(box)).toBe(true);
});

it.each([
  ["a one-time code box", field("verify", null, "one-time-code")],
  ["a PIN box", field("pinCode")],
  ["an OTP box", field("phone_otp")],
  ["a card box", field("cardNumber")],
  ["an email box named by id", field(null, "user-email")],
])("refuses %s", (_name, box) => {
  expect(namesNoOtherKind(box)).toBe(false);
});
