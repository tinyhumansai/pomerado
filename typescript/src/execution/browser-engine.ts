import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  BrowserType,
  CDPSession,
  Frame,
  LaunchOptions,
  Page,
} from "playwright";
import {
  firefoxBrowserSession,
  firefoxSession,
  navigationPending,
  navigationPendingKey,
  recordNavigations,
} from "./firefox-devtools.js";
import type { BrowserName } from "./playwright-protocol.js";

/**
 * What the native executor and its worker need from a browser beyond the Playwright calls every
 * browser answers: its launcher in a Playwright build, and the DevTools sessions the host sends its
 * own commands on, to name tabs and contexts and to type credentials.
 */
export interface BrowserEngine {
  readonly name: BrowserName;
  /** This browser's launcher in a Playwright build, `playwright` or `patchright`. */
  readonly launcher: (library: typeof import("playwright")) => BrowserType;
  /** A DevTools session on a tab, or on a frame that runs in its own process. */
  readonly session: (context: BrowserContext, target: Page | Frame) => Promise<CDPSession>;
  /** A DevTools session on the whole browser. */
  readonly browserSession: (browser: Browser) => Promise<CDPSession>;
  /** The options the executor launches this browser with, beside its own. */
  readonly launchOptions: Pick<LaunchOptions, "firefoxUserPrefs">;
  /** The options the worker opens its own context with. */
  readonly contextOptions: BrowserContextOptions;
  /**
   * Readies the worker's browser and context before its first page opens, so the sessions host
   * code opens itself, with `context.newCDPSession` or `browser.newBrowserCDPSession`, go through
   * this engine.
   */
  readonly attach: (browser: Browser, context: BrowserContext) => void;
  /**
   * Whether one connection lists the contexts another made, so the executor can confirm the
   * worker's context closed once the worker's connection dropped.
   */
  readonly listsContexts: boolean;
  /**
   * Whether page code may type key by key with synthetic key events. Where it may not, typing
   * key by key presses trusted keys instead, which every engine's sessions send.
   */
  readonly syntheticKeys: boolean;
}

/** Chromium answers DevTools commands itself. */
export const chromiumEngine: BrowserEngine = {
  name: "chromium",
  launcher: (library) => library.chromium,
  session: (context, target) => context.newCDPSession(target),
  browserSession: (browser) => browser.newBrowserCDPSession(),
  launchOptions: {},
  contextOptions: {},
  attach: () => undefined,
  listsContexts: true,
  syntheticKeys: true,
};

const attached = new WeakSet<BrowserContext>();

/**
 * The preferences a Firefox executor's browser runs with. HTTPS-First is off, so a page loads
 * over the scheme it was asked for, as on Playwright's Chromium, and the host's routes for a
 * plain-http page see its load. Service workers stay on: Firefox routes no request with them off.
 */
export const firefoxPrefs = { "dom.security.https_first": false } as const;

/**
 * Firefox answers no DevTools commands, so the engine answers those the host sends with Playwright
 * calls (`firefox-devtools`). Its contexts block service workers, which Chromium's sessions bypass
 * only while the host clears or restores a site. Playwright blocks them with a script, which
 * Camoufox runs apart from the page's own, so there a site's worker still runs: a clear
 * unregisters the origin's workers, but one may answer the clear's own load first.
 */
export const firefoxEngine: BrowserEngine = {
  name: "firefox",
  launcher: (library) => library.firefox,
  session: firefoxSession,
  browserSession: firefoxBrowserSession,
  launchOptions: { firefoxUserPrefs: firefoxPrefs },
  contextOptions: { serviceWorkers: "block" },
  attach: (browser, context) => {
    if (attached.has(context)) return;
    attached.add(context);
    context.newCDPSession = (target) => firefoxSession(context, target);
    browser.newBrowserCDPSession = () => firefoxBrowserSession(browser);
    for (const page of context.pages()) recordNavigations(page);
    context.on("page", recordNavigations);
    Reflect.set(globalThis, navigationPendingKey, navigationPending);
  },
  listsContexts: false,
  // Camoufox's isolated world crashes the tab on a synthetic keypress that page code dispatches.
  syntheticKeys: false,
};

const engines: { readonly [Name in BrowserName]: BrowserEngine } = {
  chromium: chromiumEngine,
  firefox: firefoxEngine,
};

/** The engine that drives the browser `name`. */
export const browserEngine = (name: BrowserName): BrowserEngine => engines[name];
