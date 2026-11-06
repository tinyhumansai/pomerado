// The native executor on Firefox, whose engine answers the host's DevTools commands itself: host
// code binds its tab by the id the executor reports, a credential goes in by trusted input into
// the bound field only, typed keys are trusted, clearing a site empties its storage and cookies,
// clearing an origin empties its own and leaves another's and unregisters its service workers, a
// page loads plain http as asked, typing again key by key sends no keypress, a readiness wait
// holds while a submit is on its way, a file goes into an input in a shadow root by either
// placement, and history types a form's answer as DevTools does.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep } from "../../src/destinations/autofill-step.js";
import {
  makePlaywrightExecutor,
  type PlaywrightExecutor,
} from "../../src/execution/playwright-execute.js";
import { makeRunFiles, type FileHostHook } from "../../src/runtime/file-transfer.js";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { resetPageCode } from "../../src/runtime/start-state.js";
import { waitCode } from "../../src/browser/wait.js";
import { startFileSite } from "./file-fixture.js";
import { expectPhoneSwapThroughWorker } from "./phone-swap-fixture.js";

const firefox = <A>(run: (executor: PlaywrightExecutor) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // The camoufox project names a Firefox build in place of Playwright's own.
        const executablePath = test.info().project.metadata["executablePath"] as string | undefined;
        const executor = yield* makePlaywrightExecutor({
          browser: "firefox",
          ...(executablePath === undefined ? {} : { executablePath }),
        });
        return yield* Effect.tryPromise({
          try: () => run(executor),
          catch: (error) =>
            error instanceof Error ? error : new Error("Firefox fixture failed", { cause: error }),
        });
      }),
    ),
  );

