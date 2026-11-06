// Failure modes covered: a phone box the page drew reads as holding the number when it holds other
// digits, such as the number cut short or with a leading digit lost, or its national digits alone,
// which say no country, read as the whole number; a number with no calling code reads as anything
// but its own digits; a box named for a code, a PIN or a card counts as a phone
// box because it takes digits, or a word a phone box's name happens to hold reads as another kind;
// and a phone box in another popup than the one the host typed in is followed.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { namesNoOtherKind } from "../../src/destinations/autofill-phone-swap.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
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

it("follows a phone box only in the popup the host typed in", async () => {
  const origin = "https://login.example.test";
  const url = `${origin}/sign-in`;
  const target = {
    ownerUrl: url,
    documentOrigin: origin,
    actions: [`${origin}/session`],
    methods: ["post"],
    submitMethod: "post",
    editable: true,
    control: "text",
  } as const;
  const described = {
    tag: "input",
    role: null,
    formMethod: "post",
    type: "tel",
    name: "phone",
    id: "phone",
    autocomplete: null,
    inputmode: null,
    label: "Mobile number",
    placeholder: null,
    ariaLabel: null,
    text: null,
  };
  const step: AutofillStep = {
    fields: [{ selector: "#identifier", slot: "phone", accepts: ["email", "phone"] }],
    submit: "#continue",
  };
  const inspection: AutofillInspection = {
    url,
    page: url,
    popupTargetId: "the-popup",
    targets: { fields: [target], submit: target },
    siteOrigin: origin,
    authenticationOrigins: [],
    screen: { origin, fields: [], submit: null, buttons: [] },
  };
  // The box took the focus, then the submit call found it gone from that document, and the fresh
  // look finds a phone box just like it, all but its popup.
  const answers: readonly object[] = [
    { focused: true, url, document: 1 },
    { error: "not_found", target: 0, url, document: 1 },
    {
      fields: [{ target, described }],
      submit: { target, described: { ...described, tag: "button", type: "submit" } },
      buttons: [],
      popupTargetId: "another-popup",
      url,
    },
  ];
  let calls = 0;
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["+91 98765 43210"],
      inspection,
      settleMs: 0,
      page: {
        targetId: "primary",
        execute: () => Effect.sync(() => answers[calls++] ?? { submit: "none", url }),
      },
      keyboard: {
        insertText: () => Effect.succeed("inserted" as const),
        readBack: () => Effect.dieMessage("Unexpected read of another popup's box"),
      },
    }),
  );
  expect(report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    failureDetail: { phase: "not_found", context: { phoneSwap: "another_document" } },
  });
  expect(calls).toBe(3);
});
