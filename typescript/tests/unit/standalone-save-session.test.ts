// Failure modes covered: a save that runs in the middle of a run's browser calls, holding the
// browser while the run waits; a save interrupted as it waits for the session that still reaches
// the browser, where an interrupted call stops it; a saved state a host must cast before it passes
// it back as its context's storage state; a host's proxy password echoed unmasked by a page or an
// error, and a short proxy login or a username masking ordinary words and refusing a source that
// holds them; and malformed saved session storage failing as a defect, or only once a browser
// started.
import { Effect, Either, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { PlaywrightContextOptions } from "../../src/execution/playwright-execute.js";
import { saveSessionCode } from "../../src/runtime/start-state.js";
import type { PomeradoOptions } from "../../src/standalone/contracts.js";
import { createPomerado, sessionCalls } from "../../src/standalone/pomerado.js";
import { sessionSecrets, type StandaloneSession } from "../../src/standalone/session.js";

const ask: PomeradoOptions["ask"] = () => Effect.die(new Error("never asked"));
const url = "https://shop.example/cart";
const saved = {
  state: { cookies: [], origins: [] },
  sessionStorage: [{ origin: "https://shop.example", entries: [["cart", "c-1"]] }],
};

/**
 * A session on a modeled browser that answers each call with `saved` after a round trip. As the
 * executor does, a call interrupted while it is out stops the browser, which then answers nothing.
 */
const modeledSession = () => {
  const calls: (readonly [string, number | undefined])[] = [];
  let stopped = false;
  const execute = (code: string, timeoutSec?: number) =>
    Effect.suspend(() => {
      if (stopped) return Effect.fail(new Error("Native executor invalidated"));
      calls.push([code, timeoutSec]);
      return Effect.sleep("100 millis").pipe(
        Effect.as(saved),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stopped = true;
          }),
        ),
      );
    });
  const session = {
    browser: { targetId: "primary", execute },
    mutex: Effect.runSync(Effect.makeSemaphore(1)),
  } as unknown as StandaloneSession;
  return { session, calls, stopped: () => stopped };
};

/** Lets a forked save run as far as it goes before it waits, which takes it no time. */
const settled = Effect.sleep("20 millis");

describe("saveSession", () => {
  it("waits for a run in progress, as a mint, a run and a sign-in do", async () => {
    const browser = modeledSession();
    const pomerado = sessionCalls(browser.session);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // A run in progress holds the session.
        yield* browser.session.mutex.take(1);
        const save = yield* Effect.fork(pomerado.saveSession(url));
        yield* settled;
        expect(browser.calls).toEqual([]);
        yield* browser.session.mutex.release(1);
        return yield* Fiber.join(save);
      }),
    );
    expect(result).toEqual(saved);
    expect(browser.calls).toEqual([[saveSessionCode("primary", "https://shop.example"), 60]]);
    // A host passes the saved state back as a later session's storage state as it is.
    const restored: PlaywrightContextOptions["storageState"] = result.state;
    expect(restored).toEqual(saved.state);
  });

  it("leaves the browser working when a save waiting for the session is interrupted", async () => {
    const browser = modeledSession();
    const pomerado = sessionCalls(browser.session);
    const later = await Effect.runPromise(
      Effect.gen(function* () {
        yield* browser.session.mutex.take(1);
        const save = yield* Effect.fork(pomerado.saveSession(url));
        yield* settled;
        // As Pomerado interrupts a hook, such as a commit hook still deciding when a run ends.
        yield* Fiber.interrupt(save);
        yield* browser.session.mutex.release(1);
        return yield* pomerado.saveSession(url);
      }),
    );
    expect(browser.stopped()).toBe(false);
    expect(later).toEqual(saved);
    expect(browser.calls).toHaveLength(1);
  });
});

/** Options whose browser reaches the site through a proxy with `login`. */
const withProxy = (login: { readonly username?: string; readonly password?: string }) =>
  ({
    ask,
    browser: { context: { proxy: { server: "http://proxy.example:8080", ...login } } },
  }) satisfies PomeradoOptions;

describe("the session's secrets", () => {
  it("mask a proxy password of 8 characters or more, and never the username", () => {
    const secrets = sessionSecrets(
      withProxy({ username: "synthetic-user", password: "synthetic-password" }),
    );
    expect(secrets.redact("407 for synthetic-user: synthetic-password refused")).toBe(
      "407 for synthetic-user: [private] refused",
    );
  });

  it.each([
    ["a short login", { username: "user", password: "pass" }],
    ["a password short once trimmed", { password: "pass    " }],
    ["no login", {}],
  ])("mask no word of a page or a source for %s", async (_, login) => {
    const secrets = sessionSecrets(withProxy(login));
    const text = "Enter your username or user ID. Forgot password? Bypass";
    expect(secrets.redact(text)).toBe(text);
    const source = "const user = page.locator('#user'); await user.fill(input.name); // pass";
    const screened = await Effect.runPromise(Effect.either(secrets.assertAbsent(source)));
    expect(Either.isRight(screened)).toBe(true);
  });
});

/** Why a session with this saved session storage didn't start. */
const refusal = async (sessionStorage: unknown) => {
  const options: unknown = {
    ask,
    // Saved storage that passed would stop the executor here, still before any browser.
    browser: { executablePath: "" },
    sessionStorage,
  };
  const created = await Effect.runPromise(
    Effect.scoped(Effect.either(createPomerado(options as PomeradoOptions))),
  );
  if (Either.isRight(created)) throw new Error("The session started");
  return created.left.message;
};

const malformed =
  "sessionStorage must be as saveSession returned it: each origin with its entries as pairs " +
  "of strings";
const notAPage = "sessionStorage names an origin that is not an http or https page's own";
const shop = "https://shop.example";

describe("a session's saved session storage", () => {
  it.each([
    ["no list", { origin: shop, entries: [] }, malformed],
    ["a string", shop, malformed],
    ["null", null, malformed],
    ["an origin that is no string", [{ origin: 443, entries: [] }], malformed],
    ["an origin without entries", [{ origin: shop }], malformed],
    ["entries that are no list", [{ origin: shop, entries: {} }], malformed],
    ["an entry without a value", [{ origin: shop, entries: [["cart"]] }], malformed],
    ["an entry whose value is no string", [{ origin: shop, entries: [["cart", 1]] }], malformed],
    ["a file origin", [{ origin: "file:///tmp", entries: [] }], notAPage],
    ["an address that is no origin", [{ origin: `${shop}/cart`, entries: [] }], notAPage],
  ])("is refused with %s, before any browser starts", async (_, sessionStorage, message) => {
    expect(await refusal(sessionStorage)).toBe(message);
  });
});