const site = "https://login.example.test";
const loginPage = (executor: PlaywrightExecutor) =>
  Effect.runPromise(
    executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<title>Sign in</title><label>Password<input id="password" type="password"></label><input id="other">'}));
      await page.goto('${site}');
      await page.evaluate(() => {
        window.trustedInput = [];
        window.trustedKeys = [];
        document.addEventListener('input', event => window.trustedInput.push(event.isTrusted));
        document.addEventListener('keydown', event => window.trustedKeys.push(event.isTrusted));
      });
    `),
  );
const step = { fields: [{ selector: "#password", slot: "password" as const }] };

test("host code on Firefox binds its tab by the id the executor reports", async () => {
  await firefox(async (executor) => {
    await loginPage(executor);
    const bound = await Effect.runPromise(
      executor.execute(
        `${primaryPageCode(executor.targetId)}\nreturn [await primary.title(), browser.browserType().name()];`,
      ),
    );
    expect(bound).toEqual(["Sign in", "firefox"]);
  });
});

test("Firefox autofill inserts by trusted input and refuses a stale field binding", async () => {
  await firefox(async (executor) => {
    await loginPage(executor);
    const host = { targetId: executor.targetId, execute: executor.execute };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["synthetic-native-secret"],
        inspection,
        page: host,
        keyboard: executor.keyboard,
        settleMs: 0,
      }),
    );
    expect(report.outcome).toBe("filled");
    const verification = await Effect.runPromise(
      executor.executeResponse(
        `return await page.evaluate(() => ({filled: document.querySelector('#password').value === 'synthetic-native-secret', trusted: window.trustedInput}));`,
      ),
    );
    expect(verification.result).toEqual({ filled: true, trusted: [true] });
    expect(JSON.stringify(verification)).not.toContain("synthetic-native-secret");
    await Effect.runPromise(executor.execute("await page.locator('#password').fill('');"));
    const stale = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["never-inserted"],
        inspection,
        page: host,
        settleMs: 0,
        keyboard: {
          insertText: (target, text) =>
            executor
              .execute("await page.locator('#other').focus();")
              .pipe(Effect.zipRight(executor.keyboard.insertText(target, text))),
        },
      }),
    );
    expect(stale.outcome).toBe("refused");
    expect(
      await Effect.runPromise(
        executor.execute("return await page.locator('#other').inputValue();"),
      ),
    ).toBe("");
  });
});

test("Firefox autofill reads back a phone box that took the bound field's place, through the worker", async () => {
  await firefox(expectPhoneSwapThroughWorker);
});

test("Firefox autofill types a credential by trusted keys, one per character", async () => {
  await firefox(async (executor) => {
    await loginPage(executor);
    const host = { targetId: executor.targetId, execute: executor.execute };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["4821"],
        inspection,
        page: host,
        keyboard: executor.keyboard,
        settleMs: 0,
        typing: "keyboard",
      }),
    );
    expect(report.outcome).toBe("filled");
    expect(
      await Effect.runPromise(
        executor.execute(
          `return await page.evaluate(() => ({value: document.querySelector('#password').value, keys: window.trustedKeys}));`,
        ),
      ),
    ).toEqual({ value: "4821", keys: [true, true, true, true] });
  });
});

test("clearing a site on Firefox empties its storage and cookies", async () => {
  await firefox(async (executor) => {
    const shop = "https://shop.example.test";
    await Effect.runPromise(
      executor.execute(`
        await context.route('${shop}/**', route => route.fulfill({contentType:'text/html', body:'<title>Shop</title>'}));
        await page.goto('${shop}/');
        await page.evaluate(() => { localStorage.setItem('cart', 'kept'); sessionStorage.setItem('step', 'kept'); });
        await context.addCookies([{ name: 'session', value: 'kept', url: '${shop}' }]);
      `),
    );
    await Effect.runPromise(
      executor.execute(resetPageCode(executor.targetId, shop, "clear", undefined), 60),
    );
    const left = await Effect.runPromise(
      executor.execute(`
        await page.goto('${shop}/');
        return {
          local: await page.evaluate(() => localStorage.getItem('cart')),
          session: await page.evaluate(() => sessionStorage.getItem('step')),
          cookies: (await context.cookies('${shop}')).length,
        };
      `),
    );
    expect(left).toEqual({ local: null, session: null, cookies: 0 });
  });
});

test("clearing an origin on Firefox empties its storage and cookies, and keeps another origin's", async () => {
  await firefox(async (executor) => {
    const shop = "https://shop.example.test";
    const other = "https://other.example.test";
    const left = await Effect.runPromise(
      executor.execute(
        `
        const site = route => route.fulfill({contentType:'text/html', body:'<title>Site</title>'});
        await context.route('${shop}/**', site);
        await context.route('${other}/**', site);
        const seed = async origin => {
          await page.goto(origin + '/');
          await page.evaluate(async () => {
            localStorage.setItem('cart', 'kept');
            await new Promise((resolve, reject) => {
              const open = indexedDB.open('orders', 1);
              open.onupgradeneeded = () => open.result.createObjectStore('orders');
              open.onsuccess = () => { open.result.close(); resolve(undefined); };
              open.onerror = () => reject(open.error);
            });
            await (await caches.open('pages')).put('/cached', new Response('kept'));
          });
          await context.addCookies([{ name: 'session', value: 'kept', url: origin }]);
        };
        const read = async origin => {
          await page.goto(origin + '/');
          return {
            local: await page.evaluate(() => localStorage.getItem('cart')),
            databases: await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name)),
            cached: await page.evaluate(() => caches.has('pages')),
            cookies: (await context.cookies(origin)).length,
          };
        };
        await seed('${shop}');
        await seed('${other}');
        const session = await context.newCDPSession(page);
        try {
          await session.send('Storage.clearDataForOrigin', { origin: '${shop}', storageTypes: 'all' });
        } finally {
          await session.detach();
        }
        return { shop: await read('${shop}'), other: await read('${other}') };
      `,
        60,
      ),
    );
    expect(left).toEqual({
      shop: { local: null, databases: [], cached: false, cookies: 0 },
      other: { local: "kept", databases: ["orders"], cached: true, cookies: 1 },
    });
  });
});

test("a Firefox page loads plain http as asked", async () => {
  test.skip(
    test.info().project.name !== "camoufox",
    "Playwright's own Firefox ships with HTTPS-First off; Camoufox ships with it on",
  );
  await firefox(async (executor) => {
    const plain = "http://plain.example.test";
    const url = await Effect.runPromise(
      executor.execute(`
        await context.route('${plain}/**', route => route.fulfill({contentType:'text/html', body:'<title>Plain</title>'}));
        await page.goto('${plain}/');
        return page.url();
      `),
    );
    expect(url).toBe(`${plain}/`);
  });
});

test("clearing an origin on Firefox unregisters its service workers", async () => {
  // Playwright blocks a Firefox context's service workers with a script, which Camoufox runs apart
  // from the page's own, so only there does the site's worker register for a clear to remove.
  test.skip(
    test.info().project.name !== "camoufox",
    "Playwright's own Firefox blocks the site's worker, so there is none to clear",
  );
  const server = createServer((request, response) => {
    if (request.url === "/worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      "<title>Site</title><script>navigator.serviceWorker.register('/worker.js').then(() => navigator.serviceWorker.ready).then(() => { document.documentElement.dataset.worker = 'ready'; });</script>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await firefox(async (executor) => {
      const seen = await Effect.runPromise(
        executor.execute(
          `
          await page.goto('${origin}/');
          await page.locator('html[data-worker=ready]').waitFor({ state: 'attached' });
          const workers = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
          const before = await workers();
          const session = await context.newCDPSession(page);
          try {
            await session.send('Storage.clearDataForOrigin', { origin: '${origin}', storageTypes: 'all' });
          } finally {
            await session.detach();
          }
          return { before, after: await workers() };
        `,
          30,
        ),
      );
      expect(seen).toEqual({ before: 1, after: 0 });
    });
  } finally {
    server.close();
  }
});

test("Firefox autofill types again key by key, with no keypress, when the page's submit waits for a key", async () => {
  test.setTimeout(60_000);
  await firefox(async (executor) => {
    // The submit enables only on a key down, so the paste leaves it disabled and the fill types
    // again key by key. Camoufox crashes the tab on a synthetic keypress, so none is sent: the
    // form posts whether one came.
    await Effect.runPromise(
      executor.execute(`
        await context.route('${site}/**', route => {
          if (route.request().method() === 'POST') {
            context.posted = route.request().postData();
            return route.fulfill({contentType:'text/html', body:'<p>Signed in</p>'});
          }
          return route.fulfill({contentType:'text/html', body:\`<form action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label><input type="hidden" name="keypress" value="none"><button id="continue" disabled>Sign in</button></form><script>const field = document.getElementById('password'); field.addEventListener('keydown', () => { document.getElementById('continue').disabled = false; }); field.addEventListener('keypress', () => { document.forms[0].keypress.value = 'pressed'; });</script>\`});
        });
        await page.goto('${site}');
      `),
    );
    const submitted = { ...step, submit: "#continue" };
    const host = { targetId: executor.targetId, execute: executor.execute };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step: submitted, page: host, siteOrigin: site, authenticationOrigins: [] }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step: submitted,
        values: ["4821"],
        inspection,
        page: host,
        keyboard: executor.keyboard,
        settleMs: 0,
      }),
    );
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(await Effect.runPromise(executor.execute("return context.posted ?? null;"))).toBe(
      "password=4821&keypress=none",
    );
  });
});

