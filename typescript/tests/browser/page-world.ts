import type { Page } from "playwright";

/**
 * A global of the page's own script, as JSON allows. Camoufox evaluates in an isolated world that
 * can't see the page's globals, so an inline script, which runs in the page's own world, copies it
 * onto the document for the read.
 */
export const pageGlobal = (page: Page, name: string): Promise<unknown> =>
  page.evaluate((global) => {
    const root = document.documentElement;
    const script = document.createElement("script");
    const read = `JSON.stringify(window[${JSON.stringify(global)}] ?? null)`;
    script.textContent = `document.documentElement.dataset.fixtureGlobal = ${read};`;
    root.append(script);
    script.remove();
    const value = root.dataset.fixtureGlobal;
    delete root.dataset.fixtureGlobal;
    return value === undefined ? undefined : (JSON.parse(value) as unknown);
  }, name);

/**
 * Runs `fn` in the page's own world, where the page's own scripts run, through an inline script.
 * Camoufox evaluates in an isolated world that holds the host's own state, which no page script
 * can reach, so a test that plays a hostile page runs its code here.
 */
export const inPageWorld = (page: Page, fn: () => void): Promise<void> =>
  page.evaluate((source) => {
    const script = document.createElement("script");
    script.textContent = `(${source})();`;
    document.documentElement.append(script);
    script.remove();
  }, fn.toString());
