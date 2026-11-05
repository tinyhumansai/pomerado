import type { ModelProvider } from "@openai/agents";
import { type Effect, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { SignInRecipe, type PasswordlessLoginStep } from "../destinations/sign-in-recipe.js";
import type { MintOutcome } from "../mint/contracts.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type {
  PlaywrightContextOptions,
  PlaywrightOptions,
} from "../execution/playwright-execute.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { FileLimits } from "../runtime/files.js";
import type { ListCursorKeys } from "../runtime/list-cursor.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import type { OperationHooks } from "../runtime/operation-hooks.js";
import type { RevealSignInValue } from "../runtime/sign-in-replay.js";
import type { SavedSession, SavedSessionStorage } from "../runtime/start-state.js";
export interface PomeradoOptions {
  readonly ask: InputAsker;
  /**
   * The browser the host launches or attaches to. It never attaches over CDP (`cdp`): its runs
   * close other tabs and reset site data, which would change a browser it doesn't own. Its browser
   * calls keep the executor's 1 MiB result limit unless `resultLimitBytes` raises it, as for a
   * `saveSession` of a site that keeps more. Its `context` (`PlaywrightContextOptions`) restores a
   * `saveSession`'s `state` as its `storageState`: every site that session visited, not just the
   * one it was saved for. Its `context.ignoreHTTPSErrors` trusts any certificate for any origin,
   * the sign-in's included, so set it only for a TLS-intercepting proxy the host controls.
   */
  readonly browser?: Omit<PlaywrightOptions, "cdp">;
  /**
   * The tab's session storage to put back before the session's first page loads, as
   * `saveSession` returned it, beside the browser's restored storage state. It holds the origins
   * of the tab's frames on the saved URL's site that answered, none when the tab was elsewhere.
   * Each origin's entries go back on a blank page of that origin the browser serves itself, so the
   * site sees no request. Anything else fails before the browser starts.
   */
  readonly sessionStorage?: SavedSessionStorage;
  /**
   * For a host that answers a run's sign-in questions with its own handles in place of the values,
   * such as a phone number or a code (`RevealSignInValue`): called just before each sign-in value
   * is typed, with the origin of the document its field is in, it returns the value to type, or
   * fails to refuse typing it there. A value that is no handle comes back as it is. Only a run's
   * sign-in reveals: a build's types its answers as given.
   * - A value is typed only in a document of the origin it was revealed for: a field the page
   *   moves to another origin before it is typed isn't typed, and the run fails `NeedsInput`
   *   (`revealed_origin_changed`), as one to run again. Any failure, defect or empty answer
   *   refuses, that screen types nothing, and the run fails `NeedsInput` (`reveal_refused`); an
   *   interrupted reveal interrupts the run.
   * - It may be called more than once for one value, for each screen and origin that types it and
   *   again when a screen is filled again, so it gives the same answer each time.
   * - A code's fit to a screen's one-character boxes is checked once it is revealed, and one that
   *   doesn't fit fails the run `NeedsInput` (`code_does_not_fit_boxes`). A phone number or date of
   *   birth Pomerado asks for in place keeps its shape check, so a host answers those with the
   *   value, not a handle.
   * - Pomerado masks each value it returns, in the forms it is typed in, and masks the questions'
   *   prompts, which may quote the page. Its memory of the values a site rejected compares what
   *   the host answered, so a host gives a new value a fresh handle and the same value the same
   *   handle, and keeps its own record of the values the site rejected.
   */
  readonly reveal?: RevealSignInValue;
  readonly minterProvider?: ModelProvider;
  readonly guardianProvider?: ModelProvider;
  /** The outcome reviewer's model provider, which judges whether each write took effect. */
  readonly outcomeReviewerProvider?: ModelProvider;
  readonly policy?: string;
  readonly timeoutMs?: number;
  /**
   * Files a run places and collects. A caller names its own file by a `file:` URL in the input.
   * A run keeps each downloaded file for 30 minutes and returns its `file:` URL: under
   * `downloads` when given, else in this process's temporary directory, which is removed when
   * the process exits. `limits` caps the bytes (`defaultFileLimits`).
   */
  readonly files?: { readonly downloads?: string; readonly limits?: FileLimits };
  /**
   * How a list tool's cursors are signed and timed. `keys` sign them; without keys, this process
   * signs with a random key, so its cursors work until it exits. `now` is the clock that dates
   * them, `Date.now` by default. A cursor works for ten minutes, and a run refuses one this host did
   * not sign for that tool and those inputs before it signs in or loads a page.
   */
  readonly listCursors?: { readonly keys?: ListCursorKeys; readonly now?: () => number };
}

export interface PomeradoRequest {
  readonly intent: string;
  readonly url: string;
  readonly input?: unknown;
  readonly effect?: "read" | "write" | "ask";
  readonly authenticationOrigins?: readonly string[];
}

