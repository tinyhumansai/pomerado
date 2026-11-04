// Failure modes covered: a caller's file read past the size it had when opened; a download's type
// lost when its response comes after the download, as in Firefox, or after the file saved; a
// download held back whose response came first, came with no type, or never comes; and a download
// saved in time reported missing while its type was awaited.
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeLocalFileHook, openLocalFile } from "../../src/execution/local-files.js";
import type { BrowserExecute } from "../../src/runtime/browser-execution.js";

/**
 * A browser whose one tab starts a download of `url` when the test says, saving `body`, with the
 * response the context reports for it. The host's page code runs on it as on a worker.
 */
const downloadingBrowser = () => {
  const page = new EventEmitter();
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...source: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const execute: BrowserExecute = (code) =>
    Effect.promise(async () => {
      try {
        const run = new AsyncFunction("page", "context", "browser", "console", code);
        return { success: true, result: await run(page, context, undefined, console) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  return {
    execute,
    download: (url: string, body: string) =>
      page.emit("download", {
        url: () => url,
        suggestedFilename: () => "statement.csv",
        saveAs: (path: string) => writeFile(path, body),
      }),
    respond: (url: string, type?: string) =>
      context.emit("response", {
        url: () => url,
        headers: () => (type === undefined ? {} : { "content-type": type }),
      }),
  };
};

const statement = "https://bank.example/statement.csv";
const take = (
  browser: ReturnType<typeof downloadingBrowser>,
  start: (slot: string) => void,
  timeoutMs = 5_000,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hook = yield* makeLocalFileHook({ execute: browser.execute });
        const slot = yield* hook.armDownloads();
        start(slot);
        return yield* hook.takeDownload(slot, { timeoutMs, maxBytes: 1_000 });
      }),
    ),
  );

it("keeps a download's type when its response comes after the download, and after it saved", async () => {
  const browser = downloadingBrowser();
  const taken = await take(browser, () => {
    browser.download(statement, "date,amount\n");
    setTimeout(() => browser.respond(statement, "text/csv"), 300);
  });
  expect(taken).toMatchObject({ name: "statement.csv", media_type: "text/csv" });
});

it("keeps a download's type when its response comes first, and holds back no download without one", async () => {
  const browser = downloadingBrowser();
  const quick = async (start: (slot: string) => void) => {
    const at = Date.now();
    const taken = await take(browser, start);
    expect(Date.now() - at).toBeLessThan(1_000);
    return taken;
  };
  const first = await quick(() => {
    browser.respond(statement, "text/csv");
    browser.download(statement, "date,amount\n");
  });
  expect(first).toMatchObject({ media_type: "text/csv" });
  // A response with no type, and a download the page made itself, which comes in no response.
  const untyped = await quick(() => {
    browser.respond("https://bank.example/plain", undefined);
    browser.download("https://bank.example/plain", "x");
  });
  expect(untyped).not.toHaveProperty("media_type");
  const made = await quick(() => browser.download("blob:https://bank.example/1", "x"));
  expect(made).not.toHaveProperty("media_type");
});

it("reports a download saved in time even when its type hasn't come by the wait's end", async () => {
  const browser = downloadingBrowser();
  const taken = await take(browser, () => browser.download(statement, "date,amount\n"), 500);
  expect(taken).toMatchObject({ name: "statement.csv" });
  expect(taken).not.toHaveProperty("media_type");
});

it("reads a caller's file only at the size it had when opened, refusing one that grew since", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-local-files-qa-"));
  try {
    const path = join(directory, "receipt.txt");
    await writeFile(path, "Receipt 1042\n");
    const same = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    expect(new TextDecoder().decode(await Effect.runPromise(same.read))).toBe("Receipt 1042\n");
    const grown = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    await appendFile(path, "x".repeat(1 << 20));
    await expect(Effect.runPromise(grown.read)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
