// Failure modes covered: a host's handle typed into a document of another origin than the one it
// was revealed for, and a field the page moved after the reveal read as a recipe to build again;
// a handle on one-character code boxes asked again until it fails, a code revealed for boxes it
// does not fit, and a fresh code after a rejected one; a revealed value masked only as revealed,
// or only in the first field's form when one handle fills two fields; a refused, failed or dying
// reveal read as a recipe to build again, or crashing the run, and an interrupted one read as a
// refusal; a slow reveal holding a sign-in past its bound, on any screen, or read as the host's
// refusal; and a revealed value shown back in a question that quotes the page, through the run's
// own asker.
import { Cause, Duration, Effect, Either, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import { recipeLoginStep, type SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  type InputAnswers,
  type InputAsker,
  type InputRequest,
  InputRequestFailure,
  type Question,
} from "../../src/runtime/input-request.js";
import { bareCode } from "../../src/runtime/login-field-asks.js";
import {
  runSessionSignIns,
  type SessionSignInBound,
} from "../../src/runtime/session-sign-in.js";
import {
  type RevealSignInValue,
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
} from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";
import type { StandaloneSession } from "../../src/standalone/session.js";
import {
  makeBoundableAsk,
  makeLocalSessionSignIn,
  makeRunSignIn,
  redactedAsk,
  SessionSignInFailed,
} from "../../src/standalone/session-sign-in.js";

// A shop that signs in by a phone number on its own origin, then, when it asks one, a date of
// birth, then by the code it texts on its accounts origin, in one field or in one-character boxes.
// The owner answers with the host's handles, which the host reveals as each is typed.

const www = "https://www.example.test";
const accounts = "https://accounts.example.test";
const site = "example.test";
const phone = "+919812345678";
const code = "482913";

interface ShopOptions {
  /** The code screen's code fields: one field by default, else that many one-character boxes. */
  readonly boxes?: number;
  /** What the code screen says about its code, which the code question quotes. */
  readonly instruction?: string;
  /** The login screen's fields, in a version 10 recipe; a phone field alone by default. */
  readonly loginFields?: readonly object[];
  /** A screen that asks the date of birth, between the login and the code. */
  readonly birth?: boolean;
  /** The code screen shows its recorded error marker after a wrong code. */
  readonly rejectsCodes?: boolean;
}

const codeSelectors = (options: ShopOptions) =>
  (options.boxes ?? 1) === 1
    ? ["#code"]
    : Array.from({ length: options.boxes ?? 1 }, (_, index) => `#code-${index + 1}`);
const loginFields = (options: ShopOptions) =>
  options.loginFields ?? [{ selector: "#phone", accepts: ["phone"] }];

const shopRecipe = (options: ShopOptions = {}) =>
  ({
    version: options.loginFields === undefined ? 1 : 10,
    steps: [
      {
        page: `${www}/login`,
        fields: loginFields(options),
        submit: "#continue",
        submittedBy: "host",
      },
      ...(options.birth === true
        ? [
            {
              page: `${www}/birth`,
              fields: [{ selector: "#birth", slot: "date_of_birth" }],
              submit: "#confirm",
              submittedBy: "host",
            },
          ]
        : []),
      {
        page: `${accounts}/verify`,
        fields: codeSelectors(options).map((selector, index) => ({
          selector,
          slot: "code",
          ...(index === 0 && options.instruction !== undefined
            ? { questionSelector: "#instruction" }
            : {}),
        })),
        submit: "#verify",
        submittedBy: "host",
        ...(options.rejectsCodes === true
          ? { rejectedMarkers: [{ slot: "code", selector: "#code-error" }] }
          : {}),
      },
    ],
    signedIn: { selector: "#account" },
  }) as unknown as SignInRecipe;

const described = {
  tag: "input",
  role: null,
  formMethod: "post",
  type: "text",
  name: null,
  id: null,
  autocomplete: null,
  inputmode: null,
  label: "Field",
  placeholder: null,
  ariaLabel: null,
  text: null,
};

/** The shop, and every fill the run made on it with the origin each value was revealed for. */
const shop = (options: ShopOptions = {}) => {
  const selectors = loginFields(options).map((field) => Reflect.get(field, "selector") as string);
  const pages = {
    login: { origin: www, path: "/login", controls: [...selectors, "#continue"] },
    birth: { origin: www, path: "/birth", controls: ["#birth", "#confirm"] },
    verify: { origin: accounts, path: "/verify", controls: [...codeSelectors(options), "#verify"] },
    account: { origin: www, path: "/account", controls: [] as string[] },
  };
  type Page = keyof typeof pages;
  const state = { page: "login" as Page, signedIn: false, codeError: false };
  const fills: {
    readonly page: Page;
    readonly values: readonly string[];
    readonly revealedFor?: readonly (string | undefined)[];
  }[] = [];
  const url = () => `${pages[state.page].origin}${pages[state.page].path}`;
  const browser: SignInReplayBrowser<never> = {
    inspect: (step) =>
      Effect.sync(() => {
        const { origin, controls } = pages[state.page];
        const selectors = [
          ...step.fields.map((field) => field.selector),
          ...(step.submit === undefined ? [] : [step.submit]),
        ];
        if (selectors.length === 0 || !selectors.every((selector) => controls.includes(selector)))
          return { outcome: "refused" as const, reason: "not_found" as const };
        const target = {
          ownerUrl: url(),
          documentOrigin: origin,
          actions: [url()],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: true,
        };
        return {
          url: url(),
          page: url(),
          targets: {
            fields: step.fields.map(() => target),
            submit: step.submit === undefined ? null : target,
          },
          siteOrigin: www,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({
              ...described,
              slot: field.slot,
              ...(field.questionSelector !== undefined && options.instruction !== undefined
                ? { questionText: options.instruction }
                : {}),
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values, revealedFor }) =>
      Effect.sync((): AutofillStepReport => {
        fills.push({
          page: state.page,
          values: [...values],
          ...(revealedFor === undefined ? {} : { revealedFor: [...revealedFor] }),
        });
        if (state.page === "login") state.page = options.birth === true ? "birth" : "verify";
        else if (state.page === "birth") state.page = "verify";
        else if (state.page === "verify") {
          state.codeError = bareCode(values.join("")) !== code && options.rejectsCodes === true;
          if (bareCode(values.join("")) === code) {
            state.signedIn = true;
            state.page = "account";
          }
        }
        return {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked",
          url: url(),
        };
      }),
    confirm: () =>
      Effect.sync(
        (): AutofillSignedInCheck =>
          state.signedIn && state.page === "account"
            ? { signedIn: true, url: url() }
            : { signedIn: false, failed: "indicator_not_visible", url: url() },
      ),
    authenticationOrigins: [],
    open: () =>
      Effect.sync(() => {
        state.page = state.signedIn ? "account" : "login";
      }),
    markerVisible: (selector) =>
      Effect.sync(() => selector === "#code-error" && state.page === "verify" && state.codeError),
  };
  return { browser, fills };
};

/**
 * The owner, who answers the login with the host's phone handle, as a phone number, each code
 * with the next of `codes`, the last one again once they run out, and a date of birth with `birth`.
 */
const owner = (codes: readonly string[] = ["sec_code"], birth = "1990-04-12") => {
  const asked: InputRequest[] = [];
  const queue = [...codes];
  const answer = (question: Question) => {
    if (question.type === "credential")
      return {
        username: "sec_phone",
        ...((question.currentStep?.identifierKinds.length ?? 0) > 1
          ? { identifierKind: "phone" }
          : {}),
        saveLogin: false,
      };
    if (question.id === "date_of_birth") return birth;
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? "sec_code";
  };
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [question.id, answer(question)]),
      ) as InputAnswers;
    }),
  );
  return { ask, asked };
};