test("a Firefox readiness wait reads a page whose submit is still on its way as absent", async () => {
  await firefox(async (executor) => {
    // Firefox reads the old page while a POST's answer is on its way, where Chromium holds the
    // read, so the wait would find the old Save ready. The form posts to its own address, and the
    // page moves its own address meanwhile, which Playwright reports as navigations too.
    const answer = await Effect.runPromise(
      executor.execute(
        `
        await context.route('${site}/**', async route => {
          if (route.request().method() !== 'POST')
            return route.fulfill({contentType:'text/html', body:\`<form method="post"><input name="title" value="x"><button id="save">Save</button></form><script>document.forms[0].addEventListener('submit', () => setTimeout(() => { location.hash = 'saving'; history.replaceState(null, '', location.pathname + '#saving'); }, 100));</script>\`});
          await new Promise(resolve => setTimeout(resolve, 6000));
          await route.fulfill({contentType:'text/html', body:'<p>Saved</p>'}).catch(() => undefined);
        });
        await page.goto('${site}/');
        ${waitCode}
        await page.locator('#save').click({ noWaitAfter: true });
        try {
          await waitForReady(page.locator('#save'), { deadline: Date.now() + 1000, noProgressMs: 8000, timeout: 4000 });
          return { ready: true };
        } catch (error) {
          return { reason: error.reason };
        }
      `,
        30,
      ),
    );
    expect(answer).toEqual({ reason: "ready_timeout" });
  });
});

