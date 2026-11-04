// Failure modes covered: a refusal that reports unsent a step entered while its click was already
// out, as only the child or only the host knows, a call held on an earlier step's yes that runs
// after a later step was refused or hangs until that answer, a refused run that waits for an
// earlier answer, a held call that runs once the run's deadline, the child's error or its return
// decided it, a held step that reads sent after the run stopped, a later step that reads sent
// although its calls were held, a refusal missed because the script returned right after
// entering, a commit hook that throws as it is called or ends interrupted, and a child that marks
// a step, or passes a report, without the host's check.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import type { EnteredCommit, OperationHooks } from "../../src/runtime/operation-hooks.js";

const entrypoint = "operation/src/tool.mjs";

/** A write script whose body runs between its imports and its return. */
const write = (body: string, commits: readonly string[] = ["place-order"]) =>
  `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    name: "place_order",
    input: Schema.Struct({}),
    output: Schema.Struct({ placed: Schema.Boolean }),
    write: { confirmation: "readback", commits: ${JSON.stringify(commits)} },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    const call = (code) => kernel.browsers.playwright.execute(sessionId, { code, timeout_sec: 5 });
${body}
  },
);`;

/** The checkout a script reports with its commit step. */
const report = JSON.stringify({ button: "Pay 204 on delivery", total_minor: 20_400 });

/**
 * A browser that records each call by the word its code returns. It answers after `delayMs`, or
 * at once, in the same step, without one.
 */
const recordingBrowser = (delayMs?: number) => {
  const calls: string[] = [];
  const answer = (code: string) =>
    Effect.sync(() => {
      calls.push(/return '(\w+)';/u.exec(code)?.[1] ?? code);
      return { success: true, result: null };
    });
  return {
    calls,
    browser: {
      sessionId: "local",
      executeResponse: (code: string) =>
        delayMs === undefined
          ? answer(code)
          : Effect.sleep(delayMs).pipe(Effect.zipRight(answer(code))),
    },
  };
};

const run = (source: string, browser: object, hooks?: OperationHooks, timeoutMs?: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: {},
          browser: browser as never,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(hooks === undefined ? {} : { hooks }),
        }).pipe(Effect.either);
      }),
    ),
  );

const refused = (reason: string) => Effect.fail(new Error(reason));
const refuseAll: OperationHooks = { commit: () => refused("The cart changed") };

/** A child that sends the host a journal update its runtime never would. */
const forged = (fields: object) => `    process.send(${JSON.stringify({
  kind: "journal",
  effect: "may_have_dispatched",
  commits: [{ name: "place-order", state: "sent" }],
  ...fields,
})});`;

it("keeps a refused step sent when its click was out as the script entered it", async () => {
  const site = recordingBrowser(50);
  const result = await run(
    write(`    const clicked = call("return 'click';");
    enteringCommit("place-order", ${report});
    await clicked;
    verified();
    return { placed: true };`),
    site.browser,
    refuseAll,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "sent" }] },
    },
  });
  expect(result._tag === "Left" ? result.left.message : "").not.toContain("nothing was sent");
  expect(site.calls).toEqual(["click"]);
}, 30_000);

it("keeps a refused step sent when the host answered its click before hearing of it", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`    const clicked = call("return 'click';");
    // The host answers the click while the child is busy, so only the child knows it was out.
    const until = Date.now() + 500;
    while (Date.now() < until) {}
    enteringCommit("place-order", ${report});
    await clicked;
    return { placed: true };`),
    site.browser,
    refuseAll,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "CommitRefused", journal: { commits: [{ name: "place-order", state: "sent" }] } },
  });
  expect(site.calls).toEqual(["click"]);
}, 30_000);

it("refuses a call held on an earlier step's yes once a later step was refused", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(
      `    enteringCommit("save-address");
    const clicked = call("return 'click';");
    enteringCommit("place-order");
    await clicked.catch(() => undefined);
    return { placed: false };`,
      ["save-address", "place-order"],
    ),
    site.browser,
    {
      // The earlier step's yes comes after the later step's refusal.
      commit: (mark) =>
        mark.name === "save-address" ? Effect.sleep(300) : refused("The total changed"),
    },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      message: expect.stringContaining("nothing was sent"),
      journal: {
        commits: [
          { name: "save-address", state: "not_sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
    },
  });
  expect(site.calls).toEqual([]);
}, 30_000);

