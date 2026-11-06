import { stageSources } from "./local-operation-stage.js";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { DialogDecider } from "../runtime/kernel-operation.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import type { CommitMark } from "../runtime/context.js";
import type { InputIssue } from "../runtime/errors.js";
import type {
  InputRefusalDetail,
  InputNotAppliedDetail,
} from "../runtime/operation-failure.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { asksAsDeclared } from "./declared-questions.js";
import {
  type CardFillOutcome,
  type RunCardHandles,
  makeRunCardHandles,
  scriptAnswers,
  scriptCardFillAnswer,
} from "../destinations/card-fill.js";
import type { ScriptCardFillRequest } from "../runtime/script-card-fill.js";
import {
  sessionSignInAnswerMs,
  sessionSignInFillMs,
  sessionSignInSettleMs,
  type SessionSignInAnswer,
  type SessionSignInHook,
} from "../runtime/session-sign-in.js";
import { createLocalProcess, type LocalProcess, type LocalProcessResult } from "./local-process.js";
import { localError, localOutputLimit } from "./local-path.js";
import {
  commitRefusedCode,
  LocalOperationMessage,
  type LocalOperationResult,
} from "./local-operation-protocol.js";
import type { LocalWorkspace } from "./local-workspace.js";
import { commitReportValue } from "../runtime/commit-report.js";
import { FileRefused } from "../runtime/files.js";
import { outputFiles, type RunFiles } from "../runtime/file-transfer.js";
import { HttpFailure, type HttpTransport } from "../runtime/site-http.js";
import type { ListHost } from "../runtime/list-page.js";
import {
  pageFingerprint,
  pageProgressCode,
  type EnteredCommit,
  type OperationHooks,
} from "../runtime/operation-hooks.js";

