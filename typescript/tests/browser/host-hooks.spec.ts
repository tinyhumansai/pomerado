import { once } from "node:events";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import type { ModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { chromium, firefox } from "playwright";
import { firefoxPrefs } from "../../src/execution/playwright-execute.js";
import { createPomerado } from "../../src/standalone/pomerado.js";
import type { PomeradoOptions } from "../../src/standalone/contracts.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { EnteredCommit, OperationHooks } from "../../src/runtime/operation-hooks.js";
import { html, startSite } from "./guardian-context-fixture.js";
import { projectBrowser } from "./project-browser.js";

// A host drives Pomerado through its hooks: it watches each run start and move, holds a write's
// click until it accepts the checkout the script read, hands the session's site data in and out,
// and gives it a browser of its own, with the context its runs need.

/** Records and fails any model request: a run makes none. */
const unreachableModel = (calls: string[], role: string): ModelProvider => ({
  getModel: () => {
    calls.push(role);
    throw new Error(`Unexpected ${role} model request during a run`);
  },
});

/** The project's browser for a server the host launched itself: its name, never a build. */
const projectBrowserName = () => {
  const { executablePath: _launched, ...named } = projectBrowser();
  return named;
};

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

/**
 * A proxy that is the shop itself: it answers every request it is asked to forward, once the
 * request names the run's login, as an egress proxy that checks its runs would. It never reaches
 * the network. A signed-in shop answers its root with the account, read from the session cookie.
 */
const proxyShop = async () => {
  const seen: { readonly url: string; readonly login: string | undefined; readonly run: string | undefined; readonly language: string | undefined }[] = [];
  const login = `Basic ${Buffer.from("run-1.2:lease-token").toString("base64")}`;
  const server = createServer((request, response) => {
    const presented = request.headers["proxy-authorization"];
    seen.push({
      url: request.url ?? "",
      login: presented === undefined ? undefined : presented === login ? "run" : "other",
      run: typeof request.headers["x-run"] === "string" ? request.headers["x-run"] : undefined,
      language:
        typeof request.headers["accept-language"] === "string"
          ? request.headers["accept-language"]
          : undefined,
    });
    if (presented !== login) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="egress"' });
      response.end();
      return;
    }
    if (!(request.url ?? "").startsWith("http://shop.test/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const signedIn = /(?:^|;\s*)session=s-1(?:;|$)/u.test(request.headers.cookie ?? "");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      signedIn
        ? `<h1 id="account">Signed in as Asha</h1>`
        : `<a id="sign-in" href="/login">Sign in</a>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No proxy address");
  return {
    server: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

/** A read of the shop's account, as a minted read would make it. */
const readAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  {
    name: "read_account",
    input: Schema.Struct({}),
    output: Schema.Struct({ account: Schema.NullOr(Schema.String), basket: Schema.NullOr(Schema.String) }),
  },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "const account = page.locator('#account'); return { account: (await account.count()) > 0 ? await account.innerText() : null, basket: await page.evaluate(() => localStorage.getItem('basket')) };",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The account did not read");
    return read.result;
  },
);`;

/** The project's browser as a server the host launched itself, as a host that watches its own. */
const hostServer = async () => {
  const project = test.info().project;
  if (project.use.browserName !== "firefox") return chromium.launchServer();
  const executablePath: unknown = project.metadata["executablePath"];
  return firefox.launchServer({
    firefoxUserPrefs: firefoxPrefs,
    ...(typeof executablePath === "string" ? { executablePath } : {}),
  });
};

test("a host's own browser server, with its context options, runs a minted read signed in from the restored profile through the host's proxy", async () => {
  test.setTimeout(90_000);
  const proxy = await proxyShop();
  const server = await hostServer();
  const calls: string[] = [];
  try {
    const restored = {
      cookies: [
        {
          name: "session",
          value: "s-1",
          domain: "shop.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [{ origin: "http://shop.test", localStorage: [{ name: "basket", value: "b-1" }] }],
    };
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: {
              ...projectBrowserName(),
              endpoint: server.wsEndpoint(),
              context: {
                proxy: { server: proxy.server, username: "run-1.2", password: "lease-token" },
                locale: "en-IN",
                timezoneId: "Asia/Kolkata",
                extraHTTPHeaders: { "x-run": "r-1" },
                storageState: restored,
              },
            },
          });
          return yield* pomerado.run(artifact(readAccount), {
            url: "http://shop.test/",
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(output).toEqual({ account: "Signed in as Asha", basket: "b-1" });
    const pages = proxy.seen.filter((request) => request.login === "run");
    expect(pages.length).toBeGreaterThan(0);
    for (const request of pages) {
      expect(request.url.startsWith("http://shop.test/")).toBe(true);
      expect(request.run).toBe("r-1");
      expect(request.language?.startsWith("en-IN")).toBe(true);
    }
    // Nothing went past the proxy with another login.
    expect(proxy.seen.some((request) => request.login === "other")).toBe(false);
    expect(calls).toEqual([]);
  } finally {
    await server.close();
    await proxy.close();
  }
});

test("a saved session restored into a new one brings back its cookies, storage and tab storage, with the host's location for the site alone", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) => {
    html(response, "<h1>Shop</h1>");
  });
  const calls: string[] = [];
  const readProfile = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_profile", input: Schema.Struct({}), output: Schema.Unknown },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: \`return await page.evaluate(async () => ({
  cookie: document.cookie,
  basket: localStorage.getItem("basket"),
  cart: sessionStorage.getItem("cart"),
  offset: new Date().getTimezoneOffset(),
  language: navigator.language,
  location: await new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (where) => resolve([where.coords.latitude, where.coords.longitude]),
      (failure) => resolve(failure.code),
    ),
  ),
}));\`,
      timeout_sec: 15,
    });
    if (!read.success) throw new Error("The profile did not read: " + read.error);
    return read.result;
  },
);`;
  const setProfile = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "set_profile", input: Schema.Struct({}), output: Schema.Struct({}) },
  async ({ kernel, sessionId }) => {
    const set = await kernel.browsers.playwright.execute(sessionId, {
      code: "await page.evaluate(() => { document.cookie = 'visit=v-1; path=/'; localStorage.setItem('basket', 'b-1'); sessionStorage.setItem('cart', 'c-1'); }); return true;",
      timeout_sec: 10,
    });
    if (!set.success) throw new Error("The profile was not set");
    return {};
  },
);`;
  const request = { url: site.url, intent: "Read the profile", effect: "read" as const, input: {} };
  try {
    const saved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          yield* pomerado.run(artifact(setProfile), request);
          return yield* pomerado.saveSession(site.url);
        }),
      ),
    );
    const profile = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: {
              ...projectBrowser(),
              context: {
                storageState: saved.state as never,
                locale: "en-IN",
                timezoneId: "Asia/Kolkata",
                geolocation: { latitude: 23.26, longitude: 77.41 },
                permissions: [{ origin: site.origin, permissions: ["geolocation"] }],
              },
            },
            sessionStorage: saved.sessionStorage,
          });
          return yield* pomerado.run(artifact(readProfile), request);
        }),
      ),
    );
    expect(profile).toEqual({
      cookie: "visit=v-1",
      basket: "b-1",
      cart: "c-1",
      // India's time, half an hour off the hour, whichever name the browser's zone data uses.
      offset: -330,
      language: "en-IN",
      location: [23.26, 77.41],
    });
    expect(calls).toEqual([]);
  } finally {
    await site.close();
  }
});