/**
 * Script lines that start a process outside the child's group that keeps the child's output open
 * until `until`, a time in milliseconds since the epoch the child computes: the host's stop of the
 * child then waits for it, so the run's teardown comes well after its decision.
 */
const holdOutputUntil = (until: string) =>
  `    const { spawn } = await import("node:child_process");
    const holdMs = Math.max(0, ${until} - Date.now());
    spawn(process.execPath, ["-e", "setTimeout(() => {}, " + holdMs + ")"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();`;

it("lets no held call through after the deadline, and reports its step unsent", async () => {
  const site = recordingBrowser();
  const timeoutMs = 3_000;
  const begun = Date.now();
  const result = await run(
    write(`${holdOutputUntil(String(begun + timeoutMs + 2_000))}
    enteringCommit("place-order", ${report});
    await call("return 'click';");
    verified();
    return { placed: true };`),
    site.browser,
    // The host's yes comes after the deadline decided the run, while its stop still waits.
    { commit: () => Effect.suspend(() => Effect.sleep(begun + timeoutMs + 500 - Date.now())) },
    timeoutMs,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("deadline expired"),
      reported: false,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(site.calls).toEqual([]);
}, 30_000);

it("lets no held call through after the child's error, and reports its step unsent", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`${holdOutputUntil("Date.now() + 2500")}
    enteringCommit("place-order", ${report});
    call("return 'click';").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    throw new Error("The total was missing");`),
    site.browser,
    // The host's yes comes after the child's error decided the run, while its stop still waits.
    { commit: () => Effect.sleep(1_000) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: "The total was missing",
      reported: false,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(site.calls).toEqual([]);
}, 30_000);

it("lets no held call through after the child returned with it out", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`${holdOutputUntil("Date.now() + 2500")}
    enteringCommit("place-order", ${report});
    call("return 'click';").catch(() => undefined);
    return { placed: true };`),
    site.browser,
    { commit: () => Effect.sleep(1_000) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("returned while host requests were pending"),
      reported: false,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(site.calls).toEqual([]);
}, 30_000);

it("reports a pending step as entered when a call was out then and the run stops", async () => {
  const result = await run(
    write(
      `    call("return 'click';").catch(() => undefined);
    enteringCommit("save-address");
    enteringCommit("place-order");
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error("The total was missing");`,
      ["save-address", "place-order"],
    ),
    recordingBrowser(300).browser,
    { commit: (mark) => (mark.name === "save-address" ? Effect.sleep(5_000) : Effect.void) },
  );
  // The click may have sent the first step, but every call after it was held on its answer.
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: "The total was missing",
      reported: false,
      journal: {
        commits: [
          { name: "save-address", state: "sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
    },
  });
}, 30_000);

it("keeps a step sent when a click the child gave up on still runs as it is entered", async () => {
  const calls: string[] = [];
  const browser = {
    sessionId: "local",
    // A click already on its way, which stopping can't undo.
    executeResponse: () =>
      Effect.uninterruptible(
        Effect.sleep(400).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              calls.push("click");
              return { success: true, result: null };
            }),
          ),
        ),
      ),
  };
  const result = await run(
    write(`    // The child gives up on the click after 50 ms, so only the host knows it is out.
    await kernel.browsers.playwright
      .execute(sessionId, { code: "return 'click';", timeout_sec: 5 }, { timeout: 50 })
      .catch(() => undefined);
    enteringCommit("place-order", ${report});
    return { placed: false };`),
    browser,
    refuseAll,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: { journal: { commits: [{ name: "place-order", state: "sent" }] } },
  });
  expect(calls).toEqual(["click"]);
}, 30_000);

/** A commit hook whose answer for the first step comes long after it refuses the second. */
const slowFirstAnswer: OperationHooks = {
  commit: (mark) =>
    mark.name === "save-address" ? Effect.sleep(60_000) : refused("The total changed"),
};