/** The host, which reveals each handle it knows as `revealed` says, and keeps each call. */
const host = (revealed: Readonly<Record<string, string>> = {}) => {
  const calls: (readonly [string, string])[] = [];
  const shown: Readonly<Record<string, string>> = { sec_phone: phone, sec_code: code, ...revealed };
  const reveal: RevealSignInValue = (value, origin) =>
    Effect.sync(() => {
      calls.push([value, origin]);
      return shown[value] ?? value;
    });
  return { reveal, calls };
};

const signIn = (input: {
  readonly fake: ReturnType<typeof shop>;
  readonly recipe: SignInRecipe;
  readonly ask: InputAsker;
  readonly reveal?: RevealSignInValue;
  readonly secrets?: ReturnType<typeof makeRunSecrets>;
}) => {
  const secrets = input.secrets ?? makeRunSecrets();
  const passwordless = recipeLoginStep(input.recipe);
  return signInForRun({
    recipe: input.recipe,
    entryUrl: `${www}/login`,
    browser: input.fake.browser,
    login: localSignInLogin({
      ask: input.ask,
      register: secrets.register,
      siteOrigin: www,
      ...(passwordless === undefined ? {} : { passwordless }),
    }),
    ask: input.ask,
    secrets,
    ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
    site,
    siteOrigin: www,
    markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
    timing: { stepWaitMs: 60, pollMs: 2 },
  });
};

/** The code questions a run asked. */
const codeQuestions = (asked: readonly InputRequest[]) =>
  asked.flatMap((request) => request.questions).filter((question) => question.id === "code");

