import { Schema } from "effect";

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
 * The options a host sets for the context the worker opens: Playwright's own, a fixed set that
 * leaves the executor's own behaviour alone, and per-origin permissions in place of Playwright's
 * `permissions`, which grants every origin.
 */
export const ContextOptions = Schema.Struct({
  proxy: Schema.optionalWith(
    Schema.Struct({
      server: Schema.String,
      bypass: Schema.optionalWith(Schema.String, { exact: true }),
      username: Schema.optionalWith(Schema.String, { exact: true }),
      password: Schema.optionalWith(Schema.String, { exact: true }),
    }),
    { exact: true },
  ),
  locale: Schema.optionalWith(Schema.String, { exact: true }),
  timezoneId: Schema.optionalWith(Schema.String, { exact: true }),
  geolocation: Schema.optionalWith(
    Schema.Struct({
      latitude: Schema.Number,
      longitude: Schema.Number,
      accuracy: Schema.optionalWith(Schema.Number, { exact: true }),
    }),
    { exact: true },
  ),
  viewport: Schema.optionalWith(
    Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
    { exact: true },
  ),
  userAgent: Schema.optionalWith(Schema.String, { exact: true }),
  extraHTTPHeaders: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { exact: true },
  ),
  ignoreHTTPSErrors: Schema.optionalWith(Schema.Boolean, { exact: true }),
  /** Playwright's storage state as an object, cookies and each origin's storage. */
  storageState: Schema.optionalWith(
    Schema.Struct({ cookies: Schema.Array(Schema.Unknown), origins: Schema.Array(Schema.Unknown) }),
    { exact: true },
  ),
  permissions: Schema.optionalWith(
    Schema.Array(Schema.Struct({ origin: PageOrigin, permissions: Schema.Array(Schema.String) })),
    { exact: true },
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
