// Failure modes covered: a host's context option that would change the executor's own behaviour,
// an unknown key inside an option, or a permission for an address that is no page's origin,
// reaching the browser; a proxy login written into the server's address, which Playwright drops so
// every page fails 407, a login for a socks proxy, which Playwright can't sign in to, and a
// location or a viewport no browser can take, reaching the browser or refused without naming the
// rule they broke; a proxy server with no scheme, which Playwright reads as an http proxy,
// refused; context options over CDP, which would change a context the executor doesn't
// own; a Firefox executor that refuses a host's own browser server; and a host without
// exactOptionalPropertyTypes, whose unset options are undefined, refused, or reaching Playwright as
// undefined.
import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  makePlaywrightExecutor,
  type PlaywrightContextOptions,
  type PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";
import { ContextOptions } from "../../src/execution/playwright-protocol.js";

const contextRefusal =
  "context takes only proxy, locale, timezoneId, geolocation, viewport, userAgent, extraHTTPHeaders, ignoreHTTPSErrors, storageState and permissions for http or https origins";
const proxyServerRefusal =
  "context.proxy.server takes an http, https, socks4 or socks5 URL of a host, or the host " +
  "alone for http, with no login in it: the login goes in proxy.username and proxy.password";
const socksLoginRefusal =
  "context.proxy takes no username or password for a socks4 or socks5 server, which Playwright " +
  "can't sign in to";
const geolocationRefusal =
  "context.geolocation takes a latitude within ±90, a longitude within ±180 and an accuracy of " +
  "at least 0";
const viewportRefusal =
  "context.viewport takes null, or a width and a height that are whole numbers of at least 1";
/** What the executor refuses right after it took a context, still before any browser. */
const acceptedContext = "executablePath must name a browser build";
const login = { username: "synthetic-user", password: "synthetic-password" };

/** Why the executor stopped before it started a browser, from `options`. */
const refusal = async (options: PlaywrightOptions) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(makePlaywrightExecutor(options)));
  if (Exit.isSuccess(exit)) throw new Error("The executor started");
  return (Cause.squash(exit.cause) as Error).message;
};

/**
 * Why the executor refused `context`. A context it takes stops it at its next check, an empty
 * `executablePath` (`acceptedContext`), so no browser starts either way.
 */
const contextOutcome = (context: unknown) =>
  refusal({ context: context as PlaywrightContextOptions, executablePath: "" });

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

  it.each([
    { proxy: { server: "http://proxy.example:8080", region: "in" } },
    { geolocation: { latitude: 28.6, longitude: 77.2, altitude: 216 } },
    { viewport: { width: 1280, height: 720, deviceScaleFactor: 2 } },
    {
      permissions: [
        { origin: "https://shop.example", permissions: ["geolocation"], scope: "all" },
      ],
    },
  ])("refuses an unknown key inside an option, as in %o", async (context) => {
    expect(await contextOutcome(context)).toBe(contextRefusal);
  });

  it.each([
    // Playwright drops a login written into the address, so every page would fail 407.
    [
      { server: `http://${login.username}:${login.password}@proxy.example:8080` },
      proxyServerRefusal,
    ],
    [{ server: `http://:${login.password}@proxy.example:8080` }, proxyServerRefusal],
    [{ server: `socks5://${login.username}@proxy.example:1080` }, proxyServerRefusal],
    [{ server: `${login.username}:${login.password}@proxy.example:8080` }, proxyServerRefusal],
    // Playwright reads a server with no scheme as an http proxy. Another scheme names none, and
    // neither does a URL with no host.
    [{ server: "ftp://proxy.example:21" }, proxyServerRefusal],
    [{ server: "socks://proxy.example:1080" }, proxyServerRefusal],
    [{ server: "socks5://" }, proxyServerRefusal],
    [{ server: ":3128" }, proxyServerRefusal],
    // Playwright can't sign in to a socks proxy.
    [{ server: "socks5://proxy.example:1080", ...login }, socksLoginRefusal],
    [{ server: "socks4://proxy.example:1080", password: login.password }, socksLoginRefusal],
  ])("refuses the proxy %o", async (proxy, message) => {
    expect(await contextOutcome({ proxy })).toBe(message);
  });

  it.each([
    [{ geolocation: { latitude: Number.NaN, longitude: 77.2 } }, geolocationRefusal],
    [{ geolocation: { latitude: 28.6, longitude: Number.NaN } }, geolocationRefusal],
    [{ geolocation: { latitude: 90.5, longitude: 77.2 } }, geolocationRefusal],
    [{ geolocation: { latitude: 28.6, longitude: -180.5 } }, geolocationRefusal],
    [{ geolocation: { latitude: 28.6, longitude: 77.2, accuracy: -1 } }, geolocationRefusal],
    [
      { geolocation: { latitude: 28.6, longitude: 77.2, accuracy: Number.POSITIVE_INFINITY } },
      geolocationRefusal,
    ],
    [{ viewport: { width: 1280.5, height: 720 } }, viewportRefusal],
    [{ viewport: { width: 0, height: 720 } }, viewportRefusal],
    [{ viewport: { width: 1280, height: Number.NaN } }, viewportRefusal],
  ])("refuses %o, which no browser can take", async (context, message) => {
    expect(await contextOutcome(context)).toBe(message);
  });

  it.each([
    { proxy: { server: "http://proxy.example:8080", ...login } },
    { proxy: { server: "https://proxy.example", bypass: ".internal.example" } },
    { proxy: { server: "socks5://proxy.example:1080" } },
    // A host alone, which Playwright reads as an http proxy.
    { proxy: { server: "localhost:3128" } },
    { proxy: { server: "127.0.0.1:8080", ...login } },
    { proxy: { server: "proxy.example.com:3128" } },
    { proxy: { server: "[::1]:3128" } },
    { geolocation: { latitude: -90, longitude: 180, accuracy: 0 } },
    { geolocation: { latitude: 90, longitude: -180 } },
    { viewport: { width: 1, height: 1 } },
    { viewport: null },
  ])("takes %o", async (context) => {
    expect(await contextOutcome(context)).toBe(acceptedContext);
  });

  it("takes the undefined a host without exactOptionalPropertyTypes writes", async () => {
    const unset = {
      locale: undefined,
      timezoneId: undefined,
      proxy: {
        server: "http://proxy.example:8080",
        bypass: undefined,
        username: undefined,
        password: undefined,
      },
      geolocation: { latitude: 28.6, longitude: 77.2, accuracy: undefined },
      viewport: undefined,
      userAgent: undefined,
      extraHTTPHeaders: undefined,
      ignoreHTTPSErrors: undefined,
      storageState: undefined,
      permissions: undefined,
    };
    expect(await contextOutcome(unset)).toBe(acceptedContext);
  });

  it("leaves out each undefined option, so neither the worker nor Playwright sees one", () => {
    // The executor hands its worker the options as decoded, and the worker decodes them again.
    const decoded = Schema.decodeUnknownSync(ContextOptions)(
      {
        locale: undefined,
        proxy: {
          server: "http://proxy.example:8080",
          username: undefined,
          password: login.password,
        },
        geolocation: { latitude: 28.6, longitude: 77.2, accuracy: undefined },
        viewport: undefined,
        permissions: [{ origin: "https://shop.example", permissions: ["geolocation"] }],
      },
      { onExcessProperty: "error" },
    );
    expect(decoded).toStrictEqual({
      proxy: { server: "http://proxy.example:8080", password: login.password },
      geolocation: { latitude: 28.6, longitude: 77.2 },
      permissions: [{ origin: "https://shop.example", permissions: ["geolocation"] }],
    });
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
