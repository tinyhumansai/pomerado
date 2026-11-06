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
import { readFrameCode } from "../../src/execution/pages-watch.js";
import { firefoxPrefs } from "../../src/execution/playwright-execute.js";
import { createPomerado } from "../../src/standalone/pomerado.js";
import type { PomeradoOptions } from "../../src/standalone/contracts.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import type {
  EnteredCommit,
  OperationHooks,
  PagesSeen,
} from "../../src/runtime/operation-hooks.js";
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
  options: {
    readonly codeBoxes?: boolean;
    readonly passwordField?: boolean;
    /** The code screen's field is a password input, as some sites draw a one-time code. */
    readonly codeInPassword?: boolean;
    /** What the code screen says of the number it received, in its text and in its field's label. */
    readonly echo?: (phone: string) => readonly [text: string, label: string];
    /** The code screen's address and a link on it hold the number it received. */
    readonly echoInAddress?: boolean;
  } = {},
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
          const phone = form.get("phone") ?? "";
          received.phones.push(phone);
          const to = options.echoInAddress === true ? `?to=${encodeURIComponent(phone)}` : "";
          response.writeHead(303, { Location: `/verify${to}` });
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
          const echoed = options.echo?.(received.phones.at(-1) ?? "");
          // The code in one field, or in six one-character boxes.
          const fields = options.codeBoxes
            ? [1, 2, 3, 4, 5, 6]
                .map(
                  (box) =>
                    `<input id="otp-${box}" name="d${box}" maxlength="1" inputmode="numeric" aria-label="Digit ${box}">`,
                )
                .join("")
            : `<label>Code ${echoed?.[1] ?? ""} <input name="code" ${options.codeInPassword === true ? 'type="password"' : ""} inputmode="numeric" autocomplete="one-time-code"></label>`;
          html(
            response,
            `${echoed === undefined ? "" : `<p>We sent a code to ${echoed[0]}</p>`}${options.echoInAddress === true ? `<a href="/resend?to=${encodeURIComponent(received.phones.at(-1) ?? "")}">Send it again</a>` : ""}<form method="post" action="/verify">${fields}<button>Verify</button></form>`,
          );
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