export interface LocalOperationOptions {
  readonly workspace: LocalWorkspace;
  readonly entrypoint: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input?: unknown;
  readonly retainedOutput?: { readonly value: unknown };
  readonly browser?: { readonly sessionId: string; readonly executeResponse: BrowserExecute };
  readonly siteOrigin?: string;
  readonly siteDomain?: string;
  readonly timeoutMs?: number;
  readonly mode?: "run" | "contract";
  readonly validateInput?: boolean;
  /**
   * A run whose output fails its schema returns that output as its result, with `outputDrift`,
   * rather than failing `InvalidOutput`: a write already happened when it returned. Its files
   * are checked as any result's are.
   */
  readonly keepDriftedOutput?: boolean;
  readonly target?: "browser" | "pureFiles";
  /**
   * A mint step: the run counts as possibly sent from its first browser call, so a step that
   * stopped before one reads `not_sent`. Without it, a live run counts from its start.
   */
  readonly dispatchAtFirstCall?: boolean;
  readonly ask?: InputAsker;
  /**
   * The questions the host read itself: a build step's literal declarations, or the ones
   * publication reviewed. The host puts a script's request to its caller only when every question
   * matches one of them (`asksAsDeclared`); otherwise the script's `ask` fails as `Undeclared` and
   * nobody is asked. Absent, no script question is asked.
   */
  readonly declaredQuestions?: ScriptQuestionDeclarations;
  readonly decideDialog?: DialogDecider;
  /**
   * The host's sign-in for a script's `ensureSignedIn`, on the same browser. Absent, the script's
   * `ensureSignedIn` answers that it did not sign in again.
   */
  readonly signIn?: SessionSignInHook;
  /**
   * The host's card fill for a script's `fillCard`, on the same browser: it types the card answers
   * behind the step's handles, which this run's `ask` issued in place of each card answer. Absent,
   * `fillCard` throws, and a card answer still reaches the script only as a handle.
   */
  readonly cardFill?: (input: {
    readonly step: ScriptCardFillRequest;
    readonly handles: RunCardHandles;
  }) => Effect.Effect<CardFillOutcome, Error>;
  /**
   * Set when this host signs list cursors: the position the caller's cursor holds, once
   * `admitListCursor` checked it. Absent, a run refuses any cursor that would continue a runtime
   * list and returns no next cursor.
   */
  readonly list?: ListHost;
  /**
   * The run's files, for the script's `files`. Absent, `files` throws; either way an output naming
   * a `$file` this run did not collect fails the run.
   */
  readonly files?: RunFiles;
  /**
   * The transport an HTTP version's `SiteHttp` sends over, as `makeSiteHttp` uses it. Absent, an
   * HTTP version fails before it sends anything; a Kernel script never uses it.
   */
  readonly http?: HttpTransport;
  /**
   * The host's hooks into this run (`OperationHooks`): before the child starts the script, the
   * pages after each of its browser calls, and each commit step it enters, whose next call that
   * can reach the site waits for the host to accept it. With a commit hook, the run fails
   * `CommitRefused` once the host refused a step, even after its script returned, and no held
   * call goes through once the run is decided. A step whose report fails the host's own check of
   * it, or one the child marks without entering it through the host, is refused without asking
   * the hook. Absent, the run goes as before. `seen` needs the session's browser, so the caller
   * that holds it runs that read, as `afterBrowserCall`.
   */
  readonly hooks?: Omit<OperationHooks, "seen">;
  /**
   * Runs after each browser call of the script that the browser answered, and the script's next
   * call waits for it. It can't fail, so the call stands whatever it does.
   */
  readonly afterBrowserCall?: Effect.Effect<void>;
}
export interface LocalOperationJournal {
  readonly effect: "not_sent" | "possible" | "verified";
  readonly confirmation?: "message" | "readback";
  readonly commits: readonly CommitMark[];
}
export class LocalOperationFailure extends Error {
  override readonly name = "LocalOperationFailure";
  /**
   * The child reported this failure with its final journal. False when the host lost the
   * result, as at a deadline or a child exit: the journal is then the last one the child
   * streamed as it ran.
   */
  readonly reported: boolean;
  /** The host could not sign the page in again while the script waited in `ensureSignedIn`. */
  readonly sessionLoss?: "session_not_kept";
  /** The input a script's `InvalidInput` named and the choices the page offers for it. */
  readonly refusal?: InputRefusalDetail;
  /** The input a script's `InputNotApplied` named and what the page kept instead. */
  readonly unapplied?: InputNotAppliedDetail;
  /** The authored source line that threw, such as `src/tool.mjs:12`, when the child named one. */
  readonly frame?: string;
  /** The commit step the host's commit hook refused; nothing the script did after it ran. */
  readonly commitRefused?: string;
  constructor(
    message: string,
    readonly journal: LocalOperationJournal,
    readonly code?: string,
    readonly tag?: string,
    /** Where the operation's input schema rejected its input, on an `InvalidInput`. */
    readonly inputIssues?: readonly InputIssue[],
    options: {
      readonly reported?: boolean;
      readonly sessionLoss?: "session_not_kept";
      readonly refusal?: InputRefusalDetail;
      readonly unapplied?: InputNotAppliedDetail;
      readonly frame?: string;
      readonly commitRefused?: string;
    } = {},
  ) {
    super(message);
    this.reported = options.reported ?? true;
    if (options.sessionLoss !== undefined) this.sessionLoss = options.sessionLoss;
    if (options.refusal !== undefined) this.refusal = options.refusal;
    if (options.unapplied !== undefined) this.unapplied = options.unapplied;
    if (options.frame !== undefined) this.frame = options.frame;
    if (options.commitRefused !== undefined) this.commitRefused = options.commitRefused;
  }
}
export interface LocalOperationOutput extends LocalOperationJournal {
  readonly output: unknown;
  /** The declared schemas, and in contract mode the declared questions. */
  readonly schemas: {
    readonly input: unknown;
    readonly output: unknown;
    readonly questions?: ScriptQuestionDeclarations;
  };
  readonly stdout: string;
  readonly stderr: string;
  readonly write?: WriteDeclaration;
  readonly inputDecodes?: true;
  /** The output failed its schema and was kept (`keepDriftedOutput`). */
  readonly outputDrift?: true;
}

const sendToChild = (process: LocalProcess, message: object) =>
  Effect.async<void, Error>((resume) => {
    if (!process.child.connected || process.child.send === undefined) {
      resume(Effect.fail(new Error("Local child IPC disconnected")));
      return;
    }
    process.child.send(message, (error) =>
      resume(error === null ? Effect.void : Effect.fail(localError(error))),
    );
  });
const failureCode = (error: Error) =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;
const suspended = <A, E>(deadline: Deadline, run: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => deadline.suspend()),
    () => run,
    (resume) => Effect.sync(resume),
  );
/**
 * One script's `ensureSignedIn`, answered within the sign-in's bounds: no step of the host's
 * sign-in starts after the filling bound, and past the answer bound the host stops it, waits for
 * its last step to end and refuses. An interrupted request (the script ended or the child exited)
 * stops the sign-in the same way.
 */
