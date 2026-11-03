// Failure modes covered: a tab or context whose id changes between sessions, so host code that
// matches tabs by id loses them; a frame session without the refusal the worker reads to cover the
// frame with its tab's session; a command the engine does not answer that succeeds anyway, or one a
// detached session still answers; a form's answer through redirects not typed form_submit, or a
// GET's typed so; a key down whose text goes in as another key, a key up that releases another, or
// a character off the keyboard layout dropped; host code's own sessions bypassing the engine; and a
// Firefox executor that accepts a DevTools attach, a remote browser or Patchright.
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Frame, Page, Request } from "playwright";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { firefoxEngine } from "../../src/execution/browser-engine.js";
import {
  firefoxSession,
  frameSessionRefusal,
  recordNavigations,
} from "../../src/execution/firefox-devtools.js";
import {
  makePlaywrightExecutor,
  type PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";

const fakePage = () => {
  const events = new EventEmitter();
  const main = { url: () => "https://shop.example/answer" };
  const keys: string[] = [];
  const page = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      events.on(event, handler);
      return page;
    },
    mainFrame: () => main,
    frames: () => [main],
    url: () => "https://shop.example/cart",
    keyboard: {
      down: async (key: string) => {
        if (key === "₹") throw new Error('Unknown key: "₹"');
        keys.push(`down ${key}`);
      },
      up: async (key: string) => {
        keys.push(`up ${key}`);
      },
      insertText: async (text: string) => {
        keys.push(`text ${text}`);
      },
    },
  };
  return { page: page as unknown as Page, events, main, keys };
};
const context = {} as BrowserContext;
const navigation = (frame: unknown, method: string, from: Request | null = null) =>
  ({
    isNavigationRequest: () => true,
    frame: () => frame,
    method: () => method,
    redirectedFrom: () => from,
  }) as unknown as Request;
const key = (type: "keyDown" | "keyUp", name: string, text?: string) => ({
  type,
  key: name,
  code: "",
  windowsVirtualKeyCode: 0,
  nativeVirtualKeyCode: 0,
  ...(text === undefined ? {} : { text }),
});