/** A mint's request: what any call on the site takes, and the login its account signs in with. */
export interface PomeradoMintRequest extends PomeradoRequest {
  /**
   * For an account with no password, such as one that signs in by a phone number and the code the
   * site sends: the identifier kinds it signs in with, and `password: false`. A build has no recipe
   * to read this from, as a run has (`recipeLoginStep`), so the host says it. Its login question
   * carries this as `currentStep` and its answer holds the identifier alone; a code is asked for
   * each screen that shows one. `ask` answers each with the value itself, since only a run reveals
   * (`PomeradoOptions.reveal`). A screen that takes a password types nothing, and the minter hears
   * that the login has none. Anything but one or more of a login's identifier kinds and no password
   * fails before the mint starts. Absent, a build's login asks for a username and a password.
   */
  readonly passwordless?: PasswordlessLoginStep;
}

/**
 * A local mint's outcome. A published build reports its live tests (`liveTests`) and the Guardian
 * review that allowed it (`publicationReview`). A build no longer sets `untrustedSignInOrigins`:
 * it refuses a sign-in form that submits off the site and `authenticationOrigins` before anything
 * is typed, and counts a screen as sent by its clicked submit. The field stays so older callers
 * still type-check.
 */
export type LocalMintOutcome = MintOutcome & {
  readonly untrustedSignInOrigins?: readonly string[];
};

/**
 * A session's calls. Each takes the session and holds it until it ends, so they run one at a time,
 * and a run's hooks, `ask` and `reveal` are called while it is held. They must not call any of the
 * session's calls, `saveSession` included: each waits for the call in progress, so it would wait
 * for the call it is inside, forever or until that call's deadline. A host saves before or after
 * a run.
 */
export interface Pomerado {
  readonly mint: (request: PomeradoMintRequest) => Effect.Effect<LocalMintOutcome, Error>;
  /**
   * Runs a minted artifact on `url` with no Guardian review and no model request. Guardian
   * reviewed the artifact when it was minted. `intent`, `effect` and `authenticationOrigins` are
   * not checked here, so run only artifacts you minted or trust. Its sign-in types the login on
   * the site, the request's `authenticationOrigins` and the ones the artifact saved in
   * `signIn.authenticationOrigins`, which its build's request declared (a tool an older version
   * built may also hold ones its caller trusted when asked). A read or a confirmed write returns
   * its output. A failed sign-in fails with `SignInRunFailed`, and any other run with
   * `RunOutcomeFailure`, which says what it did to the website and how to retry.
   */
  readonly run: (
    artifact: MintArtifact,
    request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
    /**
     * The host's hooks into this run (`OperationHooks`): when its code starts, the pages after
     * each browser call, and each commit step, whose click waits for the host to accept it.
     */
    hooks?: OperationHooks,
  ) => Effect.Effect<unknown, Error>;
  /**
   * Signs the session in with the artifact's recorded sign-in, as a run does before its
   * operation, and runs nothing else, so a host can save the session right after it. A session
   * that already shows signed in types nothing (`alreadySignedIn`). An artifact with no recorded
   * sign-in fails, and a failed sign-in fails with its `SignInRunFailed`.
   */
  readonly signIn: (
    artifact: MintArtifact,
    request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
  ) => Effect.Effect<{ readonly alreadySignedIn: boolean }, Error>;
  /**
   * The session's site data as a host saves it to start a later session from. `state` is the
   * browser's whole storage state, IndexedDB included, for every site this session visited, not
   * just `url`'s; a later session restores it as `browser.context.storageState`, as it is.
   * `sessionStorage` is read from the tab's frames on `url`'s site, so save while the tab shows
   * that site: a tab elsewhere saves none, and a frame that doesn't answer within seconds is left
   * out. A save waits for a mint, a run or a sign-in in progress, so a host saves before or after
   * a run, never from its hooks, `ask` or `reveal`. Its JSON counts against the browser's result
   * limit.
   */
  readonly saveSession: (url: string) => Effect.Effect<
    SavedSession & {
      readonly state: NonNullable<PlaywrightContextOptions["storageState"]>;
    },
    Error
  >;
}

/** A web page a run can open: an http or https URL with no credentials and no fragment. */
export const PageUrl = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }),
);
/** A sign-in origin a tool saves: an https origin exactly as `URL.origin` writes it. */
export const SignInOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return url !== null && url.protocol === "https:" && url.origin === value;
  }),
);
export const Artifact = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  entrypoint: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /**
   * The verified sign-in a build recorded: its value-free recipe, where its runs start and the
   * build's https sign-in origins, when it has any.
   */
  signIn: Schema.optionalWith(
    Schema.Struct({
      recipe: SignInRecipe,
      entryUrl: PageUrl,
      authenticationOrigins: Schema.optionalWith(Schema.Array(SignInOrigin), { exact: true }),
    }),
    { exact: true },
  ),
  /** The questions publication reviewed, the only ones a run asks. */
  questions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  acceptedConfirms: Schema.optionalWith(ExpectedConfirms, { exact: true }),
});
export type { MintArtifact, MintOutcome };
