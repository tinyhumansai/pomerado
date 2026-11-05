// Failure modes covered: an HTTP request, a file placement or a card fill that reaches the site
// before the host's commit hook accepted the step entered before it, a held call the host refused
// that the script reads as possibly sent, an HTTP version whose report the child marks without
// checking it, and an HTTP version's step the host refuses because another journal update of its
// script reached the host between the mark and its entering.
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  type LocalOperationOptions,
  runLocalOperation,
} from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import type { RunFiles } from "../../src/runtime/file-transfer.js";
import type { EnteredCommit, OperationHooks } from "../../src/runtime/operation-hooks.js";
import type { HttpTransport, SiteHttpRequest } from "../../src/runtime/site-http.js";

const run = (
  entrypoint: string,
  source: string,
  options: Partial<LocalOperationOptions> & { readonly hooks: OperationHooks },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: {},
          siteOrigin: "https://shop.example",
          ...options,
        }).pipe(Effect.either);
      }),
    ),
  );

/** A commit hook that records each step and refuses it after `delayMs`. */
const refusing = (delayMs = 0) => {
  const asked: EnteredCommit[] = [];
  const hooks: OperationHooks = {
    commit: (mark) =>
      Effect.sync(() => asked.push(mark)).pipe(
        Effect.zipRight(Effect.sleep(delayMs)),
        Effect.zipRight(Effect.fail(new Error("The total changed"))),
      ),
  };
  return { asked, hooks };
};

/** A site's HTTP transport that answers every request with an empty JSON body, recording it. */
const site = () => {
  const sent: { readonly request: SiteHttpRequest; readonly at: number }[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies"],
    send: (request) => {
      sent.push({ request, at: Date.now() });
      return Promise.resolve({
        status: 200,
        headers: { "content-type": ["application/json"] },
        body: new TextEncoder().encode("{}"),
        transport: "kernel-curl",
        gaps: [],
      });
    },
  };
  return { transport, sent };
};

/**
 * An HTTP version that enters its commit step with `report` and sends one request, writing the
 * failure's dispatch to stderr when the request fails.
 */
const payment = (report: string) => `import { Effect, Schema } from "effect";
import { defineHttpOperation, ExecutionContext } from "pomerado/runtime";
export default defineHttpOperation({
  name: "pay",
  input: Schema.Struct({}),
  output: Schema.Struct({ status: Schema.Number }),
  write: { confirmation: "readback", commits: ["pay"] },
  run: (input, http) =>
    Effect.gen(function* () {
      const { journal } = yield* ExecutionContext;
      yield* journal.enteringCommit("pay", ${report});
      const response = yield* http.request({ url: "/api/pay", method: "POST" }).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => console.error(JSON.stringify({ dispatch: failure.dispatch }))),
        ),
      );
      return { status: response.status };
    }),
});`;

const httpEntrypoint = "src/tool-http.mjs";

it("holds an HTTP version's request until the host accepts the step before it", async () => {
  const shop = site();
  let acceptedAt = 0;
  const result = await run(httpEntrypoint, payment(`{ total_minor: 20400 }`), {
    http: shop.transport,
    hooks: {
      commit: () =>
        Effect.sleep(300).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              acceptedAt = Date.now();
            }),
          ),
        ),
    },
  });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { status: 200 } } });
  expect(shop.sent).toHaveLength(1);
  expect(shop.sent[0]?.at).toBeGreaterThanOrEqual(acceptedAt);
}, 30_000);

it("never sends an HTTP request the host refused, and the script reads it unsent", async () => {
  const shop = site();
  const host = refusing(200);
  const result = await run(httpEntrypoint, payment(`{ total_minor: 20400 }`), {
    http: shop.transport,
    hooks: host.hooks,
  });
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "pay",
      journal: { commits: [{ name: "pay", state: "not_sent" }] },
      stderr: expect.stringContaining(`{"dispatch":"not_sent"}`),
    },
  });
  expect(host.asked).toEqual([{ name: "pay", report: { total_minor: 20_400 }, callOut: false }]);
  expect(shop.sent).toEqual([]);
}, 30_000);