export const answerSessionSignIn = (
  signIn: SessionSignInHook,
  bounds: { readonly fillMs: number; readonly answerMs: number; readonly settleMs: number } = {
    fillMs: sessionSignInFillMs,
    answerMs: sessionSignInAnswerMs,
    settleMs: sessionSignInSettleMs,
  },
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stop = new AbortController();
    const signingIn = yield* Effect.forkDaemon(
      signIn({ untilMs: now + bounds.fillMs, stop: stop.signal }),
    );
    // Stop the sign-in at its next step and wait for it to end, so nothing after this shares the
    // browser with it.
    const settle = Effect.sync(() => stop.abort()).pipe(
      Effect.zipRight(Fiber.await(signingIn).pipe(Effect.timeoutOption(bounds.settleMs))),
      Effect.zipRight(Fiber.interrupt(signingIn)),
    );
    const raced = yield* Effect.raceFirst(
      Fiber.join(signingIn).pipe(Effect.map((answer) => ({ answer }))),
      Effect.sleep(bounds.answerMs).pipe(Effect.as({ expired: true as const })),
    ).pipe(Effect.onInterrupt(() => settle));
    if ("answer" in raced) return raced.answer;
    yield* settle;
    return { outcome: "refused", cause: "session_sign_in_failed" } satisfies SessionSignInAnswer;
  });
/** Holds a call that can reach the site until the host accepted every step entered before it. */
type CommitHold = <A>(call: Effect.Effect<A, Error>) => Effect.Effect<A, Error>;

/**
 * `call`, held until the host accepted every commit step the script entered before it, when the
 * host gave a commit hook (`hold`); without one, `call` runs as it always did.
 */
const gated = <A>(
  hold: CommitHold | undefined,
  call: Effect.Effect<A, Error>,
): Effect.Effect<A, Error> => (hold === undefined ? call : hold(call));

/**
 * The host's progress hook after one of the script's browser calls, with a fingerprint of the
 * pages then. A read that fails, or finds no page, reports nothing and leaves the run as it was,
 * and so does a hook that fails or dies.
 */
const reportProgress = (
  browser: NonNullable<LocalOperationOptions["browser"]>,
  progress: NonNullable<OperationHooks["progress"]>,
) =>
  browser.executeResponse(pageProgressCode, 10).pipe(
    Effect.flatMap((read) => {
      const fingerprint = read.success ? pageFingerprint(read.result) : undefined;
      return fingerprint === undefined ? Effect.void : progress(fingerprint);
    }),
    // error-reporting-allow: typed-recovery a progress read is the host's own view of the page; one that fails, or a hook that dies, reports nothing and the script's call stands
    Effect.catchAllCause(() => Effect.void),
  );

const handleRequest = (
  options: LocalOperationOptions,
  deadline: Deadline,
  message: Exclude<LocalOperationMessage, { kind: "result" | "error" | "cancel" | "journal" }>,
  cardHandles: RunCardHandles,
  /**
   * With a commit hook, holds each call that can reach the site until the host accepted every
   * commit step the script entered before it, and refuses it once the host refused one or the
   * run was decided. Absent without a commit hook.
   */
  hold: CommitHold | undefined,
): Effect.Effect<unknown, Error> =>
  Effect.suspend<unknown, Error, never>(() => {
    if (message.kind === "execute") {
      if (options.mode === "contract" || options.target === "pureFiles")
        return Effect.fail(
          new Error("Browser access is unavailable for this local operation mode"),
        );
      const browser = options.browser;
      if (browser === undefined || message.sessionId !== browser.sessionId)
        return Effect.fail(new Error("Local operation browser session mismatch"));
      const progress = options.hooks?.progress;
      const call = gated(
        hold,
        browser.executeResponse(message.body.code, message.body.timeout_sec),
      );
      return call.pipe(
        Effect.tap(() => (progress === undefined ? Effect.void : reportProgress(browser, progress))),
        Effect.tap(() => options.afterBrowserCall ?? Effect.void),
      );
    }
    if (
      message.kind === "file_place" ||
      message.kind === "file_arm" ||
      message.kind === "file_collect"
    ) {
      const files = options.files;
      if (files === undefined || options.mode === "contract" || options.target === "pureFiles")
        return Effect.fail(new Error("Local operation files are unavailable"));
      const answer: Effect.Effect<unknown, FileRefused> =
        message.kind === "file_place"
          ? files.place(message)
          : message.kind === "file_arm"
            ? files.arm()
            : files.collect(message);
      // The refusal's reason crosses to the script as its code; nothing of the file does.
      const crossed = answer.pipe(
        Effect.mapError((refused) =>
          Object.assign(new Error(refused.message), {
            code: `FileRefused:${refused.reason}${refused.dispatched === true ? ":dispatched" : ""}`,
          }),
        ),
      );
      // Arming the capture reaches no page.
      return message.kind === "file_arm" ? crossed : gated(hold, crossed);
    }
    if (message.kind === "http") {
      const transport = options.http;
      if (transport === undefined || options.mode === "contract")
        return Effect.fail(new Error("Local operation HTTP is unavailable"));
      const { request, timeoutMs, maxResponseBytes } = message;
      const sent = Effect.tryPromise({
        try: (signal) =>
          transport.send(request, {
            signal,
            timeoutMs,
            ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
          }),
        // The transport's failure crosses to the child as its code and dispatch.
        catch: (error) =>
          error instanceof HttpFailure
            ? Object.assign(new Error(error.message), {
                code: `HttpFailure:${error.code}:${error.dispatch}`,
              })
            : localError(error),
      });
      return gated(hold, sent);
    }
    if (message.kind === "sign_in")
      return options.signIn === undefined
        ? Effect.fail(new Error("Local operation sign-in is unavailable"))
        : gated(hold, suspended(deadline, answerSessionSignIn(options.signIn)));
    if (message.kind === "ask") {
      if (options.ask === undefined)
        return Effect.fail(new Error("Local operation input is unavailable"));
      // The child runs minted code, so only the declarations the host read decide what is asked.
      if (!asksAsDeclared(message.request, options.declaredQuestions ?? {}))
        return Effect.fail(
          Object.assign(new Error("Local operation asked beyond its declared questions"), {
            code: "Undeclared",
          }),
        );
      return suspended(deadline, options.ask(message.request)).pipe(
        // ScriptInput validates raw answers in the child; the host has already typed them.
        Effect.map((answers) => scriptAnswers(message.request, answers, cardHandles)),
      );
    }
    if (message.kind === "card_fill") {
      const cardFill = options.cardFill;
      if (
        cardFill === undefined ||
        options.browser === undefined ||
        options.mode === "contract" ||
        options.target === "pureFiles"
      )
        return Effect.fail(new Error("Local operation card fill is unavailable"));
      return gated(
        hold,
        suspended(deadline, cardFill({ step: message.step, handles: cardHandles })),
      ).pipe(Effect.map(scriptCardFillAnswer));
    }
    return options.decideDialog === undefined
      ? Effect.fail(new Error("Local operation dialog decision is unavailable"))
      : suspended(deadline, options.decideDialog({ ...message.report, interactionId: message.id }));
  });

