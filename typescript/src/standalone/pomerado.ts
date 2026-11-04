import { Effect, Schema, type Scope } from "effect";
import type { Pomerado, PomeradoOptions } from "./contracts.js";
import { makeSession } from "./session.js";
import { requestContext } from "./request-context.js";
import { mintRequest } from "./mint-host.js";
import { runOperation, signInOnly } from "./run-operation.js";
import { requestSite } from "./request-context.js";
import { issueFileHandles } from "../mint/file-handles.js";
import { isLocalFileReference, openLocalFile } from "../execution/local-files.js";
import { SavedSession, saveSessionCode } from "../runtime/start-state.js";
export { Artifact } from "./contracts.js";
export type {
  Pomerado,
  PomeradoOptions,
  PomeradoRequest,
  MintArtifact,
  MintOutcome,
  LocalMintOutcome,
} from "./contracts.js";
/** A scoped session owns its browser, so a minted operation can run in the same signed-in session. */
export const createPomerado = (
  options: PomeradoOptions,
): Effect.Effect<Pomerado, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* makeSession(options);
    const mint: Pomerado["mint"] = (request) =>
      session.mutex.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
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
          return yield* Schema.decodeUnknown(SavedSession)(saved).pipe(
            Effect.mapError(() => new Error("The browser's saved session did not read")),
          );
        }),
      );
    return { mint, run, signIn, saveSession };
  });
