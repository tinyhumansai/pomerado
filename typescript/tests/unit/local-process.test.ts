// Failure modes covered: a stop that fails when macOS refuses to signal a process group whose
// processes all exited and wait to be reaped (EPERM), and a refused signal that lets a stop pass
// while the process still runs.
import { Cause, Effect, Exit } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalProcess } from "../../src/execution/local-process.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** `process.kill` refusing every process-group signal, as macOS does for a group of zombies. */
const refuseGroupSignals = () => {
  const kill = process.kill.bind(process);
  return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (typeof pid === "number" && pid < 0)
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(pid, signal);
  });
};

const node = (script: string) =>
  createLocalProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    environment: {},
  });

it("stops a process that already exited when its group's signal is refused", async () => {
  refuseGroupSignals();
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* node("");
        yield* child.result;
        yield* child.close;
        return "stopped";
      }),
    ),
  );
  expect(exit).toEqual(Exit.succeed("stopped"));
});

it("reports a stop it can't confirm when the refused group still runs", async () => {
  const refused = refuseGroupSignals();
  let pid: number | undefined;
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* node("setInterval(() => undefined, 1000)");
        pid = child.child.pid;
        yield* child.close;
      }),
    ),
  );
  refused.mockRestore();
  if (pid !== undefined) process.kill(-pid, "SIGKILL");
  if (Exit.isSuccess(exit)) throw new Error("The stop passed while the process ran");
  expect(String(Cause.squash(exit.cause))).toContain("Local process stop is unconfirmed");
}, 20_000);
