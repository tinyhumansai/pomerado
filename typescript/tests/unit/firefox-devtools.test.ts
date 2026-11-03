// Failure modes covered: a tab or context whose id changes between sessions, so host code that
// matches tabs by id loses them; a frame session without the refusal the worker reads to cover the
// frame with its tab's session; a command the engine does not answer that succeeds anyway, or one a
// detached session still answers; a form's answer through redirects not typed form_submit, or a
// GET's typed so, or a form's answer retyped when its page moves its own address; a pending
// navigation that a same-document move, a request finished before its document committed, a
// download or a closed tab leaves pending or ends too soon; a stop that waits for an error page a
// stopped load never shows, for a page that holds its thread, or stops a load after its wait; a key
// down whose text goes in as another key, a key up that releases another, or a character off the
// keyboard layout dropped; host code's own sessions bypassing the engine; a Firefox browser that
// upgrades plain http; and a Firefox executor that accepts a DevTools attach, a remote browser or
// Patchright.
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Frame, Page, Request } from "playwright";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { chromiumEngine, firefoxEngine } from "../../src/execution/browser-engine.js";
import {
  firefoxSession,
  frameSessionRefusal,
  navigationPending,
  navigationPendingKey,
  recordNavigations,
} from "../../src/execution/firefox-devtools.js";
import { readyWaitCode } from "../../src/browser/action-waits.js";
import {
  makePlaywrightExecutor,
  type PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";

const answer = "https://shop.example/answer";
const fakePage = () => {
  const events = new EventEmitter();
  let address = answer;
  const main = { url: () => address };
  const keys: string[] = [];
  const evaluated: { fn: unknown; arg: unknown }[] = [];
  let closed = false;
  let evaluate = async (fn: unknown, arg?: unknown): Promise<unknown> => {
    evaluated.push({ fn, arg });
    return undefined;
  };
  const page = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      events.on(event, handler);
      return page;
    },
    mainFrame: () => main,
    frames: () => [main],
    url: () => "https://shop.example/cart",
    isClosed: () => closed,
    evaluate: (fn: unknown, arg?: unknown) => evaluate(fn, arg),
    waitForEvent: (
      event: string,
      { predicate, timeout }: { predicate?: (value: unknown) => boolean; timeout: number },
    ) =>
      new Promise((resolve, reject) => {
        const listener = (value: unknown) => {
          if (predicate !== undefined && !predicate(value)) return;
          clearTimeout(timer);
          events.off(event, listener);
          resolve(value);
        };
        const timer = setTimeout(() => {
          events.off(event, listener);
          reject(new Error("Timeout"));
        }, timeout);
        events.on(event, listener);
      }),
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
  return {
    page: page as unknown as Page,
    events,
    main,
    keys,
    evaluated,
    /** The main frame moves to `url`, and says so. */
    navigate: (url: string) => {
      address = url;
      events.emit("framenavigated", main);
    },
    close: () => {
      closed = true;
      events.emit("close");
    },
    /** The page runs its evaluations with `run` from now on. */
    evaluating: (run: (fn: unknown, arg?: unknown) => Promise<unknown>) => {
      evaluate = run;
    },
  };
};
const context = {} as BrowserContext;
const navigation = (
  frame: unknown,
  method: string,
  from: Request | null = null,
  url = answer,
  errorText?: string,
) =>
  ({
    isNavigationRequest: () => true,
    frame: () => frame,
    method: () => method,
    redirectedFrom: () => from,
    url: () => url,
    failure: () => (errorText === undefined ? null : { errorText }),
  }) as unknown as Request;