it("fails an HTTP version before marking a step whose report is not JSON or too deep", async () => {
  for (const passed of [
    `{ total: 1n }`,
    `(() => { let deep = 0; for (let i = 0; i < 100; i++) deep = [deep]; return deep; })()`,
  ]) {
    const shop = site();
    const host = refusing();
    const result = await run(httpEntrypoint, payment(passed), {
      http: shop.transport,
      hooks: host.hooks,
    });
    expect(result, passed).toMatchObject({
      _tag: "Left",
      left: { journal: { commits: [{ name: "pay", state: "not_sent" }] } },
    });
    expect(host.asked, passed).toEqual([]);
    expect(shop.sent, passed).toEqual([]);
  }
}, 60_000);

it("enters an HTTP version's step while its other journal updates run alongside", async () => {
  // Each budget makes the script's fibers yield to one another at a different point.
  for (const ops of [12, 16]) {
    const shop = site();
    const asked: EnteredCommit[] = [];
    const source = `import { Effect, Schema } from "effect";
import { defineHttpOperation, ExecutionContext } from "pomerado/runtime";
export default defineHttpOperation({
  name: "pay",
  input: Schema.Struct({}),
  output: Schema.Struct({ status: Schema.Number }),
  write: { confirmation: "readback", commits: ["pay"] },
  run: (input, http) =>
    Effect.gen(function* () {
      const { journal } = yield* ExecutionContext;
      yield* Effect.all(
        [
          journal.enteringCommit("pay", { total_minor: 20400 }),
          Effect.forEach(Array.from({ length: 40 }), () => journal.declareCommits([]), {
            discard: true,
          }),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withMaxOpsBeforeYield(${ops}));
      const response = yield* http.request({ url: "/api/pay", method: "POST" });
      return { status: response.status };
    }),
});`;
    const result = await run(httpEntrypoint, source, {
      http: shop.transport,
      hooks: { commit: (mark) => Effect.sync(() => asked.push(mark)) },
    });
    expect(result, `${ops}`).toMatchObject({ _tag: "Right", right: { output: { status: 200 } } });
    expect(asked, `${ops}`).toEqual([
      { name: "pay", report: { total_minor: 20_400 }, callOut: false },
    ]);
    expect(shop.sent, `${ops}`).toHaveLength(1);
  }
}, 60_000);

/** A Kernel write that enters its commit step and runs `body`, with the context's helpers. */
const write = (body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  {
    name: "place_order",
    input: Schema.Struct({}),
    output: Schema.Struct({ placed: Schema.Boolean }),
    write: { confirmation: "readback", commits: ["place-order"] },
  },
  async ({ enteringCommit, files, fillCard }) => {
    enteringCommit("place-order");
${body}
    return { placed: false };
  },
);`;

const browser = {
  sessionId: "local",
  executeResponse: () => Effect.fail(new Error("The script made no page call")),
};

it("never places a file the host refused, and the script reads it unsent", async () => {
  const placed: unknown[] = [];
  const files: RunFiles = {
    place: (request) =>
      Effect.sync(() => {
        placed.push(request);
        return { name: "receipt.pdf", media_type: "application/pdf", size: 1 };
      }),
    arm: () => Effect.succeed("slot"),
    collect: () => Effect.die(new Error("The script collects nothing")),
    checkOutput: () => Effect.void,
  };
  const result = await run(
    "src/tool.mjs",
    write(`    try {
      await files.place("receipt", { field: { label: "Receipt" } });
    } catch (error) {
      console.error(JSON.stringify({ dispatch: error.dispatch }));
    }`),
    { browser, files, hooks: refusing(200).hooks },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
      stderr: expect.stringContaining(`{"dispatch":"not_sent"}`),
    },
  });
  expect(placed).toEqual([]);
}, 30_000);

it("never fills a card the host refused", async () => {
  const filled: unknown[] = [];
  const result = await run(
    "src/tool.mjs",
    write(`    await fillCard({ fields: [{ selector: "#number", handle: "{{card.c1}}" }] }).catch(
      () => undefined,
    );`),
    {
      browser,
      cardFill: ({ step }) =>
        Effect.sync(() => {
          filled.push(step);
          return { status: "refused" as const, observations: "{}" };
        }),
      hooks: refusing(200).hooks,
    },
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "CommitRefused",
      commitRefused: "place-order",
      journal: { commits: [{ name: "place-order", state: "not_sent" }] },
    },
  });
  expect(filled).toEqual([]);
}, 30_000);