describe("a run's sign-in with a host's handles", () => {
  it("reveals each answer for its field's origin, and the fill types it only there", async () => {
    const fake = shop();
    const { ask } = owner();
    const { reveal, calls } = host();
    expect(await Effect.runPromise(signIn({ fake, recipe: shopRecipe(), ask, reveal }))).toEqual({
      alreadySignedIn: false,
    });
    expect(calls).toEqual([
      ["sec_phone", www],
      ["sec_code", accounts],
    ]);
    expect(fake.fills).toEqual([
      { page: "login", values: [phone], revealedFor: [www] },
      { page: "verify", values: [code], revealedFor: [accounts] },
    ]);
  });

  it("asks and reveals a handle on one-character boxes once, typing one in each", async () => {
    const fake = shop({ boxes: 6 });
    const { ask, asked } = owner();
    const { reveal, calls } = host();
    const recipe = shopRecipe({ boxes: 6 });
    expect(await Effect.runPromise(signIn({ fake, recipe, ask, reveal }))).toEqual({
      alreadySignedIn: false,
    });
    expect(codeQuestions(asked)).toHaveLength(1);
    expect(calls.filter(([value]) => value === "sec_code")).toEqual([["sec_code", accounts]]);
    expect(fake.fills.at(-1)).toEqual({
      page: "verify",
      values: [...code],
      revealedFor: Array.from({ length: 6 }, () => accounts),
    });
  });

  it("takes a revealed code without its spaces and hyphens for one-character boxes", async () => {
    const fake = shop({ boxes: 6 });
    const { reveal } = host({ sec_code: "482-913" });
    const recipe = shopRecipe({ boxes: 6 });
    expect(await Effect.runPromise(signIn({ fake, recipe, ask: owner().ask, reveal }))).toEqual({
      alreadySignedIn: false,
    });
    expect(fake.fills.at(-1)?.values).toEqual([...code]);
  });

  it("types nothing on a code screen whose revealed code does not fit its boxes", async () => {
    const fake = shop({ boxes: 6 });
    const { reveal } = host({ sec_code: "48291" });
    const recipe = shopRecipe({ boxes: 6 });
    expect(
      await Effect.runPromise(Effect.either(signIn({ fake, recipe, ask: owner().ask, reveal }))),
    ).toEqual(
      Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "code_does_not_fit_boxes" })),
    );
    expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
  });

  it("masks a revealed code also without its spaces, as boxes and pages take it", async () => {
    const secrets = makeRunSecrets();
    const { reveal } = host({ sec_code: "482 913" });
    const run = signIn({ fake: shop(), recipe: shopRecipe(), ask: owner().ask, reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(secrets.redact(`${phone} 482 913 482913`)).toBe("[private] [private] [private]");
  });

  it.each([
    ["refuses", () => Effect.fail(new Error("Not for this page"))],
    ["fails with a defect", () => Effect.die(new Error("The host's store is down"))],
    [
      "throws",
      () => {
        throw new Error("The host's reveal threw");
      },
    ],
    ["answers with no text", () => Effect.succeed(undefined as unknown as string)],
    ["answers with empty text", () => Effect.succeed("")],
  ])("fails NeedsInput, typing nothing, when the host's reveal %s", async (_, refusal) => {
    const fake = shop();
    const reveal: RevealSignInValue = refusal;
    const result = await Effect.runPromise(
      Effect.either(signIn({ fake, recipe: shopRecipe(), ask: owner().ask, reveal })),
    );
    expect(result).toEqual(
      Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "reveal_refused" })),
    );
    expect(Either.isLeft(result) && result.left.message).not.toContain("Build the tool again");
    expect(fake.fills).toEqual([]);
  });

  it("lets an interrupted reveal interrupt the sign-in, typing nothing", async () => {
    const fake = shop();
    const exit = await Effect.runPromiseExit(
      signIn({ fake, recipe: shopRecipe(), ask: owner().ask, reveal: () => Effect.interrupt }),
    );
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(fake.fills).toEqual([]);
  });

  it("says what stopped the run when a value was not revealed, or its code did not fit", () => {
    const refused = new SignInRunFailed({ code: "NeedsInput", reason: "reveal_refused" });
    const misfit = new SignInRunFailed({ code: "NeedsInput", reason: "code_does_not_fit_boxes" });
    expect(refused.message).toContain("wasn't revealed for the page that asked for it");
    expect(misfit.message).toContain("doesn't fill the site's code boxes");
    for (const failure of [refused, misfit])
      expect(failure.message).not.toContain("Build the tool again");
  });

  it("asks a fresh handle after the site rejects a code, then reveals and types it", async () => {
    const fake = shop({ boxes: 6, rejectsCodes: true });
    const { ask, asked } = owner(["sec_code_1", "sec_code_2_longer_than_the_boxes"]);
    const { reveal, calls } = host({
      sec_code_1: "111111",
      sec_code_2_longer_than_the_boxes: code,
    });
    const recipe = shopRecipe({ boxes: 6, rejectsCodes: true });
    expect(await Effect.runPromise(signIn({ fake, recipe, ask, reveal }))).toEqual({
      alreadySignedIn: false,
    });
    expect(codeQuestions(asked).map(({ prompt }) => prompt)).toEqual([
      `Enter the sign-in code ${site} sent you.`,
      `The site refused the last code. Enter the newest sign-in code ${site} sent you.`,
    ]);
    expect(calls.map(([value]) => value)).toEqual([
      "sec_phone",
      "sec_code_1",
      "sec_code_2_longer_than_the_boxes",
    ]);
    expect(fake.fills.filter(({ page }) => page === "verify").map(({ values }) => values)).toEqual([
      [..."111111"],
      [...code],
    ]);
  });
});

