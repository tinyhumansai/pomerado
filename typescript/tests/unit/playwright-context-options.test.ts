// Failure modes covered: a host's context option that would change the executor's own behaviour,
// or a permission for an address that is no page's origin, reaching the browser; context options
// over CDP, which would change a context the executor doesn't own; and a Firefox executor that
// refuses a host's own browser server.
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  makePlaywrightExecutor,
  type PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";

const contextRefusal =
  "context takes only proxy, locale, timezoneId, geolocation, viewport, userAgent, extraHTTPHeaders, ignoreHTTPSErrors, storageState and permissions for http or https origins";

/** Why the executor stopped before it started a browser, from `options`. */
const refusal = async (options: PlaywrightOptions) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(makePlaywrightExecutor(options)));
  if (Exit.isSuccess(exit)) throw new Error("The executor started");
  return (Cause.squash(exit.cause) as Error).message;
};

describe("a host's context options", () => {
  it.each([
    [{ context: { acceptDownloads: false } }, contextRefusal],
    [{ context: { baseURL: "https://shop.example" } }, contextRefusal],
    [
      {
        context: {
          permissions: [{ origin: "https://shop.example/account", permissions: ["geolocation"] }],
        },
      },
      contextRefusal,
    ],
    [
      { context: { permissions: [{ origin: "file:///tmp", permissions: ["geolocation"] }] } },
      contextRefusal,
    ],
    [
      { context: { locale: "en-IN" }, cdp: { url: "http://127.0.0.1:9/" } },
      "context applies only to a context the executor opens, not over cdp",
    ],
  ] as const)("refuses %o before it starts a browser", async (options, message) => {
    expect(await refusal(options as PlaywrightOptions)).toBe(message);
  });
});

describe("a Firefox executor on a host's own browser server", () => {
  it("connects to it rather than refusing it", async () => {
    // Nothing listens there, so the connection fails: what matters is that it was tried.
    const message = await refusal({
      browser: "firefox",
      endpoint: "ws://127.0.0.1:9/browser",
      startupTimeoutMs: 2_000,
    });
    expect(message).not.toBe("firefox runs only on a browser the executor launches");
    expect(message).toMatch(/connect|ECONNREFUSED|WebSocket|Timeout/iu);
  });

  it("still launches only its own build when it names one", async () => {
    expect(
      await refusal({
        browser: "firefox",
        endpoint: "ws://127.0.0.1:9/browser",
        executablePath: "/opt/camoufox",
      }),
    ).toBe("executablePath applies only to a browser the executor launches");
  });
});
