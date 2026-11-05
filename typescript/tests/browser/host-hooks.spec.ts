import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import type { ModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { chromium, firefox } from "playwright";
import { firefoxPrefs } from "../../src/execution/playwright-execute.js";
import { createPomerado } from "../../src/standalone/pomerado.js";
import type { PomeradoOptions } from "../../src/standalone/contracts.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import type { EnteredCommit, OperationHooks } from "../../src/runtime/operation-hooks.js";
import {
  call,
  execution,
  executionIdOf,
  html,
  message as said,
  patch,
  recordingGuardian,
  startSite,
} from "./guardian-context-fixture.js";
import { projectBrowser } from "./project-browser.js";
import { mint } from "./standalone-mint-fixture.js";

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
      { mark: { name: "place-order", report, callOut: false }, posts: 0 },
      { mark: { name: "place-order", report, callOut: false }, posts: 0 },
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
    expect(refused).toMatchObject({
      commitRefused: "place-order",
      outcome: { writeStatus: "not_applied", possibleCommit: false },
    });
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
    const { output, beforeRun, saved } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            sessionStorage: [{ origin: site.origin, entries: [["cart", "c-1"]] }],
          });
          // Putting the tab's storage back sends the site nothing.
          const beforeRun = [...site.requests];
          const output = yield* pomerado.run(artifact(readCart), {
            url: site.url,
            intent: "Read the cart",
            effect: "read",
            input: {},
          });
          return { output, beforeRun, saved: yield* pomerado.saveSession(site.url) };
        }),
      ),
    );
    expect(beforeRun).toEqual([]);
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
  const seen: {
    readonly url: string;
    readonly login: string | undefined;
    readonly run: string | undefined;
    readonly language: string | undefined;
  }[] = [];
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

/**
 * A read of the shop's account, as a minted read would make it, with the page's time zone and
 * whatever of the host's context its page code can find in the worker that runs it.
 */
const readAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  {
    name: "read_account",
    input: Schema.Struct({}),
    output: Schema.Struct({
      account: Schema.NullOr(Schema.String),
      basket: Schema.NullOr(Schema.String),
      offset: Schema.Number,
      context: Schema.Unknown,
    }),
  },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "const account = page.locator('#account'); return { account: (await account.count()) > 0 ? await account.innerText() : null, basket: await page.evaluate(() => localStorage.getItem('basket')), offset: await page.evaluate(() => new Date().getTimezoneOffset()), context: process.getBuiltinModule('node:worker_threads').workerData?.context ?? null };",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The account did not read: " + read.error);
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
    // The proxy's login and the restored cookies stay with the host: page code finds none of
    // the context in its worker.
    expect(output).toEqual({
      account: "Signed in as Asha",
      basket: "b-1",
      offset: -330,
      context: null,
    });
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
    // The same server under another name is another origin, which the host granted nothing.
    const elsewhere = await kernel.browsers.playwright.execute(sessionId, {
      code: "await page.goto(page.url().replace('127.0.0.1', 'localhost')); return await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state);",
      timeout_sec: 15,
    });
    if (!elsewhere.success) throw new Error("The other origin did not read: " + elsewhere.error);
    return { ...read.result, elsewhere: elsewhere.result };
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
    const requestsBefore = site.requests.length;
    const { beforeRun, profile } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: {
              ...projectBrowser(),
              context: {
                storageState: saved.state,
                locale: "en-IN",
                timezoneId: "Asia/Kolkata",
                geolocation: { latitude: 12.5, longitude: 45.5 },
                permissions: [{ origin: site.origin, permissions: ["geolocation"] }],
              },
            },
            sessionStorage: saved.sessionStorage,
          });
          // Restoring the profile sends the site nothing.
          const beforeRun = [...site.requests];
          return { beforeRun, profile: yield* pomerado.run(artifact(readProfile), request) };
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
      location: [12.5, 45.5],
      elsewhere: expect.not.stringMatching(/^granted$/u),
    });
    expect(beforeRun.length).toBe(requestsBefore);
    expect(calls).toEqual([]);
  } finally {
    await site.close();
  }
});

/**
 * A shop at `https://shop.test` that signs in with a phone number and the code it sends, and no
 * password, recording each number and code its forms receive. It is reached through `proxy`,
 * which tunnels every connection to it, as a resolver that maps its name would, so a context
 * that sets the proxy and takes its own certificate (`ignoreHTTPSErrors`) opens it on any browser.
 */
