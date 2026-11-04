import { test, expect } from "@playwright/test";
import type { ModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import type { PomeradoOptions } from "../../src/standalone/contracts.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { EnteredCommit, OperationHooks } from "../../src/runtime/operation-hooks.js";
import { html, startSite } from "./guardian-context-fixture.js";
import { projectBrowser } from "./project-browser.js";

// A host drives Pomerado through its hooks: it watches each run start and move, holds a write's
// click until it accepts the checkout the script read, and hands the session's site data in and
// out.

/** Records and fails any model request: a run makes none. */
const unreachableModel = (calls: string[], role: string): ModelProvider => ({
  getModel: () => {
    calls.push(role);
    throw new Error(`Unexpected ${role} model request during a run`);
  },
});

/** A library session on the project's browser, with no model and no questions. */
const session = (calls: string[], options: Partial<PomeradoOptions> = {}) =>
  createPomerado({
    browser: projectBrowser(),
    ask: makeInputAsker(() => Effect.succeed({})),
    minterProvider: unreachableModel(calls, "minter"),
    guardianProvider: unreachableModel(calls, "guardian"),
    timeoutMs: 20_000,
    ...options,
  });

/** A checkout whose Pay button places the order with a POST and then shows its number. */
const checkout = () =>
  startSite((request, response) => {
    if (request.method === "POST") {
      response.end("placed");
      return;
    }
    html(
      response,
      `<meta charset="utf-8"><p id="total">Total ₹204</p><label><input type="radio" name="pay" checked> Cash on delivery</label>
<button id="place" onclick="fetch('/order',{method:'POST'}).then(()=>{document.body.innerHTML='<p id=placed>Order OD-1 placed</p>'})">Pay ₹204 on delivery</button>`,
    );
  });

/** A write that reads the checkout, enters its commit step with it, clicks once and confirms. */
const placeOrder = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  {
    name: "place_order",
    input: Schema.Struct({}),
    output: Schema.Struct({ order: Schema.String }),
    write: { confirmation: "message", commits: ["place-order"] },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    const shown = await kernel.browsers.playwright.execute(sessionId, {
      code: "return { button: await page.locator('#place').innerText(), total: await page.locator('#total').innerText() };",
      timeout_sec: 10,
    });
    if (!shown.success) throw new Error("The checkout did not read");
    enteringCommit("place-order", shown.result);
    const placed = await kernel.browsers.playwright.execute(sessionId, {
      code: "await page.locator('#place').click(); return await page.locator('#placed').innerText();",
      timeout_sec: 10,
    });
    if (!placed.success) throw new Error("The order was not placed");
    verified({ confirmation: "message" });
    return { order: placed.result };
  },
);`;

const artifact = (source: string) => ({
  entrypoint: "src/tool.mjs",
  files: [{ path: "src/tool.mjs", content: source }],
  inputSchema: {},
  outputSchema: {},
});

test("a write's click waits for the host's commit hook, which hears the checkout the script read; a refusal sends nothing", async () => {
  test.setTimeout(90_000);
  const site = await checkout();
  const calls: string[] = [];
  try {
    const started: number[] = [];
    const fingerprints: string[] = [];
    const entered: { readonly mark: EnteredCommit; readonly posts: number }[] = [];
    const posts = () => site.requests.filter((line) => line.startsWith("POST")).length;
    const hooks: OperationHooks = {
      started: () => Effect.sync(() => started.push(posts())),
      progress: (fingerprint) => Effect.sync(() => fingerprints.push(fingerprint)),
      commit: (mark) =>
        Effect.gen(function* () {
          entered.push({ mark, posts: posts() });
          // The click waits: nothing reaches the shop while the host decides.
          yield* Effect.sleep(500);
          entered.push({ mark, posts: posts() });
        }),
    };
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.run(
            artifact(placeOrder),
            { url: site.url, intent: "Place the order", effect: "write", input: {} },
            hooks,
          );
        }),
      ),
    );
    expect(output).toEqual({ order: "Order OD-1 placed" });
    expect(started).toEqual([0]);
    const report = { button: "Pay ₹204 on delivery", total: "Total ₹204" };
    expect(entered).toEqual([
      { mark: { name: "place-order", report }, posts: 0 },
      { mark: { name: "place-order", report }, posts: 0 },
    ]);
    expect(posts()).toBe(1);
    // One fingerprint after each of the script's two calls, and the click changed the page.
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[1]).not.toBe(fingerprints[0]);

    const refused = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.run(
            artifact(placeOrder),
            { url: site.url, intent: "Place the order", effect: "write", input: {} },
            { commit: () => Effect.fail(new Error("The cart changed since the yes")) },
          );
        }),
      ).pipe(Effect.flip),
    );
    expect(refused).toBeInstanceOf(RunOutcomeFailure);
    expect(refused).toMatchObject({ outcome: { writeStatus: "not_applied", possibleCommit: false } });
    expect(posts()).toBe(1);
    expect(calls).toEqual([]);
  } finally {
    await site.close();
  }
});

test("a session puts the host's saved tab storage back before its first page, and saveSession returns what the site keeps", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) => {
    response.setHeader("Set-Cookie", "visit=v-1; Path=/");
    html(
      response,
      `<script>localStorage.setItem("basket", "b-1"); sessionStorage.setItem("seen", "yes");</script><h1>Shop</h1>`,
    );
  });
  const calls: string[] = [];
  const readCart = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_cart", input: Schema.Struct({}), output: Schema.Struct({ cart: Schema.NullOr(Schema.String) }) },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "return await page.evaluate(() => sessionStorage.getItem('cart'));",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The page did not read");
    return { cart: read.result ?? null };
  },
);`;
  try {
    const { output, saved } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            sessionStorage: [{ origin: site.origin, entries: [["cart", "c-1"]] }],
          });
          const output = yield* pomerado.run(artifact(readCart), {
            url: site.url,
            intent: "Read the cart",
            effect: "read",
            input: {},
          });
          return { output, saved: yield* pomerado.saveSession(site.url) };
        }),
      ),
    );
    expect(output).toEqual({ cart: "c-1" });
    expect(saved.sessionStorage).toEqual([
      { origin: site.origin, entries: expect.arrayContaining([["cart", "c-1"], ["seen", "yes"]]) },
    ]);
    const state = saved.state as {
      readonly cookies: readonly { readonly name: string; readonly value: string }[];
      readonly origins: readonly {
        readonly origin: string;
        readonly localStorage: readonly { readonly name: string; readonly value: string }[];
      }[];
    };
    expect(state.cookies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "visit", value: "v-1" })]),
    );
    expect(state.origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: site.origin,
          localStorage: expect.arrayContaining([{ name: "basket", value: "b-1" }]),
        }),
      ]),
    );
    expect(calls).toEqual([]);
  } finally {
    await site.close();
  }
});