/** A probe that reads the whole page, as a minter's exploration reads a code screen. */
const readBody = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_body", input: Schema.Struct({}), output: Schema.Struct({ text: Schema.String }) },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "return await page.locator('body').innerText();",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error("The page did not read");
    return { text: String(read.result) };
  },
);`;

/** The phone shop's first screen as a minter sends it, with the phone field's own format. */
const phoneStep = (format?: "national") => () => [
  call(
    "execute",
    execution("authenticate", "src/tool.mjs", {
      signInStep: {
        fields: [
          {
            selector: "input[name=phone]",
            accepts: ["phone"],
            ...(format === undefined ? {} : { format }),
          },
        ],
        submit: "button",
      },
    }),
    "phone",
  ),
];

/** The phone shop's sign-in as a minter walks it: the number, the code, then the signed-in check. */
const phoneSignInTurns = [
  phoneStep(),
  () => [call("execute", execution("explore", "explore/body.mjs"), "explore")],
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
  const phone = "+15555550123";
  const reformatted = "+1 (555) 555-0123";
  // The code screen writes the number back both ways, as sites do, and Guardian quotes it.
  const shop = await phoneShop({ echo: () => [phone, reformatted] });
  const guardian = recordingGuardian({
    decide: (review) =>
      review.kind === "publication"
        ? { outcome: "allow", rationale: `Allowed. The code screen names ${reformatted}.` }
        : "allow",
  });
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
      guardian,
      intent: "Read the account's heading",
      timeoutMs: 600_000,
      browser: { context: shop.context },
      passwordless: byPhone,
      answer,
      turns: [
        () =>
          patch({
            "src/tool.mjs": searchHeading,
            "explore/body.mjs": readBody,
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
    expect(JSON.stringify(requests)).not.toContain("424242");
    // The exploration read the screen, and the number reached it masked in every form.
    expect(JSON.stringify(requests)).toContain("We sent a code to [private]");
    expect(JSON.stringify(guardian.reviews)).toContain("Code [private]");
    expect(built.publicationReview?.rationale).toBe("Allowed. The code screen names [private].");
    for (const form of [phone, reformatted, "555-0123", "5555550123"]) {
      expect(JSON.stringify(built)).not.toContain(form);
      expect(JSON.stringify(requests)).not.toContain(form);
      expect(JSON.stringify(guardian.reviews)).not.toContain(form);
    }

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

test("a mint masks a number a national field takes without its calling code, in each form the site writes it", async () => {
  test.setTimeout(180_000);
  const shop = await phoneShop({ echo: (typed) => [typed, "98765 43210"] });
  const guardian = recordingGuardian();
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian,
      intent: "Read the account's heading",
      timeoutMs: 600_000,
      browser: { context: shop.context },
      passwordless: byPhone,
      answer: (request) =>
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            question.type === "credential"
              ? { username: "+919876543210", saveLogin: false }
              : "424242",
          ]),
        ),
      turns: [
        () => patch({ "src/tool.mjs": searchHeading, "explore/body.mjs": readBody }),
        phoneStep("national"),
        ...phoneSignInTurns.slice(1, 3),
        () => [said("Stop here.")],
      ],
    });

    expect(shop.received).toEqual({ phones: ["9876543210"], codes: ["424242"] });
    expect(JSON.stringify(requests)).toContain("We sent a code to [private]");
    for (const form of ["9876543210", "98765 43210"]) {
      expect(JSON.stringify(built)).not.toContain(form);
      expect(JSON.stringify(requests)).not.toContain(form);
      expect(JSON.stringify(guardian.reviews)).not.toContain(form);
    }
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

test("a mint on an account with no password types no identifier into a password input, whatever the step calls it", async () => {
  test.setTimeout(120_000);
  const shop = await phoneShop({ passwordField: true });
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian: recordingGuardian(),
      intent: "Read the account's heading",
      browser: { context: shop.context },
      passwordless: byPhone,
      answer: () => ({ login: { username: "+15555550123", saveLogin: false } }),
      turns: [
        () => patch({ "src/tool.mjs": searchHeading }),
        () => [
          call(
            "execute",
            execution("authenticate", "src/tool.mjs", {
              signInStep: {
                fields: [{ selector: "input[name=password]", accepts: ["phone"] }],
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
    expect(shop.received).toEqual({ phones: [], codes: [] });
  } finally {
    await shop.close();
  }
});

test("a mint on an account with no password types a code into a password input, as some sites draw one", async () => {
  test.setTimeout(120_000);
  const shop = await phoneShop({ codeInPassword: true });
  try {
    await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian: recordingGuardian(),
      intent: "Read the account's heading",
      timeoutMs: 120_000,
      browser: { context: shop.context },
      passwordless: byPhone,
      answer: (request) =>
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            question.type === "credential"
              ? { username: "+15555550123", saveLogin: false }
              : "424242",
          ]),
        ),
      turns: [
        () => patch({ "src/tool.mjs": searchHeading, "explore/body.mjs": readBody }),
        ...phoneSignInTurns.filter((_turn, index) => index !== 1).slice(0, 2),
        () => [said("Stop here.")],
      ],
    });

    expect(shop.received).toEqual({ phones: ["+15555550123"], codes: ["424242"] });
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
  ["the same kind twice", { identifierKinds: ["phone", "phone"], password: false }],
  ["a key of its own", { identifierKinds: ["phone"], password: false, code: "424242" }],
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

/** What a host heard through its `seen` hook, put together as a host would. */
const hearing = () => {
  const reports: PagesSeen[] = [];
  return {
    reports,
    hooks: {
      seen: (pages: PagesSeen) =>
        Effect.sync(() => {
          reports.push(pages);
        }),
    },
    answered: () => reports.flatMap((pages) => pages.answered),
    links: () => reports.flatMap((pages) => pages.links),
    texts: () => reports.flatMap((pages) => pages.texts),
  };
};

/**
 * A signed-in account's pages: words the page shows, hides and holds as data, an address that moves,
 * one that fails, requests that pass and fail, a frame, a shadow root and a pop-up.
 */
const accountSite = () =>
  startSite((request, response) => {
    const path = new URL(request.url ?? "/", "http://site.test").pathname;
    if (path === "/old") {
      response.writeHead(302, { Location: "/moved" });
      response.end();
    } else if (path === "/missing") {
      response.statusCode = 404;
      html(response, "<h1>Nothing here</h1>");
    } else if (path === "/api/cart") {
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    } else if (path === "/api/other") {
      response.statusCode = 403;
      response.end("no");
    } else if (path === "/moved")
      html(response, `<h1>Moved here</h1><a id="on" href="/missing">Go on</a>`);
    else if (path === "/popup") html(response, "<h1>Popup words</h1>");
    else if (path === "/frame")
      html(response, `<p>Inside the frame</p><a href="/framed-link">Framed</a>`);
    else if (path === "/elsewhere")
      html(response, `<p>Words of another origin</p><a href="/elsewhere-link">Elsewhere link</a>`);
    else if (path === "/account")
      html(
        response,
        `<title>Your account</title><meta name="description" content="Account overview">
