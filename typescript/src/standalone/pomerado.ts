import { Effect, Schema, type Scope } from "effect";
import type { PlaywrightContextOptions } from "../execution/playwright-execute.js";
import type { Pomerado, PomeradoOptions } from "./contracts.js";
import { makeSession, type StandaloneSession } from "./session.js";
import { requestContext } from "./request-context.js";
import { mintRequest } from "./mint-host.js";
import { runOperation, signInOnly } from "./run-operation.js";
import { requestSite } from "./request-context.js";
import { issueFileHandles } from "../mint/file-handles.js";
import { isLocalFileReference, openLocalFile } from "../execution/local-files.js";
import { SavedSession, saveSessionCode } from "../runtime/start-state.js";
import { PasswordlessLoginStep } from "../destinations/sign-in-recipe.js";
export { Artifact } from "./contracts.js";
export type {
  Pomerado,
  PomeradoOptions,
  PomeradoRequest,
  PomeradoMintRequest,
  MintArtifact,
  MintOutcome,
  LocalMintOutcome,
} from "./contracts.js";
/**
 * A session's calls. Each holds the session until it ends, so they run one at a time: a save never
 * lands between a run's browser calls, and one interrupted while it waits leaves the browser alone.
 * `ask`, `reveal` and a run's hooks are called while a call holds it, so they call none of these.
 */
export const sessionCalls = (session: StandaloneSession): Pomerado => {
  const mint: Pomerado["mint"] = (request) =>
    session.mutex.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          if (request.passwordless !== undefined)
            yield* Schema.decodeUnknown(PasswordlessLoginStep)(request.passwordless).pipe(
              Effect.mapError(
                () =>
                  new Error(
                    "passwordless must name at least one identifier kind a login offers, and no password",
                  ),
              ),
            );
          // The build sees each of the caller's files as a handle, never its reference.
          const issued = yield* issueFileHandles(
            request.input ?? {},
            isLocalFileReference,
            openLocalFile,
          );
          const handled = { ...request, input: issued.input };
          const context = yield* requestContext(session, handled);
          return yield* mintRequest(session, context, handled, issued.handles);
        }),
      ),
    );
  const run: Pomerado["run"] = (artifact, request, hooks) =>
    session.mutex.withPermits(1)(Effect.scoped(runOperation(session, artifact, request, hooks)));
  const signIn: Pomerado["signIn"] = (artifact, request) =>
    session.mutex.withPermits(1)(signInOnly(session, artifact, request));
  // One browser call between runs, on the session's own tab.
  const saveSession: Pomerado["saveSession"] = (url) =>
    session.mutex.withPermits(1)(
      Effect.gen(function* () {
        const { siteOrigin } = yield* requestSite(session, { url });
        const saved = yield* session.browser.execute(
          saveSessionCode(session.browser.targetId, siteOrigin),
          60,
        );
        const decoded = yield* Schema.decodeUnknown(SavedSession)(saved).pipe(
          Effect.mapError(() => new Error("The browser's saved session did not read")),
        );
        // Playwright's own storage state, which Playwright checks again when a context restores it.
        const state = decoded.state as NonNullable<PlaywrightContextOptions["storageState"]>;
        return { ...decoded, state };
      }),
    );
  return { mint, run, signIn, saveSession };
};

/**
 * A scoped session owns its browser, so a minted operation can run in the same signed-in session.
 */
export const createPomerado = (
  options: PomeradoOptions,
): Effect.Effect<Pomerado, Error, Scope.Scope> =>
  Effect.map(makeSession(options), sessionCalls);
