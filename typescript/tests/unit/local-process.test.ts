// Failure modes covered: a stop that fails when macOS refuses to kill a process group whose
// processes all exited and wait to be reaped (EPERM), a refused kill that lets a stop pass while
// a process of the group still runs, the leader or one it started, and a group check (signal 0)
// answering EPERM that a stop reads as the group gone, or as one it can never confirm.
import { Cause, Effect, Exit } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalProcess } from "../../src/execution/local-process.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `process.kill` refusing to kill any process group, as macOS does for a group of zombies. A
 * check with signal 0 asks the real group, or answers with `check` when given, which hears how
 * many checks came before it.
 */
const refuseGroupKills = (check?: (before: number) => "EPERM" | "ESRCH") => {
  const kill = process.kill.bind(process);
  let checks = 0;
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (typeof pid === "number" && pid < 0 && (signal === "SIGKILL" || check !== undefined)) {
      const code = signal === "SIGKILL" || check === undefined ? "EPERM" : check(checks++);
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return kill(pid, signal);
  });
  return { spy, checks: () => checks };
};

const node = (script: string) =>
  createLocalProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    environment: {},
  });

/** Stops the process `script` starts, after `settle`, with the group's kill refused. */
const stopRefused = async (
  script: string,
  settle: "exited" | "running",
  check?: (before: number) => "EPERM" | "ESRCH",
) => {
  const refused = refuseGroupKills(check);
  let pid: number | undefined;
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* node(script);
        pid = child.child.pid;
        if (settle === "exited") yield* child.result;
        yield* child.close;
        return "stopped";
      }),
    ),
  );
  refused.spy.mockRestore();
  return { exit, pid, checks: refused.checks() };
};

it("stops a process that already exited when its group's kill is refused", async () => {
  const { exit } = await stopRefused("", "exited");
  expect(exit).toEqual(Exit.succeed("stopped"));
});

it("reports a stop it can't confirm when the refused group still runs", async () => {
  const { exit, pid } = await stopRefused("setInterval(() => undefined, 1000)", "running");
  if (pid !== undefined) process.kill(-pid, "SIGKILL");
  if (Exit.isSuccess(exit)) throw new Error("The stop passed while the process ran");
  expect(String(Cause.squash(exit.cause))).toContain("Local process stop is unconfirmed");
}, 20_000);

it("reports a stop it can't confirm while a process the leader started still runs", async () => {
  // The leader exits at once; the process it started stays in its group, holding no output.
  const { exit, pid } = await stopRefused(
    `require("node:child_process")
      .spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" })
      .unref();`,
    "exited",
  );
  if (pid !== undefined) process.kill(-pid, "SIGKILL");
  if (Exit.isSuccess(exit)) throw new Error("The stop passed while its group ran");
  expect(String(Cause.squash(exit.cause))).toContain("Local process stop is unconfirmed");
}, 20_000);

it("stops once the group check finds the group gone after it answered EPERM", async () => {
  // The group's processes wait to be reaped for the first checks, then are gone.
  const { exit, checks } = await stopRefused("", "exited", (before) =>
    before < 3 ? "EPERM" : "ESRCH",
  );
  expect(exit).toEqual(Exit.succeed("stopped"));
  expect(checks).toBe(4);
});

it("reports a stop it can't confirm while the group check keeps answering EPERM", async () => {
  const { exit, checks } = await stopRefused("", "exited", () => "EPERM");
  if (Exit.isSuccess(exit)) throw new Error("The stop passed while its group was still there");
  expect(String(Cause.squash(exit.cause))).toContain("Local process stop is unconfirmed");
  expect(checks).toBeGreaterThan(3);
}, 20_000);