<h1>Hi <b>Asha</b> Rao</h1>
<button><div>Add to</div><div>cart</div></button>
<button aria-label="Close dialog">x</button>
<img alt="Store logo" src="/logo.png">
<input placeholder="Search products">
<input aria-label="Street" value="12 Park Lane">
<input type="hidden" name="saved" value="Saved Address One">
<input type="password" aria-label="Password" value="hunter-two-2" data-kept="hunter-two-3">
<input autocomplete="cc-number" aria-label="Card number" value="4111 1111 1111 1111" data-card="4242 4242 4242 4242" aria-valuetext="5555 5555 5555 4444">
<input autocomplete="one-time-code" aria-label="Code" value="246810">
<textarea autocomplete="cc-csc" aria-label="Security code">Security value 737</textarea>
<textarea>Leave at the door</textarea>
<div hidden>Hidden <span>note</span></div>
<div data-props='{"customer":"Data Attribute Name"}'></div>
<template><p>Template words</p><a href="/template-link">T</a></template>
<script type="application/json">{"greeting":"Inline data words"}</script>
<script>const never = "Script words";</script>
<style>.never::after { content: "Style words"; }</style>
<a href="/orders/o-1">Order one</a>
<a href="https://other.test/away">Elsewhere</a>
<a href="mailto:help@site.test">Mail</a>
<div hidden><a href="/hidden-link">Hidden link</a></div>
<div id="host"></div>
<iframe src="/frame"></iframe>
<iframe src="http://localhost:${new URL(`http://${request.headers.host ?? ""}`).port}/elsewhere"></iframe>
<script>
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<button>Shadow button</button><a href="/shadow-link">S</a>';
fetch("/api/cart");
fetch("/api/other");
</script>`,
      );
    else html(response, "<title>Shop</title><h1>Shop</h1>");
  });

/** Walks the account's pages: its first call passes through two pages, as a build's code may. */
const walkAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "walk_account", input: Schema.Struct({}), output: Schema.Struct({ done: Schema.Boolean }) },
  async ({ kernel, sessionId }) => {
    const call = async (code) => {
      const answered = await kernel.browsers.playwright.execute(sessionId, { code, timeout_sec: 20 });
      if (!answered.success) throw new Error(String(answered.error));
    };
    await call(\`
      const at = (path) => new URL(path, page.url()).href;
      await page.goto(at("/old"));
      await page.locator("#on").click();
      await page.waitForURL("**/missing");
      await page.evaluate(() => history.pushState({}, "", "/after-missing"));
    \`);
    await call(\`
      await page.goto(new URL("/account", page.url()).href);
      await page.waitForLoadState("networkidle");
    \`);
    await call(\`
      await page.evaluate(() => {
        history.pushState({}, "", "/spa/route");
        location.hash = "#/hash/route";
      });
    \`);
    await call(\`
      const [popup] = await Promise.all([
        context.waitForEvent("page"),
        page.evaluate(() => { window.open("/popup"); }),
      ]);
      await popup.waitForLoadState("load");
    \`);
    await call(\`await page.goto(new URL("/orders/o-1", page.url()).href);\`);
    return { done: true };
  },
);`;

