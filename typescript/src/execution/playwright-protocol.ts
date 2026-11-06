import { identity, Option, Schema } from "effect";

/** The messages between the native executor and its worker thread. Internal to the executor. */
export const NativeWorkerRequest = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("execute"),
    code: Schema.String,
    /**
     * Values to watch for: the worker answers which ones a typing call delivered, and in which
     * frame (`typed`).
     */
    watch: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("credential"),
    target: Schema.Struct({
      targetId: Schema.optional(Schema.String),
      bindingKey: Schema.String,
      documentOrigin: Schema.String,
    }),
    text: Schema.String,
    /** The keyboard's `InsertionOptions`: read a phone number back, type by keys or by trusted keys. */
    phone: Schema.optional(Schema.Literal(true)),
    keys: Schema.optional(Schema.Literal(true)),
    trustedKeys: Schema.optional(Schema.Literal(true)),
  }),
  /** A read of a bound field, typing nothing (`CredentialKeyboard.readBack`). */
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("credential_read_back"),
    target: Schema.Struct({
      targetId: Schema.optional(Schema.String),
      bindingKey: Schema.String,
      documentOrigin: Schema.String,
    }),
    numbers: Schema.Array(Schema.String),
  }),
);
export const NativeWorkerReply = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    targetId: Schema.String,
    /** The context the worker made and owns; absent for a page it adopted over CDP. */
    contextId: Schema.optional(Schema.String),
  }),
  /** The worker's own connection to a CDP-attached browser closed. */
  Schema.Struct({ kind: Schema.Literal("disconnected") }),
  Schema.Struct({ kind: Schema.Literal("response"), id: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("failure"), id: Schema.String, error: Schema.String }),
);
export const PlaywrightLibrary = Schema.Literal("playwright", "patchright");
export type PlaywrightLibrary = typeof PlaywrightLibrary.Type;
/** The browsers the native executor drives. */
export const BrowserName = Schema.Literal("chromium", "firefox");
export type BrowserName = typeof BrowserName.Type;
/** An http or https page's own origin, exactly as `URL.origin` writes it. */
const PageOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return url !== null && /^https?:$/u.test(url.protocol) && url.origin === value;
  }),
);
/**
 * An option a host may leave out or set to undefined, as a host without
 * `exactOptionalPropertyTypes` writes one it leaves unset. Decoded, an undefined one is left out,
 * so neither the worker's data nor Playwright ever holds it.
 */
const unsetOr = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.optionalToOptional(Schema.UndefinedOr(schema), Schema.typeSchema(schema), {
    decode: (value) => Option.filter(value, (option): option is A => option !== undefined),
    encode: identity,
  });

/**
 * Why a context option was refused, for the rules beyond its shape. A refusal names the rule,
 * never the value, which may hold a proxy's login.
 */
export const contextRules = {
  proxyServer:
    "context.proxy.server takes an http, https, socks4 or socks5 URL of a host, or the host " +
    "alone for http, with no login in it: the login goes in proxy.username and proxy.password",
  socksLogin:
    "context.proxy takes no username or password for a socks4 or socks5 server, which Playwright " +
    "can't sign in to",
  geolocation:
    "context.geolocation takes a latitude within ±90, a longitude within ±180 and an accuracy of " +
    "at least 0",
  viewport:
    "context.viewport takes null, or a width and a height that are whole numbers of at least 1",
} as const;

/**
 * A proxy server's address as Playwright reads it, where one with no scheme, such as
 * `proxy.example:3128`, is an http proxy's. Null for one that is no URL.
 */
const proxyUrl = (server: string) =>
  URL.parse(/^[a-z][a-z\d+.-]*:\/\//iu.test(server) ? server : `http://${server}`);
const socksServer = (server: string) => /^socks[45]:$/u.test(proxyUrl(server)?.protocol ?? "");

/**
 * A proxy as Playwright opens it: a server URL with one of its schemes and a host, or the host
 * alone for http, and its login apart. Playwright drops a login written into the URL, so every
 * page would fail 407, and it can't sign in to a socks proxy at all.
 */
const ProxyOptions = Schema.Struct({
  server: Schema.String.pipe(
    Schema.filter(
      (value) => {
        const url = proxyUrl(value);
        return (
          url !== null &&
          /^(https?|socks[45]):$/u.test(url.protocol) &&
          url.hostname !== "" &&
          url.username === "" &&
          url.password === ""
        );
      },
      { message: () => contextRules.proxyServer },
    ),
  ),
  bypass: unsetOr(Schema.String),
  username: unsetOr(Schema.String),
  password: unsetOr(Schema.String),
}).pipe(
  Schema.filter((proxy) => !(socksServer(proxy.server) && (proxy.username || proxy.password)), {
    message: () => contextRules.socksLogin,
  }),
);

/** A coordinate or an accuracy that `accepts` takes: NaN fails every comparison, so none does. */
const Geolocated = (accepts: (value: number) => boolean) =>
  Schema.Number.pipe(Schema.filter(accepts, { message: () => contextRules.geolocation }));
/** A side of the viewport: a whole number of pixels, at least 1. */
const Pixels = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value >= 1, {
    message: () => contextRules.viewport,
  }),
);

/**
 * The options a host sets for the context the worker opens: Playwright's own, a fixed set that
 * leaves the executor's own behaviour alone, and per-origin permissions in place of Playwright's
 * `permissions`, which grants every origin. Each may be undefined, which leaves it out.
 */
export const ContextOptions = Schema.Struct({
  proxy: unsetOr(ProxyOptions),
  locale: unsetOr(Schema.String),
  timezoneId: unsetOr(Schema.String),
  geolocation: unsetOr(
    Schema.Struct({
      latitude: Geolocated((value) => value >= -90 && value <= 90),
      longitude: Geolocated((value) => value >= -180 && value <= 180),
      accuracy: unsetOr(Geolocated((value) => Number.isFinite(value) && value >= 0)),
    }),
  ),
  viewport: unsetOr(Schema.NullOr(Schema.Struct({ width: Pixels, height: Pixels }))),
  userAgent: unsetOr(Schema.String),
  extraHTTPHeaders: unsetOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  ignoreHTTPSErrors: unsetOr(Schema.Boolean),
  /** Playwright's storage state as an object, cookies and each origin's storage. */
  storageState: unsetOr(
    Schema.Struct({ cookies: Schema.Array(Schema.Unknown), origins: Schema.Array(Schema.Unknown) }),
  ),
  permissions: unsetOr(
    Schema.Array(Schema.Struct({ origin: PageOrigin, permissions: Schema.Array(Schema.String) })),
  ),
});
export const NativeWorkerOptions = Schema.Struct({
  endpoint: Schema.String,
  startupTimeoutMs: Schema.Number,
  library: PlaywrightLibrary,
  browser: BrowserName,
  /** The most bytes of JSON a script's result may take; 1 MiB when absent. Output keeps 1 MiB. */
  resultLimitBytes: Schema.optional(Schema.Number),
  /** Attach over CDP and drive the browser's own context, at this page (its first when absent). */
  cdp: Schema.optional(Schema.Struct({ targetId: Schema.optional(Schema.String) })),
  /** The host's options for the context the worker opens; never over CDP. */
  context: Schema.optional(ContextOptions),
});