test("a host's sign-in refuses an artifact that records none, before the browser loads anything", async () => {
  const site = await startSite((_request, response) => html(response, "<h1>Shop</h1>"));
  const calls: string[] = [];
  try {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.signIn(artifact(placeOrder), {
            url: site.url,
            intent: "Sign in",
            input: {},
          });
        }),
      ).pipe(Effect.flip),
    );
    expect(failure.message).toContain("records no sign-in");
    expect(site.requests).toEqual([]);
  } finally {
    await site.close();
  }
});

test("a run's page code sees none of the host's environment", async () => {
  const name = "POMERADO_TEST_HOST_KEY";
  process.env[name] = "host-only";
  const site = await startSite((_request, response) => html(response, "<h1>Shop</h1>"));
  const calls: string[] = [];
  const readEnvironment = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_environment", input: Schema.Struct({}), output: Schema.Struct({ seen: Schema.Boolean }) },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: ${JSON.stringify(`return typeof process !== "undefined" && process.env[${JSON.stringify(name)}] !== undefined;`)},
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The page code did not run");
    return { seen: read.result === true };
  },
);`;
  try {
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.run(artifact(readEnvironment), {
            url: site.url,
            intent: "Read the environment",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(output).toEqual({ seen: false });
  } finally {
    delete process.env[name];
    await site.close();
  }
});