test("a run tells the host's seen hook the addresses the site answered, each page's links, its text and its accessible names", async () => {
  test.setTimeout(90_000);
  const site = await accountSite();
  const calls: string[] = [];
  const heard = hearing();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.run(
            artifact(walkAccount),
            { url: site.url, intent: "Walk the account", effect: "read", input: {} },
            heard.hooks,
          );
        }),
      ),
    );

    const at = (path: string) => `${site.origin}${path}`;
    expect(heard.answered()).toEqual(
      expect.arrayContaining(
        [
          "/",
          "/moved",
          "/account",
          "/api/cart",
          "/logo.png",
          "/frame",
          "/spa/route",
          "/spa/route#/hash/route",
          "/popup",
          // A page's link first, then a page the site answered.
          "/orders/o-1",
        ].map(at),
      ),
    );
    const elsewhere = at("/elsewhere").replace("127.0.0.1", "localhost");
    expect(heard.answered()).toContain(elsewhere);
    for (const path of ["/old", "/missing", "/after-missing", "/api/other"])
      expect(heard.answered()).not.toContain(at(path));

    expect(heard.links()).toEqual(
      expect.arrayContaining([
        at("/orders/o-1"),
        "https://other.test/away",
        at("/hidden-link"),
        at("/template-link"),
        at("/shadow-link"),
        at("/framed-link"),
        at("/elsewhere-link").replace("127.0.0.1", "localhost"),
      ]),
    );
    expect(heard.links().join(" ")).not.toContain("mailto:");

    for (const line of [
      "Your account",
      "Account overview",
      "Hi Asha Rao",
      "Add to cart",
      "Close dialog",
      "Store logo",
      "Search products",
      "Street",
      "12 Park Lane",
      "Saved Address One",
      "Leave at the door",
      "Hidden note",
      `{"customer":"Data Attribute Name"}`,
      "Template words",
      `{"greeting":"Inline data words"}`,
      "Shadow button",
      "Inside the frame",
      "Words of another origin",
      "Card number",
      "Code",
      "Security code",
      "Moved here",
      "Nothing here",
      "Popup words",
    ])
      expect(heard.texts()).toContain(line);
    const words = heard.texts().join("\n");
    for (const never of [
      "Script words",
      "Style words",
      "hunter-two",
      "1111",
      "4242",
      "5555",
      "246810",
      "Security value",
    ])
      expect(words).not.toContain(never);
    expect(heard.reports.some((pages) => pages.partial)).toBe(false);
    expect(calls).toEqual([]);
  } finally {
    await site.close();
  }
});

test("a host's seen hook that dies leaves the run as it was, and hears the last pages of a run that fails", async () => {
  test.setTimeout(60_000);
  const site = await accountSite();
  const calls: string[] = [];
  const failing = artifact(`import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "fail_late", input: Schema.Struct({}), output: Schema.Struct({ done: Schema.Boolean }) },
  async ({ kernel, sessionId }) => {
    await kernel.browsers.playwright.execute(sessionId, {
      code: "await page.goto(new URL('/moved', page.url()).href);",
      timeout_sec: 10,
    });
    throw new Error("The tool gave up");
  },
);`);
  const heard = hearing();
  try {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          const dying = yield* pomerado.run(
            artifact(readShop),
            { url: site.url, intent: "Read the shop", effect: "read", input: {} },
            { seen: () => Effect.die(new Error("The hook broke")) },
          );
          const failed = yield* pomerado
            .run(
              failing,
              { url: site.url, intent: "Fail late", effect: "read", input: {} },
              heard.hooks,
            )
            .pipe(Effect.either);
          return { dying, failed };
        }),
      ),
    );

    expect(outcome.dying).toEqual({ heading: "Shop" });
    expect(outcome.failed._tag).toBe("Left");
    expect(heard.texts()).toContain("Moved here");
  } finally {
    await site.close();
  }
});