const handleTerminalMessage = (
  message: Extract<LocalOperationMessage, { kind: "result" | "error" | "cancel" }>,
  completed: Deferred.Deferred<LocalOperationResult, Error>,
  pending: Map<string, Fiber.RuntimeFiber<void, never>>,
) => {
  if (message.kind === "result") {
    Effect.runSync(
      pending.size === 0
        ? Deferred.succeed(completed, message)
        : Deferred.fail(
            completed,
            new Error(
              "Local operation returned while host requests were pending; completion uncertain",
            ),
          ),
    );
    return;
  }
  if (message.kind === "error") {
    Effect.runSync(
      Deferred.fail(
        completed,
        new LocalOperationFailure(
          message.error,
          operationJournal(message),
          message.code,
          message.tag,
          message.inputIssues,
          {
            // A host request still out may yet reach the page, so this is no final report.
            ...(pending.size === 0 ? {} : { reported: false }),
            ...(message.sessionLoss === undefined ? {} : { sessionLoss: message.sessionLoss }),
            ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
            ...(message.unapplied === undefined ? {} : { unapplied: message.unapplied }),
            ...(message.frame === undefined ? {} : { frame: message.frame }),
          },
        ),
      ),
    );
    return;
  }
  if (message.kind === "cancel") {
    const fiber = pending.get(message.id);
    if (fiber !== undefined) Effect.runCallback(Fiber.interrupt(fiber));
    return;
  }
};

const decodeMessage = (raw: unknown) =>
  Effect.try({
    try: () => {
      if (serialize(raw).byteLength > localOutputLimit)
        throw new Error("Local operation IPC exceeds output limit");
      return raw;
    },
    catch: localError,
  }).pipe(Effect.flatMap(Schema.decodeUnknown(LocalOperationMessage)), Effect.mapError(localError));

