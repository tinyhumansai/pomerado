// Failure modes covered: a click that runs before the host's commit hook accepts its commit step,
// a refused commit whose click or later calls still reach the browser, a later step's yes that lets
// a click pass an earlier step's refusal, a refused step that still reads sent, a refusal that
// says nothing was sent for a step an earlier click sent, a run that succeeds past a refusal, a
// commit report lost on the way to the host, a report that is not JSON, is too large or nests too
// deep still marked, a step marked although its entering update can't reach the host, a run
// without hooks that changes, a started hook that fires late or twice or outlasts the run's
// deadline, even one that can't be stopped, a progress hook that misses a browser call, stops the
// run when the page can't be read or fails a call that ran when it breaks, a progress read that
// outlasts its browser call, and an operation that sees the host's own environment.
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { commitReportValue } from "../../src/runtime/commit-report.js";
import {
  commitReportLimitBytes,
  pageProgressCode,
  type EnteredCommit,
  type OperationHooks,
} from "../../src/runtime/operation-hooks.js";

const entrypoint = "operation/src/tool.mjs";

/** A write script whose body runs between its imports and its return. */
const write = (body: string) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    name: "place_order",
    input: Schema.Struct({}),
    output: Schema.Struct({ placed: Schema.Boolean }),
    write: { confirmation: "readback", commits: ["place-order"] },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    const call = (code) => kernel.browsers.playwright.execute(sessionId, { code, timeout_sec: 5 });