/** Reads the shop's heading. */
const readShop = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "read_shop", input: Schema.Struct({}), output: Schema.Struct({ heading: Schema.String }) },
  async ({ kernel, sessionId }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      code: "return await page.locator('h1').innerText();",
      timeout_sec: 10,
    });
    if (!read.success) throw new Error(String(read.error));
    return { heading: String(read.result) };
  },
);`;

test("what one run saw stays out of the next run's reports, its output and its artifact", async () => {
  test.setTimeout(60_000);
  const site = await accountSite();
  const calls: string[] = [];
  const first = hearing();
  const second = hearing();
  const walked = artifact(walkAccount);
  const before = JSON.stringify(walked);
  try {
    const outputs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          const request = { url: site.url, intent: "Read", effect: "read", input: {} } as const;
          return [
            yield* pomerado.run(walked, request, first.hooks),
            yield* pomerado.run(artifact(readShop), request, second.hooks),
          ];
        }),
      ),
    );

    expect(first.texts()).toContain("Saved Address One");
    expect(second.texts()).toContain("Shop");
    expect(second.texts()).not.toContain("Saved Address One");
    expect(second.answered()).not.toContain(`${site.origin}/account`);
    expect(JSON.stringify(outputs)).not.toContain("Saved Address One");
    expect(JSON.stringify(walked)).toBe(before);
  } finally {
    await site.close();
  }
});

test("a mint tells the host's seen hook what its steps and live tests saw, and keeps none of it", async () => {
  test.setTimeout(120_000);
  const site = await startSite((request, response) => {
    const path = new URL(request.url ?? "/", "http://site.test").pathname;
    if (path === "/deals") html(response, "<h1>Deals</h1><p>Planted Deal Words</p>");
    else
      html(
        response,
        `<title>Shop</title><h1>Shop</h1><p>Planted Page Words</p><a href="/deals">Deals</a><img src="/logo.png">`,
      );
  });
  const heard = hearing();
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian: recordingGuardian(),
      intent: "Read the page's heading",
      timeoutMs: 600_000,
      hooks: heard.hooks,
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
    expect(heard.answered()).toEqual(
      expect.arrayContaining([site.url, `${site.origin}/logo.png`]),
    );
    expect(heard.links()).toContain(`${site.origin}/deals`);
    expect(heard.texts()).toEqual(expect.arrayContaining(["Shop", "Planted Page Words", "Deals"]));
    expect(heard.reports.some((pages) => pages.partial)).toBe(false);
    expect(JSON.stringify(built)).not.toContain("Planted Page Words");
    expect(JSON.stringify(requests)).not.toContain("Planted Page Words");
  } finally {
    await site.close();
  }
});

test("a mint's seen hook hears a number and a code masked, in each address, link and line", async () => {
  test.setTimeout(180_000);
  const shop = await phoneShop({
    echo: (typed) => [typed, "98765 43210"],
    echoInAddress: true,
  });
  const heard = hearing();
  try {
    await mint({
      effect: "read",
      url: `${shop.origin}/login`,
      guardian: recordingGuardian(),
      intent: "Read the account's heading",
      timeoutMs: 600_000,
      browser: { context: shop.context },
      passwordless: byPhone,
      hooks: heard.hooks,
      answer: (request) =>
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            question.type === "credential"
              ? { username: "+919876543210", saveLogin: false }
              : "424242",
          ]),
        ),
      turns: [
        () => patch({ "src/tool.mjs": searchHeading, "explore/body.mjs": readBody }),
        phoneStep("national"),
        ...phoneSignInTurns.slice(1, 3),
        () => [said("Stop here.")],
      ],
    });

    expect(shop.received).toEqual({ phones: ["9876543210"], codes: ["424242"] });
    expect(heard.texts()).toContain("We sent a code to [private]");
    expect(heard.answered()).toContain(`${shop.origin}/verify?to=[private]`);
    expect(heard.links()).toContain(`${shop.origin}/resend?to=[private]`);
    const reports = JSON.stringify(heard.reports);
    for (const form of ["9876543210", "98765 43210", "424242"])
      expect(reports).not.toContain(form);
  } finally {
    await shop.close();
  }
});

test("a page behind a pop-up holds up one read, and the host hears it once the pop-up closes, with nothing lost", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(
      response,
      `<h1 id="shown">Before the question</h1><button id="ask" onclick="confirm('Sure?'); document.getElementById('shown').textContent = 'After the question';">Ask</button>`,
    ),
  );
  const calls: string[] = [];
  const heard = hearing();
  try {
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pomerado = yield* session(calls);
          return yield* pomerado.run(
            artifact(`import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { name: "ask_page", input: Schema.Struct({}), output: Schema.Struct({ done: Schema.Boolean }) },
  async ({ kernel, sessionId, decideDialog }) => {
    const raised = await kernel.browsers.playwright.execute(sessionId, {
      code: \`
        const shown = new Promise((resolve) => page.once("dialog", (dialog) => {
          globalThis.dialog = dialog;
          resolve({ type: dialog.type(), message: dialog.message(), url: page.url() });
        }));
        void page.click("#ask").catch(() => {});
        return await shown;
      \`,
      timeout_sec: 10,
    });
    if (!raised.success) throw new Error(String(raised.error));
    await decideDialog({ step: "ask", ...raised.result });
    const closed = await kernel.browsers.playwright.execute(sessionId, {
      code: "await globalThis.dialog.dismiss();",
      timeout_sec: 10,
    });
    if (!closed.success) throw new Error(String(closed.error));
    return { done: true };
  },
);`),
            { url: site.url, intent: "Ask the page", effect: "read", input: {} },
            heard.hooks,
          );
        }),
      ),
    );

    expect(output).toEqual({ done: true });
    expect(heard.texts()).toEqual(
      expect.arrayContaining(["Before the question", "After the question"]),
    );
    expect(heard.reports.some((pages) => pages.partial)).toBe(false);
  } finally {
    await site.close();
  }
});

