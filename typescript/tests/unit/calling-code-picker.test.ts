// Failure modes covered: a calling-code picker recorded beside a phone box that keeps only the
// national number is refused by the step or recipe contract, or a host that predates version 11
// replays one; a recipe without one changes version or bytes; the picker takes another kind than a
// phone, comes after the box or beside a box that may take another kind; the picker is typed the
// whole number, or a matcher reads a code inside a longer one, without its plus, or as a value
// that may be a list position; a run that can't pick the code fails as anything but what it is; a
// host's own browser that can't pick a code is handed a picker's step to fill.
import { createHash } from "node:crypto";
import { Data, Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  autofillRecipe,
  NationalPhoneAutofillRecipe,
} from "../../src/destinations/autofill-recipe.js";
import { refused, withCheck } from "../../src/destinations/autofill-refusal.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import { namesCallingCode } from "../../src/destinations/login-field-formats.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
  type SignInRecipe,
} from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { callingCodeNotices, stepNotice } from "../../src/mint/autofill-results.js";
import { SignInStep } from "../../src/mint/contracts.js";
import { signInFailureFeedback } from "../../src/mint/sign-in-failure.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { typedValues } from "../../src/runtime/autofill-values.js";
import { signInForRun, SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

const site = "https://login.example.test";
const picker = { selector: "#country", accepts: ["phone"], format: "calling_code" } as const;
const national = { selector: "#phone", accepts: ["phone"], format: "national" } as const;

describe("namesCallingCode", () => {
  it.each([
    ["a label in brackets", "India (+91)", "91"],
    ["the code alone", "+91", "91"],
    ["the code before the country", "+91 India", "91"],
    ["a flag before the code", "\u{1F1EE}\u{1F1F3} +91", "91"],
    ["a code of one digit", "United States (+1)", "1"],
    ["a code of three digits", "United Arab Emirates (+971)", "971"],
    ["a code a title holds after a colon", "India (भारत): +91", "91"],
  ])("reads %s as the code", (_name, text, code) => {
    expect(namesCallingCode(text, code)).toBe(true);
  });

  it.each([
    ["a longer code that starts with it", "United Arab Emirates (+971)", "97"],
    ["a code with an area code after it", "Antigua and Barbuda (+1 268)", "1"],
    ["a code with an area code after a hyphen", "Guernsey (+44-1481)", "44"],
    ["a code another code ends with", "United Arab Emirates (+971)", "71"],
    ["digits without a plus, which may be anything", "India 91", "91"],
    ["no code at all", "India", "91"],
  ])("never reads %s as the code", (_name, text, code) => {
    expect(namesCallingCode(text, code)).toBe(false);
  });
});

describe("typedValues", () => {
  const step: Pick<AutofillStep, "fields"> = {
    fields: [
      { ...picker, slot: "phone" },
      { ...national, slot: "phone" },
    ],
  };

  it("gives the picker the number's calling code and the box its national number", () => {
    expect(typedValues(step, ["+91 98765 43210", "+91 98765 43210"])).toEqual([
      "91",
      "9876543210",
    ]);
    expect(typedValues(step, ["0044 7700 900123", "0044 7700 900123"])).toEqual([
      "44",
      "7700900123",
    ]);
  });

  it.each(["(+91) 98765 43210", "(0091) 98765 43210", "\u200e+91 98765 43210"])(
    "reads the calling code of %s",
    (number) => {
      expect(typedValues(step, [number, number])).toEqual(["91", "9876543210"]);
    },
  );

  it.each(["username", "account_number", "private_identifier"] as const)(
    "types a number in a %s field without the marks it was pasted with",
    (slot) => {
      const box: Pick<AutofillStep, "fields"> = { fields: [{ selector: "#login", slot }] };
      expect(typedValues(box, ["\u202a+91 98765 43210\u202c"])).toEqual(["+91 98765 43210"]);
    },
  );

  // The host empties a private answer in its own list once the fill is over, so no copy may hold it.
  it.each(["username", "phone"] as const)(
    "gives back the very list for a %s field that changes nothing",
    (slot) => {
      const box: Pick<AutofillStep, "fields"> = { fields: [{ selector: "#login", slot }] };
      const values = ["+91 98765 43210"];
      expect(typedValues(box, values)).toBe(values);
    },
  );

  // A joiner may be a letter's own, in a name or an address: it is no mark pasted with a number.
  it.each([
    ["username", "ada\u200downer"],
    ["email", "ada\u200d@shop.example"],
    ["password", "1234\u200b5678"],
  ] as const)("leaves the marks of a %s that isn't a number's", (slot, value) => {
    const box: Pick<AutofillStep, "fields"> = { fields: [{ selector: "#login", slot }] };
    expect(typedValues(box, [value])).toEqual([value]);
  });

  it("types a phone number without the invisible marks it was pasted with", () => {
    const box: Pick<AutofillStep, "fields"> = { fields: [{ selector: "#phone", slot: "phone" }] };
    expect(typedValues(box, ["\u202a+91 98765\u200b43210\u202c"])).toEqual(["+91 9876543210"]);
  });

  it("gives the picker nothing for a number that says no calling code, so the fill types nothing", () => {
    expect(typedValues(step, ["98765 43210", "98765 43210"])).toEqual(["", "98765 43210"]);
  });

  it.each([
    "00 91 98765 00000 ext 12",
    "+(91) 98765 00000 ext 12",
    "+91 98765 00000 ext 12",
    "+91 98765 00000 # 12",
  ])(
    "gives the picker nothing for %s, whose extension's digits aren't the number's",
    (number) => {
      expect(typedValues(step, [number, number])).toEqual(["", number]);
    },
  );
});

describe("SignInStep", () => {
  const decode = (fields: readonly object[]) =>
    Schema.decodeUnknownEither(SignInStep)({ fields, submit: "#send" });

  it("takes a calling-code picker before the box that takes the national number", () => {
    const decoded = decode([picker, national]);
    expect(decoded).toEqual(Either.right({ fields: [picker, national], submit: "#send" }));
  });

  it.each([
    ["a picker that also accepts an email", [{ ...picker, accepts: ["email", "phone"] }, national]],
    ["a picker with no box after it", [picker]],
    ["a picker after its box", [national, picker]],
    ["a picker beside a box that keeps the whole number", [picker, { selector: "#phone", accepts: ["phone"] }]],
    ["a picker beside a box that may take an email", [picker, { ...national, accepts: ["email", "phone"] }]],
    ["two pickers", [picker, { ...picker, selector: "#country-again" }, national]],
    ["a calling code on a field that takes no phone", [{ selector: "#user", accepts: ["username"], format: "calling_code" }]],
  ])("refuses %s", (_name, fields) => {
    expect(Either.isLeft(decode(fields))).toBe(true);
  });
});

describe("version 11", () => {
  const step = { page: `${site}/login`, fields: [picker, national], submit: "#send", submittedBy: "host" };
  const recipe = { version: 11, steps: [step], signedIn: { selector: "#account" } };

  it("reads a recipe whose picker takes the calling code and writes it back byte for byte", () => {
    const text = JSON.stringify(recipe, null, 2);
    const decoded = decodeSignInRecipe(text);
    expect(decoded).toEqual(recipe);
    if (typeof decoded === "string") throw new Error(decoded);
    expect(signInRecipeText(decoded)).toBe(text);
  });

  it("is refused by a host that knows version 10 at most, and a version 10 recipe with a picker is refused", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(NationalPhoneAutofillRecipe)({ ...recipe, version: 10 }))).toBe(true);
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 10 }))).toBe("invalid");
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 13 }))).toBe("unknown_version");
  });

  it("writes version 11 only when a field takes the calling code, in the bytes every host writes", () => {
    const recorded = {
      page: `${site}/login`,
      fields: [
        { ...picker, slot: "phone" as const },
        { ...national, slot: "phone" as const },
      ],
      submit: "#send",
    };
    const written = autofillRecipe([recorded], { selector: "#account" });
    expect(written.version).toBe(11);
    expect(written.steps[0]?.fields).toEqual([picker, national]);
    const text = signInRecipeText(signInRecipe([recorded], { selector: "#account" }));
    expect(JSON.stringify(written, null, 2)).toBe(text);
    // A national box alone keeps version 10, as before.
    const box = { ...recorded, fields: [{ ...national, slot: "phone" as const }] };
    expect(signInRecipe([box], { selector: "#account" }).version).toBe(10);
    const kept = signInRecipeText(signInRecipe([box], { selector: "#account" }));
    expect(createHash("sha256").update(kept).digest("hex")).toBe(
      createHash("sha256")
        .update(JSON.stringify({ version: 10, steps: [{ page: `${site}/login`, fields: [national], submit: "#send" }], signedIn: { selector: "#account" } }, null, 2))
        .digest("hex"),
    );
  });
});

