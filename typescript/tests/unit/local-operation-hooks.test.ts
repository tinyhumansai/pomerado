// Failure modes covered: a click that runs before the host's commit hook accepts its commit step,
// a refused commit whose click or later calls still reach the browser, a later step's yes that lets
// a click pass an earlier step's refusal, a refused step that still reads sent, a run that
// succeeds past a refusal, a commit report lost on the way to the host, a report that is not JSON
// or is too large still marked, a run without hooks that changes, a started hook that fires late
// or twice, a progress hook that misses a browser call or stops the run when the page can't be
// read, and an operation that sees the host's own environment.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
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

const run = (source: string, browser: object, hooks?: OperationHooks) =>
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
  expect(entered).toEqual([{ name: "place-order", report }]);
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
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "sent" }] },
    },
  });
  expect(site.scriptCalls().map((call) => call.name)).toEqual(["first"]);
}, 30_000);

it("fails before marking a commit step whose report is not JSON or too large", async () => {
  for (const passed of [
    `{ total: 1n }`,
    `(() => { const loop = {}; loop.self = loop; return loop; })()`,
    `{ text: "x".repeat(${commitReportLimitBytes}) }`,
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