const receiveOperation = (
  process: LocalProcess,
  options: LocalOperationOptions,
  deadline: Deadline,
) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<LocalOperationResult, Error>();
    const pending = new Map<string, Fiber.RuntimeFiber<void, never>>();
    // The run's card answers, which only its own `fillCard` names; nothing keeps them past it.
    const cardHandles = makeRunCardHandles();
    let finished = false;
    let current: LocalOperationJournal = { effect: "not_sent", commits: [] };
    const commit = options.hooks?.commit;
    // With a commit hook: each step the script entered, in order, with the host's answer, and the
    // first refusal. Once the run is decided (`closed`), no held call goes through and no answer
    // counts. `siteCalls` counts the calls that can reach the site that are out, held or running.
    const steps: EnteredStep[] = [];
    let refusal: CommitRefusal | undefined;
    let closed = false;
    let siteCalls = 0;
    let siteCallCame = false;
    const answering = new Set<Fiber.RuntimeFiber<void, never>>();
    // Done once the host refused a step or the run was decided: a held call or a wait for answers
    // stops waiting then.
    const stopSignal = Effect.runSync(Deferred.make<void>());
    const signalStop = () => Effect.runSync(Deferred.succeed(stopSignal, undefined));
    /** Decides the run: no held call goes through from here, whatever the hook answers later. */
    const close = () => {
      closed = true;
      signalStop();
    };
    const heldCall = (message: string) =>
      Object.assign(new Error(message), { code: commitRefusedCode });
    const refused = (name: string) =>
      heldCall(`The host refused the commit step ${name}, so this call did not run`);
    /** Why no held call may go now: the run was decided, or the host refused a step. */
    const stopped = () =>
      closed
        ? heldCall("The run ended before the host let this call through, so it did not run")
        : refusal === undefined
          ? undefined
          : refused(refusal.name);
    const unlessStopped = Effect.suspend(() => {
      const stop = stopped();
      return stop === undefined ? Effect.void : Effect.fail(stop);
    });
    /**
     * Waits for `answers`, or until the host refused a step, even a later one, or the run was
     * decided. With every answer already in, it waits for nothing, so the call goes on at once.
     */
    const awaitAnswers = (answers: readonly Deferred.Deferred<void, Error>[]) => {
      const all = Effect.forEach(answers, (answer) => Deferred.await(answer), { discard: true });
      return answers.every((answer) => Effect.runSync(Deferred.isDone(answer)))
        ? all
        : Effect.raceFirst(all, Deferred.await(stopSignal));
    };
    // A call waits for every step entered before it, so a step accepted after an earlier one the
    // host still decides on never lets a click through ahead of that answer. It counts as out from
    // its request on: its task starts as the request arrives, before the next message is read.
    const hold: CommitHold | undefined =
      commit === undefined
        ? undefined
        : (call) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                siteCalls += 1;
                siteCallCame = true;
                return steps.map((step) => step.answer);
              }),
              (answers) =>
                unlessStopped.pipe(
                  Effect.zipRight(awaitAnswers(answers)),
                  // An answer can come after the run was decided or a later step was refused, and
                  // neither lets the call through.
                  Effect.zipRight(unlessStopped),
                  Effect.zipRight(call),
                ),
              () =>
                Effect.sync(() => {
                  siteCalls -= 1;
                }),
            );
    /**
     * Records the host's refusal of `step`, unless the run was decided or it refused another step
     * first. Every call after the first step the host has not accepted waited for that step, so
     * the run reports the journal from there.
     */
    const refuse = (step: EnteredStep) => {
      if (refusal !== undefined || closed) return;
      const stop = steps.find((entered) => !entered.accepted) ?? step;
      refusal = { name: step.name, journal: stoppedAt(stop) };
      signalStop();
    };
    /** Records a step the update `marked` entered, which `before` did not have. */
    const enter = (
      name: string,
      before: LocalOperationJournal,
      marked: LocalOperationJournal,
      rewinds: boolean,
    ) => {
      const answer = Effect.runSync(Deferred.make<void, Error>());
      const step: EnteredStep = { name, before, marked, rewinds, answer, accepted: false };
      steps.push(step);
      return step;
    };
    /** Refuses `step` without asking the host's hook. */
    const refuseUnasked = (step: EnteredStep) => {
      refuse(step);
      Effect.runSync(Deferred.fail(step.answer, refused(step.name)));
    };
    /** Asks the host's commit hook about a step the script just entered, before its next call. */
    const askCommit = (
      hook: NonNullable<OperationHooks["commit"]>,
      entered: EnteredCommit,
      step: EnteredStep,
    ) => {
      answering.add(
        Effect.runFork(
          // A hook that throws as it is called refuses, as one that fails does.
          Effect.suspend(() => hook(entered)).pipe(
            Effect.exit,
            Effect.flatMap((exit) => {
              if (Exit.isSuccess(exit)) {
                if (!closed) step.accepted = true;
                return Deferred.succeed(step.answer, undefined);
              }
              // A hook that fails, dies or ends interrupted refuses the step while the run is open.
              refuse(step);
              return Deferred.fail(step.answer, refused(step.name));
            }),
            Effect.asVoid,
          ),
        ),
      );
    };
    /**
     * With a commit hook, what a journal update says about commit steps. A step it entered goes
     * to the hook, or is refused unasked when its report fails the check the child should have
     * made. A step it marks without entering it, as from a child that could not send that
     * entering, is refused unasked before the next call is read.
     */
    const heard = (
      hook: NonNullable<OperationHooks["commit"]>,
      message: Extract<LocalOperationMessage, { kind: "journal" | "error" | "result" }>,
      before: LocalOperationJournal,
    ) => {
      // Once refused or decided, the run is over: no later step is offered.
      if (refusal !== undefined || closed) return;
      const entered = message.kind === "journal" ? message.entered : undefined;
      for (const mark of current.commits) {
        const was = before.commits.find((known) => known.name === mark.name)?.state;
        if (mark.state === "not_sent" || (was !== undefined && was !== "not_sent")) continue;
        if (mark.name === entered?.name) continue;
        // The host can't tell when the child marked it, so the step reads as before it only when
        // no call that can reach the site came at all.
        refuseUnasked(enter(mark.name, before, current, !siteCallCame));
      }
      if (entered === undefined || refusal !== undefined) return;
      // The child sends this update as it enters the step, so a call is out then when the host
      // still has it or the child still awaits its answer.
      const callOut = siteCalls !== 0 || entered.outstanding === true;
      const step = enter(entered.name, before, current, !callOut);
      const report = entered.report === undefined ? undefined : commitReportValue(entered.report);
      if (report !== undefined && "refused" in report) return refuseUnasked(step);
      const { name } = entered;
      askCommit(
        hook,
        report === undefined ? { name, callOut } : { name, report: report.value, callOut },
        step,
      );
    };
    const listener = (raw: unknown) => {
      if (finished) return;
      const decoded = Effect.runSync(decodeMessage(raw).pipe(Effect.either));
      if (decoded._tag === "Left") {
        finished = true;
        Effect.runSync(Deferred.fail(completed, decoded.left));
        return;
      }
      const message = decoded.right;
      if (message.kind === "journal" || message.kind === "error" || message.kind === "result") {
        const before = current;
        current = operationJournal(message);
        if (commit !== undefined) heard(commit, message, before);
      }
      if (message.kind === "journal") return;
      if (message.kind === "result" || message.kind === "error" || message.kind === "cancel") {
        if (message.kind !== "cancel") finished = true;
        handleTerminalMessage(message, completed, pending);
        return;
      }
      if (pending.has(message.id)) {
        Effect.runSync(Deferred.fail(completed, new Error("Duplicate local operation request")));
        return;
      }
      const task = handleRequest(options, deadline, message, cardHandles, hold).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit))
            return sendToChild(process, { kind: "reply", id: message.id, value: exit.value });
          const error = localError(Cause.squash(exit.cause));
          const code = failureCode(error);
          return sendToChild(process, {
            kind: "failure",
            id: message.id,
            error: error.message,
            ...(code === undefined ? {} : { code }),
          });
        }),
        Effect.catchAll((error) => Deferred.fail(completed, error)),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(message.id);
          }),
        ),
      );
      pending.set(message.id, Effect.runFork(task));
    };
    process.child.on("message", listener);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // However the run ends, even when its caller interrupts it, no held call goes through.
        close();
        process.child.off("message", listener);
        // A commit hook still deciding has no call left to hold.
        if (answering.size > 0)
          yield* Effect.forEach(answering, (fiber) => Fiber.interrupt(fiber), {
            discard: true,
            concurrency: "unbounded",
          });
        yield* Effect.forEach(
          pending.values(),
          (fiber) =>
            Fiber.interrupt(fiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)
                  ? Effect.die(localError(Cause.squash(exit.cause)))
                  : Effect.void,
              ),
            ),
          {
            discard: true,
            concurrency: "unbounded",
          },
        );
      }),
    );
    const completion = Deferred.await(completed);
    const exited = process.result.pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? completion
          : Effect.fail(
              new Error(
                `Local operation child exited ${result.exitCode ?? result.signal}; completion uncertain`,
              ),
            ),
      ),
    );
    return {
      completed: completion.pipe(Effect.raceFirst(exited)),
      pending,
      journal: Effect.sync(() => current),
      /**
       * After the child's result, with a commit hook: waits for the host's answer to every step
       * entered, since a script may return right after entering one, or for its first refusal,
       * then fails `CommitRefused` if the host refused one.
       */
      settled: Effect.raceFirst(
        Effect.suspend(() =>
          Effect.forEach([...steps], (step) => Effect.exit(Deferred.await(step.answer)), {
            discard: true,
          }),
        ),
        // Once the host refused a step, no answer still to come changes the run's outcome.
        Deferred.await(stopSignal),
      ).pipe(
        Effect.zipRight(
          Effect.suspend(() =>
            refusal === undefined ? Effect.void : Effect.fail(refusedRun(refusal, true)),
          ),
        ),
      ),
      /**
       * With a commit hook, once the run's outcome is decided: no held call goes through from
       * here, whatever the hook answers later. Gives the host's refusal, and, while a step's
       * answer was pending, the journal of the first step the host had not accepted
       * (`stoppedAt`), since every call after it was held.
       */
      decided: Effect.sync(() => {
        close();
        const stop = steps.find((step) => !step.accepted);
        return {
          refusal,
          held: refusal === undefined && stop !== undefined ? stoppedAt(stop) : undefined,
        };
      }),
    };
  });