describe("the forms of a revealed value the run masks", () => {
  const national = { selector: "#phone", accepts: ["phone"], format: "national" };

  it("masks a phone number as a national field takes it, without its calling code", async () => {
    const secrets = makeRunSecrets();
    const options = { loginFields: [national] };
    const fake = shop(options);
    const recipe = shopRecipe(options);
    const run = signIn({ fake, recipe, ask: owner().ask, reveal: host().reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]?.values).toEqual(["9812345678"]);
    expect(secrets.redact("9812345678")).toBe("[private]");
    expect(secrets.redact("98123 45678")).toBe("[private]");
  });

  it("masks a number revealed for a username field in each form a page writes it", async () => {
    const secrets = makeRunSecrets();
    const options = { loginFields: [{ selector: "#member", accepts: ["username"] }] };
    const fake = shop(options);
    const recipe = shopRecipe(options);
    const run = signIn({ fake, recipe, ask: owner().ask, reveal: host().reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(secrets.redact("+91 98123 45678")).toBe("[private]");
  });

  it("masks a revealed phone number in each form a page writes it", async () => {
    const secrets = makeRunSecrets();
    const fake = shop();
    const run = signIn({ fake, recipe: shopRecipe(), ask: owner().ask, reveal: host().reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(secrets.redact("+91 98123 45678, 98123-45678")).toBe("[private], [private]");
  });

  it("masks a number outside the phone shape revealed for a username field, in each form a page writes it", async () => {
    const secrets = makeRunSecrets();
    const options = { loginFields: [{ selector: "#member", accepts: ["username"] }] };
    const fake = shop(options);
    const recipe = shopRecipe(options);
    const { reveal } = host({ sec_phone: "0170/5550100" });
    const run = signIn({ fake, recipe, ask: owner().ask, reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]?.values).toEqual(["0170/5550100"]);
    expect(secrets.redact("0170 5550100, 170-5550100")).toBe("[private], [private]");
  });

  it.each([
    ["a phone field", undefined, "+49 170/5550100"],
    ["a phone field, with no calling code", undefined, "0170/5550100"],
    ["a national field", [national], "+49 170/5550100"],
    ["a national field, with no calling code", [national], "0170/5550100"],
    // A revealed value is no handle, so a letter says it can't be a phone number.
    ["a phone field, with a letter after 00", undefined, "00 91 98123 45678 ext 12"],
    ["a phone field, with a letter after +(", undefined, "+(91) 98123 45678 ext 12"],
    ["a phone field, with a letter and no lead", undefined, "0170 5550100 ext 12"],
    ["a national field, with a letter after 00", [national], "00 91 98123 45678 ext 12"],
    ["a phone field, by what is no number at all", undefined, "sec_other"],
  ])("types nothing of a number outside the phone shape revealed for %s", async (_name, loginFields, revealed) => {
    const options = loginFields === undefined ? {} : { loginFields };
    const fake = shop(options);
    const recipe = shopRecipe(options);
    const { reveal } = host({ sec_phone: revealed });
    const failed = await Effect.runPromise(
      Effect.flip(signIn({ fake, recipe, ask: owner().ask, reveal })),
    );
    expect(failed).toEqual(new SignInRunFailed({ code: "NeedsInput", reason: "reveal_refused" }));
    expect(fake.fills).toEqual([]);
  });

  it("gives a picker's screen no calling code for an answer with a letter after 00", async () => {
    const number = "00 91 98123 45678 ext 12";
    const picker = { selector: "#country", accepts: ["phone"], format: "calling_code" };
    const options = { loginFields: [picker, national] };
    const fake = shop(options);
    const browser = { ...fake.browser, picksCallingCodes: true as const };
    const recipe = { ...shopRecipe(options), version: 11 } as unknown as SignInRecipe;
    const ask = makeInputAsker((request) =>
      Effect.succeed(
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            question.type === "credential" ? { username: number, saveLogin: false } : code,
          ]),
        ) as InputAnswers,
      ),
    );
    await Effect.runPromise(Effect.either(signIn({ fake: { ...fake, browser }, recipe, ask })));
    // The fill refuses a picker with no code before it touches anything (`calling_code_missing`).
    expect(fake.fills[0]?.values).toEqual(["", number]);
  });

  it("masks each field's own form when one handle fills fields of two kinds", async () => {
    const secrets = makeRunSecrets();
    const options = { loginFields: [{ selector: "#member", accepts: ["username"] }, national] };
    const fake = shop(options);
    const recipe = shopRecipe(options);
    const run = signIn({ fake, recipe, ask: owner().ask, reveal: host().reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]).toEqual({
      page: "login",
      values: [phone, "9812345678"],
      revealedFor: [www, www],
    });
    expect(secrets.redact(`${phone} 9812345678`)).toBe("[private] [private]");
  });

  it("masks a number a calling-code picker's screen takes in each form a page writes it, and not its code", async () => {
    const secrets = makeRunSecrets();
    const picker = { selector: "#country", accepts: ["phone"], format: "calling_code" };
    const options = { loginFields: [picker, national] };
    const fake = shop(options);
    const browser = { ...fake.browser, picksCallingCodes: true as const };
    const recipe = { ...shopRecipe(options), version: 11 } as unknown as SignInRecipe;
    const run = signIn({
      fake: { ...fake, browser },
      recipe,
      ask: owner().ask,
      reveal: host().reveal,
      secrets,
    });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]?.values).toEqual(["91", "9812345678"]);
    expect(secrets.redact("+91 98123 45678, 98123-45678, 098123 45678")).toBe(
      "[private], [private], [private]",
    );
    expect(secrets.redact("India (+91)")).toBe("India (+91)");
  });

  it.each([
    ["revealed", { reveal: host({ sec_phone: "+298 555012" }).reveal, answer: "sec_phone" }],
    ["answered with no reveal", { answer: "+298 555012" }],
  ])("masks a short number a picker's screen takes, %s, and not its code", async (_name, by) => {
    const secrets = makeRunSecrets();
    const picker = { selector: "#country", accepts: ["phone"], format: "calling_code" };
    const options = { loginFields: [picker, national] };
    const fake = shop(options);
    const browser = { ...fake.browser, picksCallingCodes: true as const };
    const recipe = { ...shopRecipe(options), version: 11 } as unknown as SignInRecipe;
    const ask = makeInputAsker((request) =>
      Effect.succeed(
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            question.type === "credential"
              ? { username: by.answer, saveLogin: false }
              : code,
          ]),
        ) as InputAnswers,
      ),
    );
    const run = signIn({ fake: { ...fake, browser }, recipe, ask, secrets, ...by });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]?.values).toEqual(["298", "555012"]);
    expect(secrets.redact("+298 55 50 12, 555012")).toBe("[private], [private]");
    expect(secrets.redact("Faroe Islands (+298)")).toBe("Faroe Islands (+298)");
  });

  it("masks a short number's revealed digits only where no digit adjoins them", async () => {
    const secrets = makeRunSecrets();
    const picker = { selector: "#country", accepts: ["phone"], format: "calling_code" };
    const options = { loginFields: [picker, national] };
    const fake = shop(options);
    const browser = { ...fake.browser, picksCallingCodes: true as const };
    const recipe = { ...shopRecipe(options), version: 11 } as unknown as SignInRecipe;
    const { reveal } = host({ sec_phone: "+683 4002" });
    const run = signIn({ fake: { ...fake, browser }, recipe, ask: owner().ask, reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills[0]?.values).toEqual(["683", "4002"]);
    expect(secrets.redact("+683 40 02, 4002")).toBe("[private], [private]");
    expect(secrets.redact("order 940025")).toBe("order 940025");
  });

  it("masks a revealed date of birth in each whole-date layout a page may show it in", async () => {
    const secrets = makeRunSecrets();
    // The host answers the date with one of its own, which it reveals as the owner's.
    const { ask } = owner(["sec_code"], "2000-01-01");
    const { reveal } = host({ "2000-01-01": "1990-04-12" });
    const fake = shop({ birth: true });
    const run = signIn({ fake, recipe: shopRecipe({ birth: true }), ask, reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    expect(fake.fills.find(({ page }) => page === "birth")?.values).toEqual(["1990-04-12"]);
    expect(secrets.redact("1990-04-12 12/04/1990 04/12/1990 12.04.1990 19900412")).toBe(
      "[private] [private] [private] [private] [private]",
    );
  });
});

describe("a field the page moves after its value was revealed for where it was", () => {
  const login = "https://login.example.test";
  /**
   * The shop's login screen filled by the host's own fill, on a page that moves its field at
   * `moved` to the site's login origin as the fill reaches it; each other field stays put.
   */
  const moving = (options: ShopOptions, moved: number) => {
    const fake = shop(options);
    const typed: string[] = [];
    const browser: SignInReplayBrowser<never> = {
      ...fake.browser,
      fill: (input) => {
        const { targets } = input.inspection;
        const elsewhere = { ownerUrl: `${login}/login`, documentOrigin: login };
        const away = {
          ...targets,
          fields: targets.fields.map((target, index) =>
            index === moved ? { ...target, ...elsewhere } : target,
          ),
        };
        let calls = 0;
        return fillAutofillStep({
          ...input,
          settleMs: 0,
          page: {
            targetId: "primary",
            execute: () =>
              Effect.sync(() => {
                calls += 1;
                return calls === moved + 1
                  ? { changed: away, url: `${login}/login` }
                  : { focused: true, url: `${www}/login` };
              }),
          },
          keyboard: {
            insertText: (_target, text) =>
              Effect.sync(() => {
                typed.push(text);
                return "inserted" as const;
              }),
          },
        });
      },
    };
    return { fake: { ...fake, browser }, typed };
  };

  const twoFields = {
    loginFields: [
      { selector: "#member", accepts: ["username"] },
      { selector: "#phone", accepts: ["phone"] },
    ],
  };

  it.each([
    ["before anything is typed", {}, 0, []],
    ["after an earlier field was typed", twoFields, 1, [phone]],
  ])("fails NeedsInput, saying the page moved it, %s", async (_, options, moved, typedFirst) => {
    const { fake, typed } = moving(options, moved);
    const recipe = shopRecipe(options);
    const result = await Effect.runPromise(
      Effect.either(signIn({ fake, recipe, ask: owner().ask, reveal: host().reveal })),
    );
    expect(result).toEqual(
      Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "revealed_origin_changed" })),
    );
    expect(Either.isLeft(result) && result.left.message).toContain("moved a sign-in field");
    expect(Either.isLeft(result) && result.left.message).not.toContain("Build the tool again");
    expect(typed).toEqual(typedFirst);
  });
});