const phoneShop = async (
  options: { readonly codeBoxes?: boolean; readonly passwordField?: boolean } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-phone-shop-"));
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    "/CN=shop.test",
    "-days",
    "1",
  ]);
  const received = { phones: [] as string[], codes: [] as string[] };
  const shop = createHttpsServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const path = new URL(request.url ?? "/", "https://shop.test").pathname;
        const form = new URLSearchParams(body);
        if (request.method === "POST" && path === "/send-code") {
          received.phones.push(form.get("phone") ?? "");
          response.writeHead(303, { Location: "/verify" });
          response.end();
          return;
        }
        if (request.method === "POST" && path === "/verify") {
          const code =
            form.get("code") ?? [1, 2, 3, 4, 5, 6].map((box) => form.get(`d${box}`) ?? "").join("");
          received.codes.push(code);
          response.writeHead(
            303,
            code === "424242"
              ? { Location: "/", "Set-Cookie": "session=s-1; Path=/; Secure; HttpOnly" }
              : { Location: "/verify" },
          );
          response.end();
          return;
        }
        if (path === "/login") {
          html(
            response,
            `<form method="post" action="/send-code"><label>Phone number <input name="phone" type="tel" autocomplete="tel"></label>${options.passwordField === true ? `<label>Password <input name="password" type="password"></label>` : ""}<button>Send code</button></form>`,
          );
          return;
        }
        if (path === "/verify") {
          // The code in one field, or in six one-character boxes.
          const fields = options.codeBoxes
            ? [1, 2, 3, 4, 5, 6]
                .map(
                  (box) =>
                    `<input id="otp-${box}" name="d${box}" maxlength="1" inputmode="numeric" aria-label="Digit ${box}">`,
                )
                .join("")
            : `<label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>`;
          html(response, `<form method="post" action="/verify">${fields}<button>Verify</button></form>`);
          return;
        }
        const signedIn = /(?:^|;\s*)session=s-1(?:;|$)/u.test(request.headers.cookie ?? "");
        html(
          response,
          signedIn ? `<h1 id="account">Signed in</h1>` : `<a href="/login">Sign in</a>`,
        );
      });
    },
  );
  shop.listen(0, "127.0.0.1");
  await once(shop, "listening");
  const shopAddress = shop.address();
  if (shopAddress === null || typeof shopAddress === "string") throw new Error("No shop address");
  const tunnel = createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  tunnel.on("connect", (_request, client: Socket, head: Buffer) => {
    const upstream = connect(shopAddress.port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  tunnel.listen(0, "127.0.0.1");
  await once(tunnel, "listening");
  const tunnelAddress = tunnel.address();
  if (tunnelAddress === null || typeof tunnelAddress === "string")
    throw new Error("No proxy address");
  const closing = (server: { close: (done: () => void) => unknown }) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    origin: "https://shop.test",
    url: "https://shop.test/",
    /** The context that reaches the shop. */
    context: {
      proxy: { server: `http://127.0.0.1:${tunnelAddress.port}` },
      ignoreHTTPSErrors: true,
    },
    received,
    close: async () => {
      shop.closeAllConnections();
      tunnel.closeAllConnections();
      await Promise.all([closing(shop), closing(tunnel)]);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** The phone shop's sign-in as a build publishes it: the number, then the code. */
const phoneSignIn = (origin: string, codeBoxes = false) => ({
  recipe: {
    version: 1 as const,
    steps: [
      {
        page: `${origin}/login`,
        fields: [{ selector: "input[name=phone]", accepts: ["phone" as const] }],
        submit: "button",
        submittedBy: "host" as const,
      },
      {
        page: `${origin}/verify`,
        fields: codeBoxes
          ? [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const }))
          : [{ selector: "input[name=code]", slot: "code" as const }],
        submit: "button",
        submittedBy: "host" as const,
      },
    ],
    signedIn: { selector: "#account" },
  },
  entryUrl: `${origin}/login`,
});

/** A read of the account heading, behind the phone shop's sign-in. */
const phoneAccount = (origin: string, codeBoxes = false) => ({
  ...artifact(`import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_account", input: Schema.Struct({}), output: Schema.Struct({ account: Schema.String }) },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "return await page.locator('#account').innerText();",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The account did not read");
    return { account: read.result };
  },
);`),
  signIn: phoneSignIn(origin, codeBoxes),
});

/** Answers the login with `phone` alone and the code with `code`, recording each request. */
const phoneAnswers = (asked: InputRequest[], phone: string, code: string) =>
  makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.type === "credential" ? { username: phone, saveLogin: false } : code,
        ]),
      );
    }),
  );