/** A commit step the host refused, and the journal the run reports with it. */
interface CommitRefusal {
  readonly name: string;
  readonly journal: LocalOperationJournal;
}

/** A commit step the script entered, as the host heard it, and whether the host accepted it. */
interface EnteredStep {
  readonly name: string;
  /** The journal just before the script entered the step. */
  readonly before: LocalOperationJournal;
  /** The journal of the update that entered it, with the step marked. */
  readonly marked: LocalOperationJournal;
  /**
   * No call that can reach the site was out when the script entered the step. Every later call
   * waits for its answer, so until the host accepts it the site sees nothing past `before`.
   */
  readonly rewinds: boolean;
  /** Succeeds once the host accepted the step, and fails once it did not. */
  readonly answer: Deferred.Deferred<void, Error>;
  /** The host accepted the step before the run was decided. */
  accepted: boolean;
}

/**
 * The journal of a run that stopped at `step`, with every call after it held: the one from just
 * before it, or, when a call that can reach the site was out as it was entered, the one that
 * entered it, with the step sent.
 */
const stoppedAt = (step: EnteredStep) => (step.rewinds ? step.before : step.marked);

/**
 * The run's failure once the host refused a commit step, whatever the script did next, with the
 * refusal's journal. Its message says whether that journal has the step sent, by an earlier click
 * or a call already out as the script entered it. Only the child's own final report makes it a
 * reported one.
 */
