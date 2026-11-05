// Failure modes covered: a run that asks for a password its recorded sign-in never types, such as
// one by a phone number and a code, and one that skips the password a recipe does type, or offers
// a private identifier as a login's own kind; a correction of a password-free login that switches
// its kind; and a malformed recipe that throws before the sign-in can say it can't be read.
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { recipeLoginStep, type SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { InputAnswers, InputRequest } from "../../src/runtime/input-request.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";
import type { StandaloneSession } from "../../src/standalone/session.js";
import { makeRunSignIn } from "../../src/standalone/session-sign-in.js";

const origin = "https://shop.example";
/** A recipe of one screen with `fields`, then a code screen. */
const recipe = (fields: readonly object[]) =>
  ({
    version: 1,
    steps: [
      { page: `${origin}/login`, fields, submit: "button", submittedBy: "host" },
      {
        page: `${origin}/verify`,
        fields: [{ selector: "input[name=code]", slot: "code" }],
        submit: "button",
        submittedBy: "host",
      },
    ],
    signedIn: { selector: "#account" },
  }) as unknown as SignInRecipe;

describe("a run's login for its recorded sign-in", () => {
  it("asks for the identifier alone when no screen types a password", () => {
    expect(recipeLoginStep(recipe([{ selector: "#phone", accepts: ["phone"] }]))).toEqual({
      identifierKinds: ["phone"],
      password: false,
    });
    expect(
      recipeLoginStep(recipe([{ selector: "#login", accepts: ["phone", "email"] }])),
    ).toEqual({ identifierKinds: ["email", "phone"], password: false });
  });

  it("asks for the whole login when a screen types a password", () => {
    expect(
      recipeLoginStep(
        recipe([
          { selector: "#phone", accepts: ["phone"] },
          { selector: "#password", slot: "password" },
        ]),
      ),
    ).toBeUndefined();
  });

  it("offers no private identifier as the login's own kind", () => {
    expect(
      recipeLoginStep(
        recipe([{ selector: "#pin", accepts: ["private_identifier"], label: "PIN" }]),
      ),
    ).toBeUndefined();
  });
});

describe("a password-free login's correction", () => {
  /** The local login of a sign-in by email or phone, answering each question in turn. */
  const login = (answers: readonly object[]) => {
    const asked: InputRequest[] = [];
    const replies = [...answers];
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        asked.push(request);
        return { login: replies.shift() } as InputAnswers;
      }),
    );
    const local = localSignInLogin({
      ask,
      register: () => {},
      siteOrigin: origin,
      passwordless: { identifierKinds: ["email", "phone"], password: false },
    });
    return { local, asked };
  };
  const email = { username: "ada@shop.example", identifierKind: "email", saveLogin: false };

  it("offers only the kind of the login the site rejected, which it keeps", async () => {
    const { local, asked } = login([email, { username: "ada.l@shop.example", saveLogin: false }]);
    const held = await Effect.runPromise(local.values);
    expect(held).toEqual({
      username: "ada@shop.example",
      primaryIdentifierKind: "email",
      email: "ada@shop.example",
    });
    expect(await Effect.runPromise(local.correct("username", held, 2))).toEqual({
      username: "ada.l@shop.example",
      primaryIdentifierKind: "email",
      email: "ada.l@shop.example",
    });
    expect(asked.map((request) => request.questions[0])).toMatchObject([
      { reason: "missing_credentials", currentStep: { identifierKinds: ["email", "phone"] } },
      {
        reason: "invalid_credentials",
        currentStep: { identifierKinds: ["email"], password: false },
      },
    ]);
  });

  it("masks a phone login in each form a page writes it, and an email login as given", async () => {
    const registering = (answer: object) => {
      const secrets = makeRunSecrets();
      const local = localSignInLogin({
        ask: makeInputAsker(() => Effect.succeed({ login: answer } as InputAnswers)),
        register: secrets.register,
        siteOrigin: origin,
        passwordless: { identifierKinds: ["email", "phone"], password: false },
      });
      return Effect.runPromise(local.values).then(() => secrets);
    };
    const byPhone = { username: "+15555550123", identifierKind: "phone", saveLogin: false };
    expect((await registering(byPhone)).redact("Sent to +1 (555) 555-0123.")).toBe(
      "Sent to [private].",
    );
    expect((await registering(email)).redact("Order 1-555-555-0123")).toBe("Order 1-555-555-0123");
  });

  it("masks a number in each form a page writes it, whatever kind of login holds it", async () => {
    const shown = "Sent to +1 (555) 555-0123.";
    const username = "+15555550123";
    const masked = async (passwordless: object | undefined, answer: object) => {
      const secrets = makeRunSecrets();
      const local = localSignInLogin({
        ask: makeInputAsker(() => Effect.succeed({ login: answer } as InputAnswers)),
        register: secrets.register,
        siteOrigin: origin,
        ...(passwordless === undefined ? {} : { passwordless: passwordless as never }),
      });
      await Effect.runPromise(local.values);
      return secrets.redact(shown);
    };
    // A password login, whose username happens to be the number.
    expect(await masked(undefined, { username, password: "fixture-word", saveLogin: false })).toBe(
      "Sent to [private].",
    );
    // A login with no password that holds the number as its username.
    expect(
      await masked(
        { identifierKinds: ["username"], password: false },
        { username, saveLogin: false },
      ),
    ).toBe("Sent to [private].");
  });

  it("refuses a correction that switches the login to another kind", async () => {
    const phone = { username: "+919812345678", identifierKind: "phone", saveLogin: false };
    const { local } = login([email, phone]);
    const held = await Effect.runPromise(local.values);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(local.correct("username", held)))))
      .toBe(true);
  });
});

describe("a run's sign-in with a malformed recipe", () => {
  /** A session whose browser and owner are never reached; `typed` when a sign-in typed into it. */
  const session = (asked: InputRequest[], typed: boolean) =>
    ({
      options: {},
      browser: {
        targetId: "primary",
        execute: () => Effect.die(new Error("A malformed recipe opens no page")),
        keyboard: { insertText: () => Effect.die(new Error("A malformed recipe types nothing")) },
      },
      ask: (request: InputRequest) => {
        asked.push(request);
        return Effect.die(new Error("A malformed recipe asks nothing"));
      },
      secrets: makeRunSecrets(),
      signInTyping: { typed },
    }) as unknown as StandaloneSession;
  const screen = { page: `${origin}/login`, fields: [{ selector: "#phone", accepts: ["phone"] }] };
  const fieldless = { page: origin };

  it.each([
    ["without steps", { version: 1, signedIn: {} }, false],
    ["with a screen without fields", { version: 1, steps: [fieldless], signedIn: {} }, false],
    ["without its marker, on a browser typed into", { version: 1, steps: [screen] }, true],
  ])("fails MissingRecipe for a recipe %s, asking nothing", async (_, malformed, typed) => {
    const asked: InputRequest[] = [];
    const signIn = { recipe: malformed as unknown as SignInRecipe, entryUrl: `${origin}/login` };
    const result = await Effect.runPromise(
      Effect.either(
        Effect.suspend(() => makeRunSignIn(session(asked, typed), signIn, origin, []).before),
      ),
    );
    expect(result).toEqual(
      Either.left(new SignInRunFailed({ code: "MissingRecipe", reason: "invalid" })),
    );
    expect(asked).toEqual([]);
  });
});