test("a run whose recorded sign-in types no password asks for the phone number alone, then the code, and signs in", async () => {
  test.setTimeout(90_000);
  const shop = await phoneShop();
  const calls: string[] = [];
  const asked: InputRequest[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: { ...projectBrowser(), context: shop.context },
            ask: phoneAnswers(asked, "+15555550123", "424242"),
          });
          return yield* pomerado.run(phoneAccount(shop.origin), {
            url: shop.url,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(output).toEqual({ account: "Signed in" });
    const login = asked
      .flatMap((request) => request.questions)
      .find((question) => question.type === "credential");
    expect(login).toMatchObject({ currentStep: { identifierKinds: ["phone"], password: false } });
    expect(shop.received).toEqual({ phones: ["+15555550123"], codes: ["424242"] });
    expect(calls).toEqual([]);
  } finally {
    await shop.close();
  }
});

test("a host that answers with handles gets each one revealed for its field's own origin just before it is typed, and a refused reveal types nothing", async () => {
  test.setTimeout(120_000);
  const shop = await phoneShop();
  const calls: string[] = [];
  const values: Readonly<Record<string, string>> = {
    "sec_phone": "+15555550123",
    "sec_code": "424242",
  };
  try {
    const revealed: (readonly [string, string])[] = [];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: { ...projectBrowser(), context: shop.context },
            ask: phoneAnswers([], "sec_phone", "sec_code"),
            reveal: (value, origin) =>
              Effect.suspend(() => {
                revealed.push([value, origin]);
                const held = values[value];
                return held !== undefined && origin === shop.origin
                  ? Effect.succeed(held)
                  : Effect.fail(new Error("Not on this origin"));
              }),
          });
          return yield* pomerado.run(phoneAccount(shop.origin), {
            url: shop.url,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(output).toEqual({ account: "Signed in" });
    expect(revealed).toEqual([
      ["sec_phone", shop.origin],
      ["sec_code", shop.origin],
    ]);
    expect(shop.received).toEqual({ phones: ["+15555550123"], codes: ["424242"] });

    // A host that refuses every reveal, or whose reveal dies, gets nothing typed, and the run
    // fails for the answer the host withheld.
    for (const reveal of [
      () => Effect.fail(new Error("Not on this origin")),
      () => Effect.die(new Error("The host's store failed")),
    ]) {
      let asked = 0;
      const refused = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pomerado = yield* session(calls, {
              browser: { ...projectBrowser(), context: shop.context },
              ask: phoneAnswers([], "sec_phone", "sec_code"),
              reveal: (value, origin) =>
                Effect.suspend(() => {
                  asked++;
                  return reveal();
                }).pipe(Effect.as(`${value}@${origin}`)),
            });
            return yield* pomerado.run(phoneAccount(shop.origin), {
              url: shop.url,
              intent: "Read the account",
              effect: "read",
              input: {},
            });
          }),
        ).pipe(Effect.flip),
      );
      expect(refused).toBeInstanceOf(SignInRunFailed);
      expect(refused).toMatchObject({ code: "NeedsInput", reason: "reveal_refused" });
      expect(asked).toBe(1);
    }
    expect(shop.received).toEqual({ phones: ["+15555550123"], codes: ["424242"] });
    expect(calls).toEqual([]);
  } finally {
    await shop.close();
  }
});

test("a handle for a code on six one-character boxes is revealed once and typed a character per box", async () => {
  test.setTimeout(90_000);
  const shop = await phoneShop({ codeBoxes: true });
  const calls: string[] = [];
  const values: Readonly<Record<string, string>> = {
    "sec_phone": "+15555550123",
    "sec_code": "424 242",
  };
  try {
    const revealed: string[] = [];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: { ...projectBrowser(), context: shop.context },
            ask: phoneAnswers([], "sec_phone", "sec_code"),
            reveal: (value, origin) =>
              Effect.suspend(() => {
                revealed.push(value);
                const held = values[value];
                return held !== undefined && origin === shop.origin
                  ? Effect.succeed(held)
                  : Effect.fail(new Error("Not on this origin"));
              }),
          });
          return yield* pomerado.run(phoneAccount(shop.origin, true), {
            url: shop.url,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(output).toEqual({ account: "Signed in" });
    // One reveal each, the code's spaces left out of the boxes.
    expect(revealed).toEqual(["sec_phone", "sec_code"]);
    expect(shop.received).toEqual({ phones: ["+15555550123"], codes: ["424242"] });
    expect(calls).toEqual([]);
  } finally {
    await shop.close();
  }
});