describe("the questions of a run whose host reveals its handles", () => {
  it("masks a revealed value that a screen's text quotes in a question", async () => {
    const secrets = makeRunSecrets();
    const { ask: base, asked } = owner();
    const ask = redactedAsk(base, secrets.redact);
    const instruction = `Enter the code we texted to ${phone}.`;
    const fake = shop({ instruction });
    const recipe = shopRecipe({ instruction });
    const run = signIn({ fake, recipe, ask, reveal: host().reveal, secrets });
    expect(await Effect.runPromise(run)).toEqual({ alreadySignedIn: false });
    const [question] = codeQuestions(asked);
    expect(question?.prompt).toContain("Enter the code we texted to [private].");
    expect(question?.prompt).not.toContain(phone);
  });

  it("masks each prompt and the notice, cut to fit, and keeps the asker's recovery", async () => {
    const asked: InputRequest[] = [];
    const recoverSecrets = () => Effect.succeed(["recovered"]);
    const base: InputAsker = Object.assign(
      (request: InputRequest) =>
        Effect.sync(() => {
          asked.push(request);
          return {};
        }),
      { recoverSecrets },
    );
    const ask = redactedAsk(base, (text) => text.replaceAll("4829", "[private]"));
    expect(ask.recoverSecrets).toBe(recoverSecrets);
    await Effect.runPromise(
      ask({
        id: "00000000-0000-4000-8000-000000000000",
        source: "system",
        notice: "Your code 4829 expires soon.",
        questions: [
          { id: "code", type: "secret", secretKind: "one_time_code", prompt: "4829".repeat(500) },
          { id: "approved", type: "confirm", prompt: "Approve 4829, then confirm." },
        ],
      }),
    );
    expect(asked[0]?.notice).toBe("Your code [private] expires soon.");
    expect(asked[0]?.questions.map((question) => question.prompt.length)).toEqual([2000, 32]);
    expect(asked[0]?.questions[0]?.prompt.endsWith("…")).toBe(true);
    expect(asked[0]?.questions[1]).toEqual({
      id: "approved",
      type: "confirm",
      prompt: "Approve [private], then confirm.",
    });
  });

  /**
   * A local session on the shop's login screen, whose owner answers nothing, with the host's
   * `reveal` when it has one. Its masking already holds a word the login question shows.
   */
  const session = (asked: InputRequest[], reveal: RevealSignInValue | undefined) => {
    const secrets = makeRunSecrets();
    secrets.register("website");
    const target = {
      ownerUrl: `${www}/login`,
      documentOrigin: www,
      actions: [`${www}/login`],
      methods: ["post"],
      editable: true,
      control: "text" as const,
    };
    const screen = {
      fields: [{ target, described }],
      submit: { target: { ...target, control: "other" as const }, described },
      buttons: ["Continue"],
      url: `${www}/login`,
    };
    return {
      options: reveal === undefined ? {} : { reveal },
      browser: {
        targetId: "primary",
        // The entry page loads, and every look at the page finds the login screen.
        execute: (source: string) =>
          Effect.succeed(source.includes("primary.goto(") ? `${www}/login` : screen),
        keyboard: { insertText: () => Effect.die(new Error("The owner answers nothing to type")) },
      },
      ask: (request: InputRequest) => {
        asked.push(request);
        return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      },
      secrets,
      signInTyping: { typed: false },
    } as unknown as StandaloneSession;
  };

  it.each([
    ["masks them with the session's masking when the host reveals", host().reveal, "[private]"],
    ["shows them as they are when the host doesn't", undefined, "website"],
  ])("%s", async (_, reveal, shown) => {
    const asked: InputRequest[] = [];
    const recorded = { recipe: shopRecipe(), entryUrl: `${www}/login` };
    const run = makeRunSignIn(session(asked, reveal), recorded, www, []);
    expect(await Effect.runPromise(Effect.either(run.before))).toEqual(
      Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "login" })),
    );
    expect(asked.map((request) => [request.notice, request.questions[0]?.prompt])).toEqual([
      [
        `Pomerado needs a login for this ${shown} to continue.`,
        `Sign in to the ${shown} so this request can continue.`,
      ],
    ]);
  });
});

