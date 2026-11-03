// The native executor on Firefox, whose engine answers the host's DevTools commands itself: host
// code binds its tab by the id the executor reports, a credential goes in by trusted input into
// the bound field only, typed keys are trusted, clearing a site empties its storage and cookies,
// a file goes into an input in a shadow root by either placement, and history types a form's
// answer as DevTools does.
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
import { startFileSite } from "./file-fixture.js";

const firefox = <A>(run: (executor: PlaywrightExecutor) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makePlaywrightExecutor({ browser: "firefox" });
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