const refusedRun = (refusal: CommitRefusal, reported: boolean) => {
  const state = refusal.journal.commits.find((mark) => mark.name === refusal.name)?.state;
  return new LocalOperationFailure(
    state === undefined || state === "not_sent"
      ? `The host refused the commit step ${refusal.name}, so nothing was sent for it`
      : `The host refused the commit step ${refusal.name}, which an earlier call may have sent`,
    refusal.journal,
    commitRefusedCode,
    undefined,
    undefined,
    { reported, commitRefused: refusal.name },
  );
};

/**
 * `failure` with `held`, the journal of the step whose answer was still pending when the run
 * stopped (`stoppedAt`), when it has one. No call after that step went out, but the child's report
 * no longer says so, so it is not a reported one.
 */
const heldFailure = (failure: LocalOperationFailure, held: LocalOperationJournal | undefined) =>
  held === undefined
    ? failure
    : new LocalOperationFailure(
        failure.message,
        held,
        failure.code,
        failure.tag,
        failure.inputIssues,
        {
          reported: false,
          ...(failure.sessionLoss === undefined ? {} : { sessionLoss: failure.sessionLoss }),
          ...(failure.refusal === undefined ? {} : { refusal: failure.refusal }),
          ...(failure.unapplied === undefined ? {} : { unapplied: failure.unapplied }),
          ...(failure.frame === undefined ? {} : { frame: failure.frame }),
        },
      );

const operationJournal = (
  result: Pick<LocalOperationResult, "effect" | "commits" | "confirmation">,
): LocalOperationJournal => ({
  effect:
    result.effect === "not_started"
      ? "not_sent"
      : result.effect === "may_have_dispatched"
        ? "possible"
        : "verified",
  commits: result.commits,
  ...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
});
const operationOutput = (
  result: LocalOperationResult,
  output: LocalProcessResult,
): LocalOperationOutput => {
  return {
    output: result.output,
    schemas: {
      input: result.inputSchema,
      output: result.outputSchema,
      ...(result.questions === undefined ? {} : { questions: result.questions }),
    },
    stdout: output.stdout,
    stderr: output.stderr,
    ...operationJournal(result),
    ...(result.write === undefined ? {} : { write: result.write }),
    ...(result.inputDecodes === undefined ? {} : { inputDecodes: result.inputDecodes }),
    ...(result.outputDrift === undefined ? {} : { outputDrift: result.outputDrift }),
  };
};

/** Fails the run when its output holds a `$file` the run's files did not collect. */
const checkOutputFiles = (files: RunFiles | undefined, result: LocalOperationResult) =>
  (files === undefined
    ? outputFiles(result.output).length === 0
      ? Effect.void
      : Effect.fail(new FileRefused({ reason: "not_collected" }))
    : files.checkOutput(result.output)
  ).pipe(
    Effect.mapError(
      (refused) =>
        new LocalOperationFailure(refused.message, operationJournal(result), "FileRefused"),
    ),
  );