// The fill types a revealed value only in a document of the origin the host revealed it for, as
// the fill judges its field when it would type: a page may move a field from one origin of the
// site to another after the inspection, which the fill's own judgment of the site allows.
describe("the fill of values revealed for an origin", () => {
  const login = "https://login.example.test";
  const target = (frameUrl: string) => ({
    ownerUrl: frameUrl,
    documentOrigin: new URL(frameUrl).origin,
    actions: [],
    methods: [],
    editable: true,
    control: "text" as const,
  });

  /**
   * A fill of `step` whose page answers each call in turn from `answers`, then that nothing was
   * submitted; it keeps each call the page got and each value the host typed.
   */
  const fill = (
    step: AutofillStep,
    values: readonly string[],
    answers: readonly object[],
    revealedFor?: readonly (string | undefined)[],
  ) => {
    const calls: string[] = [];
    const typed: string[] = [];
    const inspection: AutofillInspection = {
      page: `${www}/login`,
      targets: { fields: step.fields.map(() => target(`${www}/login`)), submit: null },
      siteOrigin: www,
      authenticationOrigins: [],
      screen: { origin: www, fields: [], submit: null, buttons: [] },
    };
    const report = Effect.runPromise(
      fillAutofillStep({
        step,
        values,
        inspection,
        settleMs: 0,
        ...(revealedFor === undefined ? {} : { revealedFor }),
        page: {
          targetId: "primary",
          execute: (source) =>
            Effect.sync(() => {
              calls.push(source);
              return answers[calls.length - 1] ?? { submit: "none", url: `${login}/login` };
            }),
        },
        keyboard: {
          insertText: (_target, text) =>
            Effect.sync(() => {
              typed.push(text);
              return "inserted" as const;
            }),
        },
      }),
    );
    return { report, calls, typed };
  };
  const phoneStep: AutofillStep = { fields: [{ selector: "#phone", slot: "phone" }] };
  /** The page moved every field of the step to `to` before the fill's first call. */
  const moved = (to: string, fields = 1) => ({
    changed: { fields: Array.from({ length: fields }, () => target(`${to}/login`)), submit: null },
    url: `${to}/login`,
  });
  const focused = (at: string) => ({ focused: true, url: `${at}/login` });

  it("refuses a field moved to another origin of the site, typing nothing", async () => {
    const { report, typed } = fill(phoneStep, [phone], [moved(login), focused(login)], [www]);
    expect(await report).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: 0,
      failureDetail: { phase: "revealed_origin" },
    });
    expect(typed).toEqual([]);
  });

  it("types into a field the page moved within the origin its value was revealed for", async () => {
    const { report, typed } = fill(phoneStep, [phone], [moved(www), focused(www)], [www]);
    expect(await report).toMatchObject({ outcome: "filled", submit: "none" });
    expect(typed).toEqual([phone]);
  });

  it("types into a moved field whose value no host revealed, as before", async () => {
    for (const revealedFor of [undefined, [undefined]]) {
      const answers = [moved(login), focused(login)];
      const { report, typed } = fill(phoneStep, [phone], answers, revealedFor);
      expect(await report).toMatchObject({ outcome: "filled", submit: "none" });
      expect(typed).toEqual([phone]);
    }
  });

  it("refuses a date the page moved to another origin, before the call that fills it", async () => {
    const step: AutofillStep = { fields: [{ selector: "#birth-date", slot: "date_of_birth" }] };
    const { report, calls } = fill(step, ["1990-04-12"], [moved(login)], [www]);
    expect(await report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    // Only the call that found the field moved, which did nothing.
    expect(calls).toHaveLength(1);
  });

  it("refuses a calling-code picker the page moved to another origin, before the call that picks", async () => {
    const step: AutofillStep = {
      fields: [{ selector: "#country", slot: "phone", accepts: ["phone"], format: "calling_code" }],
    };
    const { report, calls } = fill(step, ["91"], [moved(login)], [www]);
    expect(await report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    // Only the call that found the field moved, which did nothing.
    expect(calls).toHaveLength(1);
  });

  it("refuses a field an earlier field's call found moved, after typing that one", async () => {
    const step: AutofillStep = {
      fields: [
        { selector: "#country", slot: "username" },
        { selector: "#phone", slot: "phone" },
      ],
    };
    const { report, typed, calls } = fill(
      step,
      ["IN", phone],
      [moved(login, 2), focused(login)],
      [undefined, www],
    );
    expect(await report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "username", status: "filled" },
        { slot: "phone", status: "failed" },
      ],
      submit: "not_attempted",
    });
    expect(typed).toEqual(["IN"]);
    expect(calls).toHaveLength(2);
  });
});