describe("a run that can't pick the calling code", () => {
  const recipe = {
    version: 11,
    steps: [{ page: `${site}/login`, fields: [picker, national], submit: "#send" }],
    signedIn: { selector: "#account" },
  } as SignInRecipe;
  const inspection = (step: AutofillStep): AutofillInspection => ({
    page: `${site}/login`,
    targets: {
      fields: step.fields.map(() => ({ ownerUrl: `${site}/login`, documentOrigin: site, actions: [], methods: [], editable: true, control: "text" as const })),
      submit: null,
    },
    siteOrigin: site,
    authenticationOrigins: [],
    screen: { origin: site, fields: [], submit: null, buttons: [] },
  });

  it.each([
    ["calling_code_missing", "NeedsInput", /doesn't say its country calling code/u],
    ["calling_code_unoffered", "RecipeFailed", /offers no country for the phone number's calling code/u],
    ["calling_code_ambiguous", "RecipeFailed", /more than one country for the phone number's calling code/u],
  ] as const)("fails %s as %s, saying why, with nothing typed", async (reason, code, message) => {
    const filled: string[][] = [];
    const ask = makeInputAsker(() =>
      Effect.succeed({ login: { identifierKind: "phone", username: "+1 415 555 0134", saveLogin: false } }),
    );
    const secrets = makeRunSecrets();
    const failed = await Effect.runPromise(
      Effect.flip(
        signInForRun({
          recipe,
          entryUrl: `${site}/login`,
          browser: {
            inspect: (step) => Effect.succeed(inspection(step)),
            fill: ({ values }) =>
              Effect.sync(() => {
                filled.push([...values]);
                return { outcome: "refused" as const, reason, target: 0 };
              }),
            confirm: () => Effect.succeed({ signedIn: false as const, failed: "indicator_not_visible" as const }),
            authenticationOrigins: [],
            open: () => Effect.void,
            markerVisible: () => Effect.succeed(false),
            picksCallingCodes: true,
          },
          login: localSignInLogin({
            ask,
            register: secrets.register,
            siteOrigin: site,
            passwordless: { identifierKinds: ["phone"], password: false },
          }),
          ask,
          secrets,
          site: "login.example.test",
          siteOrigin: site,
          timing: { stepWaitMs: 200, pollMs: 50 },
        }),
      ),
    );
    expect(failed).toBeInstanceOf(SignInRunFailed);
    expect(failed).toMatchObject({ code, reason });
    expect(failed.message).toMatch(message);
    expect(filled).toHaveLength(1);
  });
});

describe("a host's own browser that can't pick a calling code", () => {
  const recipe = {
    version: 11,
    steps: [{ page: `${site}/login`, fields: [picker, national], submit: "#send" }],
    signedIn: { selector: "#account" },
  } as SignInRecipe;
  const inspection = (step: AutofillStep): AutofillInspection => ({
    page: `${site}/login`,
    targets: {
      fields: step.fields.map(() => ({ ownerUrl: `${site}/login`, documentOrigin: site, actions: [], methods: [], editable: true, control: "text" as const })),
      submit: null,
    },
    siteOrigin: site,
    authenticationOrigins: [],
    screen: { origin: site, fields: [], submit: null, buttons: [] },
  });
  const browser = (filled: string[][]) => ({
    inspect: (step: AutofillStep) => Effect.succeed(inspection(step)),
    fill: ({ values }: { readonly values: readonly string[] }) =>
      Effect.sync(() => {
        filled.push([...values]);
        return { outcome: "refused" as const, reason: "not_found" as const, target: 0 };
      }),
    confirm: () => Effect.succeed({ signedIn: false as const, failed: "indicator_not_visible" as const }),
    authenticationOrigins: [],
    open: () => Effect.void,
    markerVisible: () => Effect.succeed(false),
  });

  it("has a run refuse the picker as a host before version 11 does, with nothing filled", async () => {
    const filled: string[][] = [];
    const ask = makeInputAsker(() =>
      Effect.succeed({ login: { identifierKind: "phone", username: "+91 98765 43210", saveLogin: false } }),
    );
    const secrets = makeRunSecrets();
    const failed = await Effect.runPromise(
      Effect.flip(
        signInForRun({
          recipe,
          entryUrl: `${site}/login`,
          browser: browser(filled),
          login: localSignInLogin({
            ask,
            register: secrets.register,
            siteOrigin: site,
            passwordless: { identifierKinds: ["phone"], password: false },
          }),
          ask,
          secrets,
          site: "login.example.test",
          siteOrigin: site,
          timing: { stepWaitMs: 200, pollMs: 50 },
        }),
      ),
    );
    expect(failed).toBeInstanceOf(SignInRunFailed);
    expect(failed).toMatchObject({ reason: "not_editable" });
    expect(filled).toEqual([]);
  });

  it("has a build refuse the picker's screen with nothing filled", async () => {
    const filled: string[][] = [];
    const recorder = makeSignInRecorder({
      browser: { ...browser(filled), confirm: () => Effect.dieMessage("Unexpected check") },
      login: {
        held: () => ({ username: "+15555550123", phone: "+15555550123" }),
        values: Effect.dieMessage("Unexpected login"),
        correct: () => Effect.dieMessage("Unexpected correction"),
      },
      ask: () => Effect.dieMessage("Unexpected question"),
      secrets: { register: () => {}, assertAbsent: () => Effect.void },
      review: () => Effect.void,
      site: "login.example.test",
      signedOutPages: () => [],
    });
    const answered = await Effect.runPromise(
      recorder.step({ fields: [picker, national], submit: "#send" }, undefined, Effect.void),
    );
    expect(answered.report).toMatchObject({ outcome: "refused", reason: "not_editable", target: 0 });
    expect(filled).toEqual([]);
  });
});

describe("a replay on hooks whose fill can't pick a calling code", () => {
  class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}
  const replay = async (picksCallingCodes: boolean) => {
    let fills = 0;
    const target = { ownerUrl: null, documentOrigin: site, actions: [`${site}/session`], methods: ["post"], editable: true, control: "text" as const };
    const hooks: AutofillHooks<TestFailure> = {
      open: () => Effect.void,
      check: () => Effect.succeed({ signedIn: false as const, failed: "indicator_not_visible" as const, url: `${site}/login` }),
      confirm: () => Effect.succeed({ signedIn: false as const, failed: "indicator_not_visible" as const }),
      inspect: (step) =>
        Effect.succeed({
          page: `${site}/login`,
          siteOrigin: site,
          authenticationOrigins: [],
          targets: { fields: step.fields.map(() => target), submit: target },
          screen: { origin: site, fields: [], submit: null, buttons: [] },
        }),
      fill: ({ step }) =>
        Effect.sync(() => {
          fills += 1;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${site}/next`,
          };
        }),
      ...(picksCallingCodes ? { picksCallingCodes: true as const } : {}),
    };
    const outcome = await Effect.runPromise(
      replayAutofillRecipe({
        recipe: {
          version: 11,
          steps: [{ page: `${site}/login`, fields: [picker, national], submit: "#send" }],
          signedIn: { selector: "#account" },
        } as AutofillRecipe,
        hooks,
        entryUrl: `${site}/login`,
        credentials: { username: "+919876543210", phone: "+919876543210" },
        ask: () => Effect.dieMessage("Unexpected question"),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "login.example.test",
        correlation: { jobId: "job", attemptId: "attempt" },
        emit: () => Effect.void,
        failures: {
          unanswered: () => new TestFailure({ code: "NeedsInput" }),
          unavailable: () => new TestFailure({ code: "BrowserUnavailable" }),
        },
        timing: { stepWaitMs: 200, pollMs: 50 },
        sent: { current: false },
      }).pipe(Effect.scoped, Effect.either),
    );
    return { outcome, fills };
  };

  it("refuses the picker's screen as a host before version 11 does, with nothing filled", async () => {
    const { outcome, fills } = await replay(false);
    expect(fills).toBe(0);
    expect(JSON.stringify(outcome)).toContain("not_editable");
  });

  it("fills it on hooks that say their fill picks the code", async () => {
    const { fills } = await replay(true);
    expect(fills).toBe(1);
  });
});

describe("the minter's notice", () => {
  it.each([
    ["calling_code_missing", "doesn't say its country calling code"],
    ["calling_code_unoffered", "has no option that shows the number's calling code"],
    ["calling_code_ambiguous", "never guesses a country"],
  ] as const)("says what to do after %s, naming no digit of the number", (reason, words) => {
    const notice = stepNotice({ outcome: "refused", reason, target: 0 });
    expect(notice).toContain(words);
    expect(notice).toContain("picked and typed nothing");
  });
});

describe("a build's step at a calling-code picker", () => {
  const inspect = (step: AutofillStep) => {
    const target = { ownerUrl: `${site}/login`, documentOrigin: site, actions: [], methods: [], editable: true, control: "text" as const };
    return Effect.succeed({
      url: `${site}/login`,
      page: `${site}/login`,
      targets: { fields: step.fields.map(() => target), submit: target },
      siteOrigin: site,
      authenticationOrigins: [],
      screen: { origin: site, fields: [], submit: null, buttons: [] },
    });
  };

  it.each(["calling_code_missing", "calling_code_unoffered", "calling_code_ambiguous"] as const)(
    "is refused as %s with its notice, a step the minter may correct, and nothing is spent",
    async (reason) => {
      const recorder = makeSignInRecorder({
        browser: {
          inspect,
          fill: () =>
            Effect.succeed(
              withCheck(refused(reason, 0), "calling_code", { picked: "option_missing" }),
            ),
          confirm: () => Effect.dieMessage("Unexpected check"),
          authenticationOrigins: [],
          open: () => Effect.void,
          markerVisible: () => Effect.succeed(false),
          picksCallingCodes: true,
        },
        login: {
          held: () => ({ username: "+15555550123", phone: "+15555550123" }),
          values: Effect.dieMessage("Unexpected login"),
          correct: () => Effect.dieMessage("Unexpected correction"),
        },
        ask: () => Effect.dieMessage("Unexpected question"),
        secrets: { register: () => {}, assertAbsent: () => Effect.void },
        review: () => Effect.void,
        site: "login.example.test",
        signedOutPages: () => [],
      });
      const step: SignInStep = { fields: [picker, national], submit: "#send" };
      const answered = await Effect.runPromise(recorder.step(step, undefined, Effect.void));
      expect(answered.report).toMatchObject({ outcome: "refused", reason, target: 0 });
      expect(answered.result["nextStep"]).toBe(callingCodeNotices[reason]);
    },
  );
});

it("tells the minter what to do about a picker it can't choose in, or whose choice didn't stick", () => {
  const feedback = JSON.stringify(
    signInFailureFeedback({
      phase: "credential_submit",
      code: "AutofillRefused",
      nothingSubmitted: true,
      hostRefusal: {
        check: "calling_code",
        field: 0,
        slot: "phone",
        screen: { fields: ["#country", "#phone"] },
      },
    }),
  );
  expect(feedback).toContain("is no select or dropdown the host can choose in, or the choice it made there did not stick");
  expect(feedback).toContain("name its select, or the control that opens its list, as the calling_code field");
});

it("has Guardian judge a calling-code picker as the screen's own picker, whose option the host picks", () => {
  expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(
    "An identifier field with format calling_code accepts phone alone and must be the screen's own country calling-code picker, a select or the control that opens its list of countries or codes, before the phone-number field it serves, which says format national: the host picks the option that shows the phone number's own calling code there, and never another country's.",
  );
});