/** Executes one immutable reviewed snapshot through the original operation runtime, without replay. */
export const runLocalOperation = (
  options: LocalOperationOptions,
): Effect.Effect<LocalOperationOutput, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const timeoutMs = options.timeoutMs ?? 20 * 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(new Error("Local operation timeout must be positive and finite"));
      const deadline = Deadline.after(timeoutMs);
      const staged = yield* stageSources(options);
      const process = yield* createLocalProcess({
        command: globalThis.process.execPath,
        args: [
          fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "./local-operation-child.ts"
                : "./local-operation-child.js",
              import.meta.url,
            ),
          ),
        ],
        cwd: staged.directory,
        environment: options.workspace.environment,
        ipc: true,
      });
      const response = yield* receiveOperation(process, options, deadline);
      const commit = options.hooks?.commit;
      // The started hook counts against the run's time: past its deadline, no script starts.
      if (options.hooks?.started !== undefined)
        yield* options.hooks.started().pipe(
          // A hook that can't be stopped goes on alone, so the deadline fails the run on time.
          Effect.disconnect,
          Effect.raceFirst(
            deadline.awaitExpiry.pipe(
              Effect.zipRight(
                Effect.fail(
                  new LocalOperationFailure(
                    "Local operation deadline expired before its code started",
                    { effect: "not_sent", commits: [] },
                    undefined,
                    undefined,
                    undefined,
                    { reported: false },
                  ),
                ),
              ),
            ),
          ),
        );
      yield* sendToChild(process, {
        kind: "start",
        entrypoint: staged.entrypoint,
        input: options.input,
        ...(options.retainedOutput === undefined ? {} : { retainedOutput: options.retainedOutput }),
        sessionId: options.browser?.sessionId ?? "offline",
        timeoutMs,
        mode: options.mode ?? "run",
        ...(options.validateInput === undefined ? {} : { validateInput: options.validateInput }),
        ...(options.keepDriftedOutput === true ? { keepDriftedOutput: true } : {}),
        ...(options.target === "pureFiles" || options.browser === undefined
          ? { offline: true }
          : {}),
        ...(options.dispatchAtFirstCall === true ? { dispatchAtFirstCall: true } : {}),
        ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
        ...(options.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
        ...(options.files !== undefined ? { files: true } : {}),
        ...(options.list === undefined ? {} : { list: options.list }),
        ...(options.http === undefined || options.mode === "contract"
          ? {}
          : { http: { name: options.http.name, capabilities: options.http.capabilities } }),
        ...(options.signIn !== undefined &&
        options.browser !== undefined &&
        options.mode !== "contract" &&
        options.target !== "pureFiles"
          ? { signIn: true }
          : {}),
        ...(options.cardFill !== undefined &&
        options.browser !== undefined &&
        options.mode !== "contract" &&
        options.target !== "pureFiles"
          ? { cardFill: true }
          : {}),
        ...(commit === undefined ? {} : { commitHook: true }),
      });
      // With a commit hook, a run whose commit step the host refused fails, whatever its script
      // returned after it, and from the deadline on no call the hook held goes through.
      const completed =
        commit === undefined
          ? response.completed
          : response.completed.pipe(Effect.tap(() => response.settled));
      const expired =
        commit === undefined
          ? deadline.awaitExpiry
          : deadline.awaitExpiry.pipe(Effect.zipRight(response.decided), Effect.asVoid);
      const result = yield* completed.pipe(
        Effect.raceFirst(
          expired.pipe(
            Effect.zipRight(
              Effect.fail(
                new Error("Local operation deadline expired; execution was not replayed"),
              ),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            // The run is decided: nothing the commit hook says from here lets a held call through.
            const decision = commit === undefined ? undefined : yield* response.decided;
            const failure =
              decision?.refusal !== undefined
                ? refusedRun(
                    decision.refusal,
                    error instanceof LocalOperationFailure && error.reported,
                  )
                : heldFailure(
                    error instanceof LocalOperationFailure
                      ? error
                      : new LocalOperationFailure(
                          error.message,
                          yield* response.journal,
                          failureCode(error),
                          undefined,
                          undefined,
                          { reported: false },
                        ),
                    decision?.held,
                  );
            yield* process.close;
            const channels = yield* process.result.pipe(Effect.either);
            return yield* Effect.fail(
              Object.assign(
                failure,
                channels._tag === "Right"
                  ? { stdout: channels.right.stdout, stderr: channels.right.stderr }
                  : { cause: channels.left },
              ),
            );
          }),
        ),
      );
      if (commit !== undefined) yield* response.decided;
      // Only a file this run collected may stand in its output; a script cannot name another.
      yield* checkOutputFiles(options.files, result).pipe(
        Effect.tapError(() => process.close),
      );
      yield* process.close;
      const output = yield* process.result.pipe(
        Effect.raceFirst(
          deadline.awaitExpiry.pipe(
            Effect.zipRight(
              Effect.fail(new Error("Local operation child did not exit after result")),
            ),
          ),
        ),
      );
      return operationOutput(result, output);
    }),
  );