describe("a script's sign-in under a bound, with a reveal that never answers", () => {
  const held = {
    username: "sec_phone",
    primaryIdentifierKind: "phone" as const,
    phone: "sec_phone",
  };

  /** The sign-in again under `bound`, whose host reveals what `answers` reveals, else never. */
  const ensure = (bound: SessionSignInBound, answers: Readonly<Record<string, string>> = {}) => {
    const fake = shop();
    const recipe = shopRecipe();
    const calls: string[] = [];
    const reveal: RevealSignInValue = (value) =>
      Effect.suspend(() => {
        calls.push(value);
        const answer = answers[value];
        return answer === undefined ? Effect.never : Effect.succeed(answer);
      });
    const signIn = makeLocalSessionSignIn({
      browser: fake.browser,
      recorded: () => ({ recipe, entryUrl: `${www}/login` }),
      login: {
        login: {
          held: () => held,
          values: Effect.succeed(held),
          correct: () => Effect.fail(new Error("The test corrects no login")),
        },
      },
      asks: makeBoundableAsk(owner().ask),
      secrets: makeRunSecrets(),
      reveal,
      site,
      siteOrigin: www,
      limits: runSessionSignIns,
      scope: "attempt",
      timing: { stepWaitMs: 60, pollMs: 2 },
    });
    const result = Effect.runPromise(
      Effect.either(signIn.ensureSignedIn("signed_out_mid_operation", bound)),
    );
    return { result, calls, fake };
  };
  /** The sign-in ended refused because its bound passed: the screen typed nothing, and stopped. */
  const refusedAtBound = (result: Either.Either<unknown, unknown>) =>
    Either.isLeft(result) &&
    result.left instanceof SessionSignInFailed &&
    result.left.refusal === "session_sign_in_failed" &&
    result.left.failure instanceof Error &&
    result.left.failure.name === "SessionSignInExpired";

  it("refuses the reveal once the bound passes, typing nothing", async () => {
    const { result, calls, fake } = ensure({
      untilMs: Date.now() + 300,
      stop: new AbortController().signal,
    });
    expect(refusedAtBound(await result)).toBe(true);
    expect(calls).toEqual(["sec_phone"]);
    expect(fake.fills).toEqual([]);
  });

  it("refuses the reveal once the bound's stop is raised", async () => {
    const stop = new AbortController();
    const { result, fake } = ensure({ untilMs: Date.now() + 60_000, stop: stop.signal });
    setTimeout(() => stop.abort(), 200);
    expect(refusedAtBound(await result)).toBe(true);
    expect(fake.fills).toEqual([]);
  });

  it("reports the bound passing during a later screen's reveal as the bound's", async () => {
    const bound = { untilMs: Date.now() + 400, stop: new AbortController().signal };
    const { result, calls, fake } = ensure(bound, { sec_phone: phone });
    expect(refusedAtBound(await result)).toBe(true);
    expect(calls).toEqual(["sec_phone", "sec_code"]);
    expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
  });
});
