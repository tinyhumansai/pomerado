import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { makePlaywrightExecutor } from "../execution/playwright-execute.js";
import { makeRunSecrets, registerSecretAnswer } from "../inputs/secrets.js";
import { localRuntimeAssets } from "../execution/local-runtime-assets.js";
import { shownForms } from "../privacy/value-forms.js";
import type { InputAsker } from "../runtime/input-request.js";
import {
  pageOriginsOnly,
  SavedSessionStorage,
  sessionStorageRestoreCode,
} from "../runtime/start-state.js";
import type { SessionTyping } from "./authentication.js";
import type { PomeradoOptions } from "./contracts.js";
import { error, mintError } from "./errors.js";

/**
 * A session's secrets, the host's proxy password among them from the start: page code never reads
 * it, so a page or an error that shows it is masked like any answer. Masking covers every place a
 * value appears, so only a password of 8 characters or more in each form it shows in counts: a
 * shorter one, like a username, is often an ordinary word, which would be masked in page text and
 * refuse a tool's source that holds it.
 */
export const sessionSecrets = (options: PomeradoOptions) => {
  const secrets = makeRunSecrets();
  const password = options.browser?.context?.proxy?.password;
  if (password !== undefined && shownForms(password).every(([, short]) => !short))
    secrets.register(password);
  return secrets;
};

export const makeSession = (options: PomeradoOptions) =>
  Effect.gen(function* () {
    if (options.browser !== undefined && "cdp" in options.browser)
      return yield* Effect.fail(
        new Error(
          "The local host doesn't attach over CDP: its runs close other tabs and reset site data in the browser. Use endpoint or a launched browser.",
        ),
      );
    // Saved session storage goes back on the session's own tab, checked before the browser starts.
    const saved =
      options.sessionStorage === undefined
        ? undefined
        : yield* Schema.decodeUnknown(SavedSessionStorage)(options.sessionStorage).pipe(
            Effect.mapError(
              () =>
                new Error(
                  "sessionStorage must be as saveSession returned it: each origin with its " +
                    "entries as pairs of strings",
                ),
            ),
          );
    const sessionStorage = saved === undefined ? undefined : pageOriginsOnly(saved);
    if (sessionStorage === undefined && saved !== undefined)
      return yield* Effect.fail(
        new Error("sessionStorage names an origin that is not an http or https page's own"),
      );
    const browser = yield* makePlaywrightExecutor(options.browser);
    if (sessionStorage !== undefined && sessionStorage.length > 0)
      yield* browser.execute(sessionStorageRestoreCode(browser.targetId, sessionStorage), 60);
    const policy =
      options.policy ??
      (yield* Effect.tryPromise({
        try: () => readFile(new URL("../guardian/upstream-policy.md", import.meta.url), "utf8"),
        catch: error,
      }));
    // The executor checked the context, so its proxy password is a string, if it has one.
    const secrets = sessionSecrets(options);
    yield* Effect.addFinalizer(() => Effect.sync(secrets.clear));
    const mutex = yield* Effect.makeSemaphore(1);
    const trustedSources = new Map(yield* localRuntimeAssets);
    const projection = {
      text: (value: string) => Effect.sync(() => secrets.redact(value)),
      json: (value: unknown) => secrets.json(value).pipe(Effect.mapError(mintError)),
      source: (_path: string, value: string) =>
        secrets.assertAbsent(value).pipe(Effect.as(value), Effect.mapError(mintError)),
    };
    const ask: InputAsker = (request, bounds) =>
      options.ask(request, bounds).pipe(
        Effect.tap((answers) =>
          Effect.sync(() => {
            for (const [id, answer] of Object.entries(answers)) {
              if (answer.type === "secret") {
                const question = request.questions.find((candidate) => candidate.id === id);
                registerSecretAnswer(
                  secrets,
                  question?.type === "secret" ? question.secretKind : undefined,
                  answer.value,
                );
              }
              if (answer.type === "credential") {
                if (answer.value.username !== undefined) secrets.register(answer.value.username);
                if (answer.value.password !== undefined) secrets.register(answer.value.password);
              }
            }
          }),
        ),
      );
    // One typing memory for the session's browser, across every build on it.
    const signInTyping: SessionTyping = { typed: false };
    return {
      options,
      browser,
      policy,
      secrets,
      mutex,
      trustedSources,
      projection,
      ask,
      signInTyping,
    };
  });
export type StandaloneSession = Effect.Effect.Success<ReturnType<typeof makeSession>>;