it("refuses a call held on an earlier pending step once a later step is refused", async () => {
  const site = recordingBrowser();
  const begun = Date.now();
  const result = await run(
    write(
      `    enteringCommit("save-address");
    const clicked = call("return 'click';");
    enteringCommit("place-order");
    await clicked.catch(() => undefined);
    return { placed: false };`,
      ["save-address", "place-order"],
    ),
    site.browser,
    slowFirstAnswer,
    20_000,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      reported: true,
      journal: {
        commits: [
          { name: "save-address", state: "not_sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
    },
  });
  expect(Date.now() - begun).toBeLessThan(8_000);
  expect(site.calls).toEqual([]);
}, 30_000);

it("fails a refused run without waiting for an earlier step's answer", async () => {
  const begun = Date.now();
  const result = await run(
    write(
      `    enteringCommit("save-address");
    enteringCommit("place-order");
    return { placed: false };`,
      ["save-address", "place-order"],
    ),
    recordingBrowser().browser,
    slowFirstAnswer,
    20_000,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "CommitRefused", commitRefused: "place-order", reported: true },
  });
  expect(Date.now() - begun).toBeLessThan(8_000);
}, 30_000);

it("refuses a step whose commit hook ends interrupted, though the script swallows it", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`    enteringCommit("place-order", ${report});
    await call("return 'click';").catch(() => undefined);
    return { placed: true };`),
    site.browser,
    { commit: () => Effect.interrupt },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(site.calls).toEqual([]);
}, 30_000);

it("fails a run that returned right after entering a step the host then refused", async () => {
  const result = await run(
    write(`    enteringCommit("place-order", ${report});
    return { placed: false };`),
    recordingBrowser().browser,
    { commit: () => Effect.sleep(300).pipe(Effect.zipRight(refused("The total changed"))) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      reported: true,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
}, 30_000);

it("refuses a step whose commit hook throws as it is called, and keeps the host up", async () => {
  const site = recordingBrowser();
  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);
  process.prependListener("uncaughtException", record);
  try {
    const result = await run(
      write(`    enteringCommit("place-order", ${report});
    await call("return 'click';");
    return { placed: true };`),
      site.browser,
      {
        commit: () => {
          throw new Error("The hook broke");
        },
      },
      10_000,
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        code: "CommitRefused",
        commitRefused: "place-order",
        journal: { commits: [{ name: "place-order", state: "not_sent" }] },
      },
    });
    expect(site.calls).toEqual([]);
    expect(uncaught).toEqual([]);
  } finally {
    process.off("uncaughtException", record);
  }
}, 30_000);

it("refuses a step the child marked without entering it, before its next call", async () => {
  const site = recordingBrowser();
  const asked: EnteredCommit[] = [];
  const result = await run(
    write(`${forged({})}
    await call("return 'click';").catch(() => undefined);
    return { placed: false };`),
    site.browser,
    { commit: (mark) => Effect.sync(() => asked.push(mark)) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(asked).toEqual([]);
  expect(site.calls).toEqual([]);
}, 30_000);

it("keeps an unannounced step sent once a call that can reach the site came first", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`    await call("return 'look';");
${forged({})}
    await call("return 'click';").catch(() => undefined);
    return { placed: false };`),
    site.browser,
    { commit: () => Effect.void },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "sent" }] },
    },
  });
  expect(site.calls).toEqual(["look"]);
}, 30_000);

it("refuses a step whose report the host can't check, without asking its hook", async () => {
  const site = recordingBrowser();
  const asked: EnteredCommit[] = [];
  // A report its own check would refuse, which the child passes on: JSON has no big integers.
  const unchecked = forged({ entered: { name: "place-order", report: { total: "BIG" } } });
  const result = await run(
    write(`${unchecked.replace('"BIG"', "1n")}
    await call("return 'click';").catch(() => undefined);
    return { placed: false };`),
    site.browser,
    { commit: (mark) => Effect.sync(() => asked.push(mark)) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(asked).toEqual([]);
  expect(site.calls).toEqual([]);
}, 30_000);