${body}
  },
);`;

/** The checkout a script reports with its commit step. */
const report = { button: "Pay 204 on delivery", chosen: ["Cash on delivery"], total_minor: 20_400 };

/** Marks the step with the checkout, clicks, confirms and returns. */
const placing = write(`    enteringCommit("place-order", ${JSON.stringify(report)});
    const clicked = await call("return 'click';");
    if (!clicked.success) throw new Error("The click failed");
    verified();
    return { placed: true };`);

/**
 * A call's name: `progress` for the host's progress read, else the word a script's call returns,
 * since the runtime wraps the script's code.
 */
const named = (code: string) =>
  code === pageProgressCode ? "progress" : (/return '(\w+)';/u.exec(code)?.[1] ?? code);

/** A browser that records each call and answers the progress read with `pages()`. */
const recordingBrowser = (pages: () => unknown = () => [["https://shop.example/", ["Shop", 4, 7]]]) => {
  const calls: { readonly name: string; readonly at: number }[] = [];
  return {
    calls,
    /** The script's own calls. */
    scriptCalls: () => calls.filter((call) => call.name !== "progress"),
    browser: {
      sessionId: "local",
      executeResponse: (code: string) =>
        Effect.sync(() => {
          calls.push({ name: named(code), at: Date.now() });
          return code === pageProgressCode
            ? { success: true, result: pages() }
            : { success: true, result: null };
        }),
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

it("holds the click after a commit step until the host's commit hook accepts it, with the script's report", async () => {
  const site = recordingBrowser();
  const entered: EnteredCommit[] = [];
  let acceptedAt = 0;
  const result = await run(placing, site.browser, {
    commit: (mark) =>
      Effect.gen(function* () {
        entered.push(mark);
        yield* Effect.sleep(300);
        acceptedAt = Date.now();
      }),
  });
  expect(result).toMatchObject({
    _tag: "Right",
    right: { output: { placed: true }, commits: [{ name: "place-order", state: "confirmed" }] },
  });
  expect(entered).toEqual([{ name: "place-order", report, callOut: false }]);
  const click = site.scriptCalls().find((call) => call.name === "click");
  expect(click?.at).toBeGreaterThanOrEqual(acceptedAt);
}, 30_000);

it("sends nothing once the host refuses a commit step: the click and every later call are refused, and the run fails with the step unsent", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`    enteringCommit("place-order", ${JSON.stringify(report)});
    let refused = false;
    await call("return 'click';").catch(() => { refused = true; });
    await call("return 'after';").catch(() => undefined);
    // A script that swallows the refusal still fails: the host never ran its click.
    verified();
    return { placed: refused };`),
    site.browser,
    { commit: () => Effect.fail(new Error("The cart changed since the yes")) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      name: "LocalOperationFailure",
      message: "The host refused the commit step place-order, so nothing was sent for it",
      code: "CommitRefused",
      commitRefused: "place-order",
      reported: true,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(site.scriptCalls()).toEqual([]);
}, 30_000);

it("holds a call until the host answered every step entered before it, so a later step's yes can't pass a refusal", async () => {
  const site = recordingBrowser();
  const result = await run(
    `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    name: "place_order",
    input: Schema.Struct({}),
    output: Schema.Struct({ placed: Schema.Boolean }),
    write: { confirmation: "readback", commits: ["save-address", "place-order"] },
  },
  async ({ kernel, sessionId, enteringCommit }) => {
    enteringCommit("save-address");
    enteringCommit("place-order");
    await kernel.browsers.playwright.execute(sessionId, { code: "return 'click';", timeout_sec: 5 });
    return { placed: true };
  },
);`,
    site.browser,
    {
      // The first step's answer comes last, and refuses.
      commit: (mark) =>
        mark.name === "save-address"
          ? Effect.sleep(300).pipe(Effect.zipRight(Effect.fail(new Error("Address changed"))))
          : Effect.void,
    },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "save-address",
      journal: {
        commits: [
          { name: "save-address", state: "not_sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
    },
  });
  expect(site.scriptCalls()).toEqual([]);
}, 30_000);

it("keeps a step sent when the host refuses it again after an accepted click", async () => {
  const site = recordingBrowser();
  let answers = 0;
  const result = await run(
    write(`    enteringCommit("place-order", ${JSON.stringify(report)});
    await call("return 'first';");
    enteringCommit("place-order", ${JSON.stringify(report)});
    await call("return 'second';");
    return { placed: true };`),
    site.browser,
    {
      commit: () =>
        answers++ === 0 ? Effect.void : Effect.fail(new Error("Only one press is granted")),
    },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      // The first click already sent the step, so the refusal can't say nothing was.
      message: "The host refused the commit step place-order, which an earlier call may have sent",
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "sent" }] },
    },
  });
  expect(site.scriptCalls().map((call) => call.name)).toEqual(["first"]);
}, 30_000);

/** A report of `depth` arrays, one inside the next. */
const nested = (depth: number) => {
  let value: unknown = 0;
  for (let level = 0; level < depth; level++) value = [value];
  return value;
};

it("takes a commit report nested 64 levels deep and refuses one level more", () => {
  expect(commitReportValue(nested(64))).toEqual({ value: nested(64) });
  expect(commitReportValue(nested(65))).toEqual({
    refused: "A commit step's report must nest at most 64 levels deep",
  });
});

it("fails before marking a step whose report is not JSON, too large or too deep", async () => {
  for (const passed of [
    `{ total: 1n }`,
    `(() => { const loop = {}; loop.self = loop; return loop; })()`,
    `{ text: "x".repeat(${commitReportLimitBytes}) }`,
    // JSON copes with this depth, but the depth cap refuses it before the step is marked.
    `(() => { let deep = 0; for (let i = 0; i < 4500; i++) deep = [deep]; return deep; })()`,
  ]) {
    const site = recordingBrowser();
    const entered: EnteredCommit[] = [];
    const result = await run(
      write(`    enteringCommit("place-order", ${passed});
    await call("return 'click';");
    return { placed: true };`),
      site.browser,
      { commit: (mark) => Effect.sync(() => entered.push(mark)) },
    );
    expect(result, passed).toMatchObject({
      _tag: "Left",
      left: { journal: { commits: [{ name: "place-order", state: "not_sent" }] } },
    });
    expect(entered, passed).toEqual([]);
    expect(site.scriptCalls(), passed).toEqual([]);
  }
}, 60_000);

it("fails before marking a step whose entering update the host's channel can't carry", async () => {
  const site = recordingBrowser();
  const entered: EnteredCommit[] = [];
  const result = await run(
    write(`    // The report keeps within its caps, but the step's name makes the update too large.
    enteringCommit("place-order-" + "x".repeat(600000), ${JSON.stringify(report)});
    await call("return 'click';");
    return { placed: true };`),
    site.browser,
    { commit: (mark) => Effect.sync(() => entered.push(mark)) },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("can't reach the host"),
      reported: true,
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(entered).toEqual([]);
  expect(site.scriptCalls()).toEqual([]);
}, 30_000);

it("runs a commit step as before when the host gives no commit hook", async () => {
  const site = recordingBrowser();
  const result = await run(placing, site.browser);
  expect(result).toMatchObject({ _tag: "Right", right: { output: { placed: true } } });
  expect(site.calls.map((call) => call.name)).toEqual(["click"]);
}, 30_000);

it("calls started once, before the operation's first browser call", async () => {
  const site = recordingBrowser();
  const started: number[] = [];
  const result = await run(placing, site.browser, {
    started: () => Effect.sync(() => started.push(Date.now())),
  });
  expect(result).toMatchObject({ _tag: "Right" });
  expect(started).toHaveLength(1);
  expect(started[0]).toBeLessThanOrEqual(site.scriptCalls()[0]?.at ?? 0);
}, 30_000);

it("fails a run at its deadline when the started hook outlasts it, with nothing run", async () => {
  const site = recordingBrowser();
  const begun = Date.now();
  const result = await run(placing, site.browser, { started: () => Effect.sleep(10_000) }, 1_500);
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("deadline expired"),
      journal: { effect: "not_sent", commits: [] },
    },
  });
  expect(Date.now() - begun).toBeLessThan(6_000);
  expect(site.calls).toEqual([]);
}, 30_000);

it("fails a run on time at its deadline when the started hook can't be stopped", async () => {
  const site = recordingBrowser();
  const begun = Date.now();
  const result = await run(
    placing,
    site.browser,
    { started: () => Effect.uninterruptible(Effect.sleep(10_000)) },
    1_500,
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("deadline expired"),
      journal: { effect: "not_sent", commits: [] },
    },
  });
  expect(Date.now() - begun).toBeLessThan(6_000);
  expect(site.calls).toEqual([]);
}, 30_000);

it("reports a fingerprint of the pages after each browser call the operation makes", async () => {
  let title = "Cart";
  const site = recordingBrowser(() => [["https://shop.example/cart", [title, 10, 99]]]);
  const fingerprints: string[] = [];
  const result = await run(
    write(`    await call("return 'one';");
    await call("return 'two';");
    await call("return 'three';");
    return { placed: false };`),
    {
      ...site.browser,
      executeResponse: (code: string) => {
        if (code.includes("'three'")) title = "Placed";
        return site.browser.executeResponse(code);
      },
    },
    { progress: (fingerprint) => Effect.sync(() => fingerprints.push(fingerprint)) },
  );
  expect(result).toMatchObject({ _tag: "Right", right: { output: { placed: false } } });
  expect(site.calls.map((call) => call.name)).toEqual([
    "one",
    "progress",
    "two",
    "progress",
    "three",
    "progress",
  ]);
  expect(fingerprints).toHaveLength(3);
  expect(fingerprints[0]).toMatch(/^[0-9a-f]{32}$/u);
  expect(fingerprints[1]).toBe(fingerprints[0]);
  expect(fingerprints[2]).not.toBe(fingerprints[1]);
}, 30_000);

it("skips the progress report when the pages can't be read, and the run goes on", async () => {
  const fingerprints: string[] = [];
  const calls: string[] = [];
  const browser = {
    sessionId: "local",
    executeResponse: (code: string) =>
      Effect.sync(() => {
        calls.push(named(code));
        return code === pageProgressCode
          ? { success: false, error: "Target closed" }
          : { success: true, result: null };
      }),
  };
  const result = await run(
    write(`    await call("return 'one';");
    return { placed: false };`),
    browser,
    { progress: (fingerprint) => Effect.sync(() => fingerprints.push(fingerprint)) },
  );
  expect(result).toMatchObject({ _tag: "Right", right: { output: { placed: false } } });
  expect(calls).toEqual(["one", "progress"]);
  expect(fingerprints).toEqual([]);
}, 30_000);

it("keeps a browser call that ran when the progress hook breaks", async () => {
  const site = recordingBrowser();
  const result = await run(
    write(`    const answered = await call("return 'one';");
    return { placed: answered.success };`),
    site.browser,
    { progress: () => Effect.die(new Error("The progress hook broke")) },
  );
  expect(result).toMatchObject({ _tag: "Right", right: { output: { placed: true } } });
  expect(site.calls.map((call) => call.name)).toEqual(["one", "progress"]);
}, 30_000);

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<unknown>;

/** A tab at `url` whose page answers the read with `shown`, or never answers without it. */
const tab = (url: string, shown?: readonly [string, number, number]) => ({
  url: () => url,
  evaluate: () => (shown === undefined ? new Promise(() => undefined) : Promise.resolve(shown)),
});

/** The progress read's code, run as a browser call runs it, on a context of `tabs`. */
const readPages = (
  tabs: readonly ReturnType<typeof tab>[],
  timers: { readonly set: unknown; readonly clear: unknown } = {
    set: setTimeout,
    clear: clearTimeout,
  },
) =>
  new AsyncFunction("context", "setTimeout", "clearTimeout", pageProgressCode)(
    { pages: () => tabs },
    timers.set,
    timers.clear,
  );

it("reads every page at once, so pages that never answer cost one page's wait", async () => {
  vi.useFakeTimers();
  try {
    let read: unknown;
    void readPages([
      tab("https://shop.example/a"),
      tab("https://shop.example/cart", ["Cart", 10, 99]),
      tab("https://shop.example/b"),
    ]).then((pages) => {
      read = pages;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(read).toEqual([
      ["https://shop.example/a", null],
      ["https://shop.example/cart", ["Cart", 10, 99]],
      ["https://shop.example/b", null],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("ends the progress read at its overall bound, well before its call's timeout", async () => {
  const waits: { readonly end: () => void; readonly ms: number }[] = [];
  const read = readPages([tab("https://shop.example/a"), tab("https://shop.example/b")], {
    set: (end: () => void, ms: number) => waits.push({ end, ms }),
    clear: () => undefined,
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Only the longest wait ends, as when no page's own wait does.
  const longest = Math.max(...waits.map((wait) => wait.ms));
  for (const wait of waits) if (wait.ms === longest) wait.end();
  expect(await read).toEqual([
    ["https://shop.example/a", null],
    ["https://shop.example/b", null],
  ]);
  expect(longest).toBeLessThanOrEqual(4_000);
});

it("runs the operation's code with none of the host's environment", async () => {
  const name = "POMERADO_TEST_HOST_KEY";
  process.env[name] = "host-only";
  try {
    const result = await run(
      write(`    return { placed: process.env[${JSON.stringify(name)}] !== undefined };`),
      recordingBrowser().browser,
    );
    expect(result).toMatchObject({ _tag: "Right", right: { output: { placed: false } } });
  } finally {
    delete process.env[name];
  }
}, 30_000);