describe("the Firefox engine's DevTools stand-in", () => {
  it("names a tab and its context the same in every session, and other tabs apart", async () => {
    const { page } = fakePage();
    const first = await (await firefoxSession(context, page)).send("Target.getTargetInfo");
    const again = await (await firefoxSession(context, page)).send("Target.getTargetInfo");
    const other = await (await firefoxSession(context, fakePage().page)).send(
      "Target.getTargetInfo",
    );
    expect(again.targetInfo.targetId).toBe(first.targetInfo.targetId);
    expect(again.targetInfo.browserContextId).toBe(first.targetInfo.browserContextId);
    expect(other.targetInfo.targetId).not.toBe(first.targetInfo.targetId);
    expect(other.targetInfo.browserContextId).toBe(first.targetInfo.browserContextId);
  });

  it("refuses a frame its own session, as the worker expects of a same-process frame", async () => {
    const child = { parentFrame: () => ({}) } as unknown as Frame;
    await expect(firefoxSession(context, child)).rejects.toThrow(frameSessionRefusal);
    expect(frameSessionRefusal).toContain("does not have a separate CDP session");
  });

  it("opens a tab's own session on its main frame, as Chromium does", async () => {
    const { page } = fakePage();
    const main = { parentFrame: () => null, page: () => page } as unknown as Frame;
    const onFrame = await (await firefoxSession(context, main)).send("Target.getTargetInfo");
    const onTab = await (await firefoxSession(context, page)).send("Target.getTargetInfo");
    expect(onFrame.targetInfo.targetId).toBe(onTab.targetInfo.targetId);
  });

  it("refuses a command it does not answer, and every command once detached", async () => {
    const session = await firefoxSession(context, fakePage().page);
    await expect(session.send("Page.reload")).rejects.toThrow(
      "Firefox engine does not answer Page.reload",
    );
    await session.detach();
    await expect(session.send("Target.getTargetInfo")).rejects.toThrow("has been closed");
  });

  it("types a form's answer form_submit through its redirects, and a GET's other", async () => {
    const { page, events, main } = fakePage();
    recordNavigations(page);
    const session = await firefoxSession(context, page);
    events.emit("request", navigation(main, "GET", navigation(main, "POST")));
    events.emit("framenavigated", main);
    events.emit("request", navigation({ name: "child" }, "POST"));
    events.emit("request", navigation(main, "GET"));
    events.emit("framenavigated", main);
    expect(await session.send("Page.getNavigationHistory")).toMatchObject({
      currentIndex: 1,
      entries: [{ transitionType: "form_submit" }, { transitionType: "other" }],
    });
  });

  it("presses a key with its text, releases it, and types a character off the layout", async () => {
    const { page, keys } = fakePage();
    const session = await firefoxSession(context, page);
    await session.send("Input.dispatchKeyEvent", key("keyDown", "a", "a"));
    await session.send("Input.dispatchKeyEvent", key("keyUp", "a"));
    await session.send("Input.dispatchKeyEvent", key("keyDown", "Enter"));
    await session.send("Input.dispatchKeyEvent", key("keyUp", "Enter"));
    await session.send("Input.dispatchKeyEvent", key("keyDown", "₹", "₹"));
    await session.send("Input.dispatchKeyEvent", key("keyUp", "₹"));
    expect(keys).toEqual(["down a", "up a", "down Enter", "up Enter", "text ₹"]);
  });

  it("answers a service worker bypass, since its contexts block service workers", async () => {
    const session = await firefoxSession(context, fakePage().page);
    await expect(session.send("Network.setBypassServiceWorker", { bypass: true })).resolves.toEqual(
      {},
    );
    expect(firefoxEngine.contextOptions).toMatchObject({ serviceWorkers: "block" });
  });

  it("sends host code's own sessions on its context and browser through the engine", async () => {
    const contextEvents = new EventEmitter();
    const owned = {
      pages: () => [],
      on: (event: string, handler: (page: Page) => void) => contextEvents.on(event, handler),
    } as unknown as BrowserContext;
    const browser = { contexts: () => [owned] } as unknown as Browser;
    firefoxEngine.attach(browser, owned);
    const { page, events, main } = fakePage();
    contextEvents.emit("page", page);
    events.emit("request", navigation(main, "POST"));
    events.emit("framenavigated", main);
    const history = await (await owned.newCDPSession(page)).send("Page.getNavigationHistory");
    expect(history.entries.at(-1)).toMatchObject({ transitionType: "form_submit" });
    const listed = await (await browser.newBrowserCDPSession()).send("Target.getBrowserContexts");
    expect(listed.browserContextIds).toHaveLength(1);
  });
});

describe("an executor's browser build", () => {
  it.each([
    [{ executablePath: "" }, "executablePath must name a browser build"],
    [
      { executablePath: "/opt/camoufox", endpoint: "ws://127.0.0.1:9/browser" },
      "executablePath applies only to a browser the executor launches",
    ],
    [
      { executablePath: "/opt/camoufox", cdp: { url: "http://127.0.0.1:9222" } },
      "executablePath applies only to a browser the executor launches",
    ],
  ] as const)("refuses %o before it starts", async (options, message) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makePlaywrightExecutor(options as PlaywrightOptions)),
    );
    if (Exit.isSuccess(exit)) throw new Error("The executor started");
    expect(Cause.squash(exit.cause)).toMatchObject({ message });
  });
});

describe("a Firefox executor", () => {
  it.each([
    [{ cdp: { url: "http://127.0.0.1:9222" } }, "cdp attaches only to chromium"],
    [
      { endpoint: "ws://127.0.0.1:9/browser" },
      "firefox runs only on a browser the executor launches",
    ],
    [{ library: "patchright" }, "patchright drives only chromium"],
  ] as const)("refuses %o before it starts", async (options, message) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makePlaywrightExecutor({ browser: "firefox", ...options } as PlaywrightOptions),
      ),
    );
    if (Exit.isSuccess(exit)) throw new Error("The executor started");
    expect(Cause.squash(exit.cause)).toMatchObject({ message });
  });
});