const response = (request: Request, status = 200, headers: Record<string, string> = {}) => ({
  request: () => request,
  status: () => status,
  headers: () => headers,
});
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

  it("says a main-frame navigation is pending from its request until its document commits", () => {
    const { page, events, main, navigate } = fakePage();
    recordNavigations(page);
    expect(navigationPending(page)).toBe(false);
    const posted = navigation(main, "POST", null, "https://shop.example/order");
    events.emit("request", posted);
    expect(navigationPending(page)).toBe(true);
    // The page moves its own address while the order is on its way: the old document stays.
    navigate("https://shop.example/cart#processing");
    expect(navigationPending(page)).toBe(true);
    // Firefox may say the request finished before the new document says it committed.
    events.emit("response", response(posted));
    events.emit("requestfinished", posted);
    expect(navigationPending(page)).toBe(true);
    navigate("https://shop.example/order");
    expect(navigationPending(page)).toBe(false);
    events.emit("request", navigation({ url: () => "about:blank" }, "GET"));
    expect(navigationPending(page)).toBe(false);
  });

  it("ends a navigation whose response commits no document, and any on a closed tab", () => {
    const { page, events, main, close } = fakePage();
    recordNavigations(page);
    for (const [status, headers] of [
      [204, {}],
      [200, { "content-disposition": 'attachment; filename="statement.pdf"' }],
    ] as const) {
      const request = navigation(main, "GET");
      events.emit("request", request);
      events.emit("response", response(request, status, headers));
      expect(navigationPending(page)).toBe(true);
      events.emit("requestfinished", request);
      expect(navigationPending(page)).toBe(false);
    }
    // Firefox reports a download before its response.
    events.emit("request", navigation(main, "GET", null, "https://shop.example/statement"));
    events.emit("download", { url: () => "https://shop.example/statement" });
    expect(navigationPending(page)).toBe(false);
    events.emit("request", navigation(main, "GET"));
    close();
    expect(navigationPending(page)).toBe(false);
  });

  it("holds a navigation whose document never says it committed only for a while", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { page, events, main } = fakePage();
      recordNavigations(page);
      const request = navigation(main, "GET");
      events.emit("request", request);
      events.emit("response", response(request));
      expect(navigationPending(page)).toBe(true);
      vi.setSystemTime(Date.now() + 5_000);
      expect(navigationPending(page)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a failed load until its error page commits, and a stopped one not at all", () => {
    const { page, events, main, navigate } = fakePage();
    recordNavigations(page);
    const stopped = navigation(main, "GET", null, answer, "NS_BINDING_ABORTED");
    events.emit("request", stopped);
    events.emit("requestfailed", stopped);
    expect(navigationPending(page)).toBe(false);
    const refused = navigation(main, "POST", null, "https://shop.example/order", "NS_ERROR_NET_RESET");
    events.emit("request", refused);
    events.emit("requestfailed", refused);
    expect(navigationPending(page)).toBe(true);
    navigate("https://shop.example/order");
    expect(navigationPending(page)).toBe(false);
  });

  it("keeps a form's answer typed so when its page moves its own address", async () => {
    const { page, events, main, navigate } = fakePage();
    recordNavigations(page);
    const session = await firefoxSession(context, page);
    events.emit("request", navigation(main, "POST", null, "https://shop.example/order"));
    navigate("https://shop.example/order");
    navigate("https://shop.example/thanks");
    // A redirect Playwright fulfilled starts no request of its own for where it leads.
    const fulfilled = navigation(main, "POST", null, "https://shop.example/pay");
    events.emit("request", fulfilled);
    events.emit("response", response(fulfilled, 303, { location: "/paid" }));
    navigate("https://shop.example/paid");
    expect(await session.send("Page.getNavigationHistory")).toMatchObject({
      currentIndex: 1,
      entries: [
        { url: "https://shop.example/thanks", transitionType: "form_submit" },
        { url: "https://shop.example/paid", transitionType: "form_submit" },
      ],
    });
  });

  it("stops a tab only once a failed load's error page has committed", async () => {
    const { page, events, main, navigate } = fakePage();
    recordNavigations(page);
    const session = await firefoxSession(context, page);
    const next = "https://shop.example/next";
    const refused = navigation(main, "GET", null, next, "NS_ERROR_CONNECTION_REFUSED");
    events.emit("request", refused);
    events.emit("requestfailed", refused);
    let stopped = false;
    const stopping = session.send("Page.stopLoading").then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The old document moving its own address is no error page.
    navigate(`${answer}#leaving`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    navigate(next);
    await stopping;
    expect(stopped).toBe(true);
    // With no failed load before it, or a stopped one, the stop waits for nothing.
    const aborted = navigation(main, "GET", null, answer, "NS_BINDING_ABORTED");
    events.emit("request", aborted);
    events.emit("requestfailed", aborted);
    const at = Date.now();
    await session.send("Page.stopLoading");
    expect(Date.now() - at).toBeLessThan(500);
  });

  it("stops a tab only while the stop is on time, and waits for no page that holds its thread", async () => {
    const { page, evaluated, evaluating } = fakePage();
    const session = await firefoxSession(context, page);
    await session.send("Page.stopLoading");
    const [{ fn, arg }] = evaluated as [{ fn: (deadline: number) => void; arg: number }];
    const stop = vi.fn();
    vi.stubGlobal("window", { stop });
    try {
      fn(arg);
      fn(Date.now() - 1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    evaluating(() => new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      let stopped = false;
      const stopping = session.send("Page.stopLoading").then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the readiness wait of a pending navigation under the key the wait reads", () => {
    const owned = { pages: () => [], on: () => owned } as unknown as BrowserContext;
    firefoxEngine.attach({ contexts: () => [owned] } as unknown as Browser, owned);
    expect(Reflect.get(globalThis, navigationPendingKey)).toBe(navigationPending);
    expect(readyWaitCode).toContain(`globalThis[${JSON.stringify(navigationPendingKey)}]`);
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

  it("launches Firefox with HTTPS-First off, and Chromium as before", () => {
    expect(firefoxEngine.launchOptions).toEqual({
      firefoxUserPrefs: { "dom.security.https_first": false },
    });
    expect(chromiumEngine.launchOptions).toEqual({});
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
