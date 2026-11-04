import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcess } from "node:child_process";
import { Cause, Deferred, Effect, Exit, Fiber, type Scope } from "effect";
import { localError, localOutputLimit } from "./local-path.js";

export interface LocalProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface LocalProcess {
  readonly child: ChildProcess;
  readonly result: Effect.Effect<LocalProcessResult, Error>;
  readonly close: Effect.Effect<void, Error>;
}

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

/** Whether the process group `pid` leads is gone: signal 0 checks for it without signalling. */
const groupGone = (pid: number) =>
  Effect.try({
    try: () => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (cause) {
        // EPERM: the group still holds processes, maybe exited ones that wait to be reaped.
        const code = errorCode(cause);
        if (code === "ESRCH") return true;
        if (code === "EPERM") return false;
        throw cause;
      }
    },
    catch: localError,
  });

/** Waits until the process group `pid` leads is gone, checking every 25 ms. */
const awaitGroupGone = (pid: number): Effect.Effect<void, Error> =>
  groupGone(pid).pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.sleep(25).pipe(Effect.zipRight(awaitGroupGone(pid))),
    ),
  );

const signalGroup = (child: ChildProcess) =>
  Effect.suspend(() => {
    const pid = child.pid;
    if (pid === undefined) return Effect.void;
    try {
      process.kill(-pid, "SIGKILL");
      return Effect.void;
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ESRCH") return Effect.void;
      if (code !== "EPERM") return Effect.fail(localError(cause));
    }
    // macOS answers EPERM for a group whose processes all exited and wait to be reaped. The stop
    // then passes only once the group is gone, so a group that still runs, its leader or a
    // process it started, is a stop it can't confirm, never one that passed.
    return awaitGroupGone(pid);
  });

/** Each command owns a process group. Local execution is caller compute, not an OS sandbox. */
export const createLocalProcess = (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly ipc?: boolean;
  readonly outputLimit?: number;
}): Effect.Effect<LocalProcess, Error, Scope.Scope> =>
  Effect.gen(function* () {
    if (process.platform === "win32")
      return yield* Effect.fail(new Error("Local process-group execution requires macOS or Linux"));
    const ended = yield* Deferred.make<LocalProcessResult, Error>();
    const child = yield* Effect.try({
      try: () =>
        spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: { ...options.environment },
          detached: true,
          serialization: "advanced",
          stdio: options.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        }),
      catch: localError,
    });
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const lengths = { stdout: 0, stderr: 0 };
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let closeFiber: Fiber.RuntimeFiber<void, Error> | undefined;
    const close = Effect.suspend(() => {
      closeFiber ??= Effect.runFork(
        signalGroup(child).pipe(
          Effect.zipRight(Deferred.await(ended).pipe(Effect.either, Effect.asVoid)),
          Effect.timeoutFail({
            duration: 5_000,
            onTimeout: () => new Error("Local process stop is unconfirmed"),
          }),
          Effect.interruptible,
        ),
      );
      return Fiber.join(closeFiber);
    }).pipe(Effect.uninterruptible);
    const capture = (channel: "stdout" | "stderr", bytes: Buffer) => {
      lengths[channel] += bytes.length;
      if (lengths[channel] > (options.outputLimit ?? localOutputLimit)) {
        failure ??= new Error(`Local process ${channel} exceeds output limit`);
        Effect.runCallback(close, {
          onExit: (exit) => {
            if (Exit.isFailure(exit))
              Effect.runSync(Deferred.fail(ended, localError(Cause.squash(exit.cause))));
          },
        });
        return;
      }
      const text = decoders[channel].write(bytes);
      if (channel === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (bytes: Buffer) => capture("stdout", bytes));
    child.stderr?.on("data", (bytes: Buffer) => capture("stderr", bytes));
    child.on("error", (cause) => {
      failure = localError(cause);
    });
    child.once("close", (exitCode, signal) => {
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      Effect.runSync(
        failure === undefined
          ? Deferred.succeed(ended, { exitCode, signal, stdout, stderr })
          : Deferred.fail(ended, failure),
      );
    });
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    return { child, result: Deferred.await(ended), close };
  }).pipe(Effect.uninterruptible);