for (const placeByBrowserPath of [true, false]) {
  const how = placeByBrowserPath
    ? "by its path on the browser's machine"
    : "as Playwright sends it";
  test(`a Firefox run places a file into an input in a shadow root ${how}`, async () => {
    const site = await startFileSite();
    const directory = await mkdtemp(join(tmpdir(), "pomerado-firefox-files-"));
    const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic scan\n");
    const hook: FileHostHook = {
      open: () =>
        Effect.succeed({
          name: "scan.pdf",
          media_type: "application/pdf",
          size: bytes.byteLength,
          read: Effect.succeed(bytes),
        }),
      writeToBrowser: (file) =>
        Effect.promise(async () => {
          const path = join(await mkdtemp(join(directory, "placed-")), file.name);
          await writeFile(path, file.bytes);
          return path;
        }),
      placeByBrowserPath,
      armDownloads: () => Effect.die("No capture here"),
      takeDownload: () => Effect.die("No capture here"),
      keep: () => Effect.die("No capture here"),
    };
    try {
      const { placed, attributes } = await firefox(async (executor) => {
        const drop = JSON.stringify(`${site.url}shadow-drop`);
        await Effect.runPromise(executor.execute(`await page.goto(${drop});`));
        const placed = await Effect.runPromise(
          makeRunFiles({
            hook,
            execute: executor.executeResponse,
            siteOrigin: new URL(site.url).origin,
            resolve: (reference) => reference,
            limits: { fileBytes: 1024 * 1024, runFiles: 1, runBytes: 1024 * 1024 },
          }).pipe(
            Effect.flatMap((files) =>
              files.place({
                reference: "scan",
                field: { selector: "input[type=file]" },
                timeoutSec: 20,
              }),
            ),
          ),
        );
        const attributes = await Effect.runPromise(
          executor.execute(
            "return await page.locator('input[type=file]').evaluate((node) => node.getAttributeNames());",
          ),
        );
        return { placed, attributes };
      });
      expect(placed).toEqual({
        name: "scan.pdf",
        media_type: "application/pdf",
        size: bytes.byteLength,
      });
      // The page's own change handler sent what the browser read.
      await expect
        .poll(() => site.received, { timeout: 20_000 })
        .toEqual([
          {
            name: "scan.pdf",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ]);
      // The marker the placement used to find the input is gone.
      expect(attributes).toEqual(["type"]);
    } finally {
      await site.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Firefox history types a form's answer form_submit through its redirect", async () => {
  // A real server, since Firefox doesn't route the request a fulfilled redirect starts.
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      response.writeHead(303, { location: "/done" }).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        '<form method="post" action="/order"><button>Order</button></form><a href="/next">Next</a>',
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const shop = `http://127.0.0.1:${address.port}`;
  try {
    await firefox(async (executor) => {
      const types = await Effect.runPromise(
        executor.execute(`
          await page.goto('${shop}/');
          const read = async () => {
            const session = await context.newCDPSession(page);
            try {
              const { entries, currentIndex } = await session.send('Page.getNavigationHistory');
              return entries[currentIndex].transitionType;
            } finally {
              await session.detach();
            }
          };
          const opened = await read();
          await Promise.all([page.waitForURL('${shop}/done'), page.click('button')]);
          const answered = await read();
          await Promise.all([page.waitForURL('${shop}/next'), page.click('a')]);
          return [opened, answered, await read()];
        `),
      );
      expect(types).toEqual(["other", "form_submit", "other"]);
    });
  } finally {
    server.close();
  }
});
