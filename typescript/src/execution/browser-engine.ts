import type { Browser, BrowserContext, BrowserType, CDPSession, Frame, Page } from "playwright";
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
}

/** Chromium answers DevTools commands itself. */
export const chromiumEngine: BrowserEngine = {
  name: "chromium",
  launcher: (library) => library.chromium,
  session: (context, target) => context.newCDPSession(target),
  browserSession: (browser) => browser.newBrowserCDPSession(),
};

const engines: { readonly [Name in BrowserName]: BrowserEngine } = { chromium: chromiumEngine };

/** The engine that drives the browser `name`. */
export const browserEngine = (name: BrowserName): BrowserEngine => engines[name];