test("a frame's read takes a field's value only between calls, and a form's own fields don't stop it", async ({
  page,
}) => {
  await page.setContent(`<form id="f">
<input name="attributes" value="Named attributes">
<input name="nodeType" value="Named type">
<input name="childNodes" value="Named children">
<input name="tagName" value="Named tag">
<input name="shadowRoot" value="Named shadow">
<input type="hidden" value="Kept hidden value">
<textarea>Typed in a box</textarea>
<a href="https://shop.test/form-link">In the form</a>
<p>Form words</p>
</form>
<img name="body"><img name="documentElement"><img name="baseURI">
<p>Page words</p>`);
  await page.evaluate(() => {
    const field = document.querySelector("input");
    if (field !== null) field.value = "Typed so far";
    Reflect.deleteProperty(URL, "parse");
  });

  const read = (values: boolean) =>
    page.evaluate(readFrameCode(values)) as Promise<{
      readonly lines: readonly string[];
      readonly links: readonly string[];
      readonly cut: boolean;
    }>;
  const between = await read(true);
  expect(between.cut).toBe(false);
  expect(between.lines).toEqual(
    expect.arrayContaining([
      "Form words",
      "Page words",
      "Kept hidden value",
      "Typed so far",
      "Typed in a box",
    ]),
  );
  expect(between.lines).toContain("Named attributes");
  expect(between.links).toEqual(["https://shop.test/form-link"]);

  const loading = await read(false);
  expect(loading.cut).toBe(false);
  expect(loading.lines).toContain("Form words");
  for (const value of ["Typed so far", "Kept hidden value", "Typed in a box"])
    expect(loading.lines.join("\n")).not.toContain(value);
});

test("a frame's read takes no script from a page that isn't drawn yet", async ({ page }) => {
  await page.setContent(`<style>body { display: none; }</style><p>Waiting words</p>
<script>const never = "Script words";</script>`);

  const { lines } = (await page.evaluate(readFrameCode(true))) as {
    readonly lines: readonly string[];
  };
  expect(lines).toContain("Waiting words");
  expect(lines.join("\n")).not.toContain("Script words");
  expect(lines.join("\n")).not.toContain("display");
});