/** Reads the page's heading. Its query only tells one live test case from another. */
const searchHeading = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_heading",input:Schema.Struct({query:Schema.String}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const read = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').innerText();",timeout_sec:10});
  if(!read.success) throw new Error(String(read.error));
  return {heading:String(read.result)};
});`;

/** One case for each query, each expecting a result. */
const headingCases = (...queries: readonly string[]) =>
  JSON.stringify({
    cases: queries.map((query) => ({
      id: query,
      purpose: `The heading for ${query}.`,
      input: { query },
      expect: "result",
    })),
  });

/** Runs every live test case, then the example, and publishes the example's step. */
const testAndPublish = [
  () => [
    call("live_tests", {
      intent: "Run every planned case",
      action: "run",
      entrypoint: "src/tool.mjs",
      cases: null,
      maxWorkers: 1,
    }),
  ],
  () => [
    call(
      "execute",
      execution("example", "src/tool.mjs", { exampleInput: '{"query":"lamp"}' }),
      "example",
    ),
  ],
  (request: Parameters<typeof executionIdOf>[0]) => [
    call("finish_build", {
      intent: "Publish the reader",
      entrypoint: "src/tool.mjs",
      executionId: executionIdOf(request, "example"),
      metadata: { name: "read_heading", description: "Read the page's heading" },
      coverage: "Every case passes on this source. Host live tests: 99 pass, 0 fail.",
    }),
  ],
];

test("a published mint reports its live test counts and Guardian's notes in its outcome", async () => {
  test.setTimeout(120_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Shop</title><h1>Shop</h1>"),
  );
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian: recordingGuardian(),
      intent: "Read the page's heading",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": searchHeading,
            "test/cases.json": headingCases("lamp", "chair"),
          }),
        ...testAndPublish,
      ],
    });

    expect(built.build, JSON.stringify(built)).toBe("published");
    // The host's own counts, whatever the minter's coverage says.
    expect(built.liveTests).toEqual({
      versions: [
        {
          version: "playwright",
          entrypoint: "src/tool.mjs",
          sourceDigest: expect.any(String),
          counts: { pass: 2, fail: 0, inconclusive: 0 },
          coldPasses: 0,
        },
      ],
    });
    expect(built.publicationReview).toEqual({
      reviewId: expect.any(String),
      rationale: "Recorded fixture review",
    });
  } finally {
    await site.close();
  }
});

/** The phone shop's sign-in as a minter walks it: the number, the code, then the signed-in check. */
const phoneSignInTurns = [
  () => [
    call(
      "execute",
      execution("authenticate", "src/tool.mjs", {
        signInStep: {
          fields: [{ selector: "input[name=phone]", accepts: ["phone"] }],
          submit: "button",
        },
      }),
      "phone",
    ),
  ],
  () => [
    call(
      "execute",
      execution("authenticate", "src/tool.mjs", {
        signInStep: {
          fields: [{ selector: "input[name=code]", slot: "code" }],
          submit: "button",
        },
      }),
      "code",
    ),
  ],
  () => [
    call(
      "execute",
      execution("authenticate", "src/tool.mjs", {
        signInStep: { signedIn: { selector: "#account" } },
      }),
      "signed_in",
    ),
  ],
];

/** The account's phone number with no password, as a host that signs in by a code declares it. */
const byPhone = { identifierKinds: ["phone" as const], password: false as const };

test("a mint on an account with no password asks for the number alone, then the code, and publishes a sign-in a run replays", async () => {
  test.setTimeout(180_000);
  const shop = await phoneShop();
  const phone = "+15555550123";
  const asked: InputRequest[] = [];
  const answer = (request: InputRequest) => {
    asked.push(request);
    return Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        question.type === "credential" ? { username: phone, saveLogin: false } : "424242",
      ]),
    );
  };
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian: recordingGuardian(),
      intent: "Read the account's heading",
      timeoutMs: 600_000,
      browser: { context: shop.context },
      passwordless: byPhone,
      answer,
      turns: [
        () =>
          patch({
            "src/tool.mjs": searchHeading,
            "test/cases.json": headingCases("lamp"),
          }),
        ...phoneSignInTurns,
        ...testAndPublish,
      ],
    });

    expect(built.build, JSON.stringify(built)).toBe("published");
    // The login question offers the phone number and no password, then the code is asked for.
    const [login] = asked[0]?.questions ?? [];
    expect(login).toMatchObject({
      type: "credential",
      allowDecline: true,
      currentStep: { identifierKinds: ["phone"], password: false },
    });
    const [code] = asked[1]?.questions ?? [];
    expect(code).toMatchObject({ type: "secret", secretKind: "one_time_code" });
    expect(asked).toHaveLength(2);
    expect(shop.received).toEqual({ phones: [phone], codes: ["424242"] });
    // Every step ran signed in, and the record says so.
    expect(built.liveTests).toMatchObject({
      signedIn: true,
      versions: [{ counts: { pass: 1, fail: 0, inconclusive: 0 } }],
    });
    // The build publishes the sign-in value-free, and no model read the number or the code.
    if (built.artifact === undefined) throw new Error(JSON.stringify(built));
    expect(built.artifact.signIn?.recipe.steps.map((step) => step.fields)).toEqual([
      [{ selector: "input[name=phone]", accepts: ["phone"] }],
      [{ selector: "input[name=code]", slot: "code" }],
    ]);
    expect(JSON.stringify(built.artifact)).not.toContain(phone);
    expect(JSON.stringify(requests)).not.toContain(phone);
    expect(JSON.stringify(requests)).not.toContain("424242");

    // A new session runs the published tool: it asks the same two questions and signs in.
    const runAsked: InputRequest[] = [];
    const calls: string[] = [];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls, {
            browser: { ...projectBrowser(), context: shop.context },
            ask: phoneAnswers(runAsked, phone, "424242"),
          });
          return yield* pomerado.run(built.artifact as NonNullable<typeof built.artifact>, {
            url: shop.url,
            intent: "Read the account's heading",
            input: { query: "lamp" },
            effect: "read",
          });
        }),
      ),
    );
    expect(output).toEqual({ heading: "Signed in" });
    expect(runAsked).toHaveLength(2);
    expect(shop.received).toEqual({ phones: [phone, phone], codes: ["424242", "424242"] });
    expect(calls).toEqual([]);
  } finally {
    await shop.close();
  }
});

test("a mint on an account with no password refuses a screen that takes one, types nothing and tells the minter", async () => {
  test.setTimeout(120_000);
  const shop = await phoneShop({ passwordField: true });
  const asked: InputRequest[] = [];
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian: recordingGuardian(),
      intent: "Read the account's heading",
      browser: { context: shop.context },
      passwordless: byPhone,
      answer: (request) => {
        asked.push(request);
        return { login: { username: "+15555550123", saveLogin: false } };
      },
      turns: [
        () => patch({ "src/tool.mjs": searchHeading }),
        () => [
          call(
            "execute",
            execution("authenticate", "src/tool.mjs", {
              signInStep: {
                fields: [
                  { selector: "input[name=phone]", accepts: ["phone"] },
                  { selector: "input[name=password]", slot: "password" },
                ],
                submit: "button",
              },
            }),
            "password",
          ),
        ],
        () => [said("This shop needs a password.")],
      ],
    });

    expect(built.build).toBe("incomplete");
    const refused = JSON.stringify(requests[2]);
    expect(refused).toContain("credential_unavailable");
    expect(refused).toContain("This login has no password");
    expect(asked).toHaveLength(1);
    expect(shop.received).toEqual({ phones: [], codes: [] });
  } finally {
    await shop.close();
  }
});

for (const [what, passwordless] of [
  ["no identifier kind", { identifierKinds: [], password: false }],
  ["a kind a login doesn't offer", { identifierKinds: ["fax"], password: false }],
  [
    "more kinds than a question offers",
    { identifierKinds: ["username", "email", "phone", "account_number", "phone"], password: false },
  ],
  ["a password", { identifierKinds: ["phone"], password: true }],
] as const)
  test(`a mint refuses a login with no password that names ${what} before it starts`, async () => {
    const calls: string[] = [];
    const refused = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* Effect.flip(
            pomerado.mint({
              url: "https://shop.test/",
              intent: "Read the account's heading",
              effect: "read",
              passwordless: passwordless as never,
            }),
          );
        }),
      ),
    );
    expect(refused.message).toContain("passwordless must name");
    expect(calls).toEqual([]);
  });
