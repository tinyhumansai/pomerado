// Failure modes covered: a code screen's resend control is refused by the step or recipe contract,
// or a host that predates version 12 replays one; a recipe without one changes version or bytes; a
// resend is named on a screen that takes no code or takes anything else, or is one of the screen's
// own controls; the code question offers a resend without a control to press, more than twice for
// a screen, or the answer `{ resend: true }` passes for a question that never offered it, or for
// any question but the host's own code question; the word resend is typed as a code where no
// resend is offered; a resend's question spends a refused code's tries; the terminal or an MCP
// caller can't ask for a resend; Guardian never sees the control before a press, a denial still
// presses it, or the screen a press drew anew is filled without the checks of its first look;
// Guardian denies the step that names it, or lets an explore press it; a recorded resend that names
// the account or signs out passes; a press isn't told every control of the screen it must not be,
// or a raised stop doesn't reach it; and an offer lost when a code that doesn't fit is asked again.
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Cause, Data, Effect, Either, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resendFits } from "../../src/destinations/autofill-contracts.js";
import { CallingCodeAutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { makeTerminalAsker } from "../../src/inputs/terminal.js";
import { SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { checkSignInVersion } from "../../src/mint/sign-in-version.js";
import { type AutofillLogin, makeAutofillValues } from "../../src/runtime/autofill-values.js";
import {
  type InputAsker,
  InputRequest,
  type InputRequest as Request,
  type Question,
  validateAnswer,
} from "../../src/runtime/input-request.js";
import {
  boundedSignInHooks,
  type BoundedSignInHooks,
} from "../../src/runtime/session-sign-in.js";
import { makeCodeResend } from "../../src/runtime/code-resend.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";
import { makeMcpJobs, mcpFailureMessage } from "../../src/standalone/mcp-jobs.js";
import { makePomeradoMcp } from "../../src/standalone/mcp-server.js";

const site = "https://phone.example.test";
const codeQuestion = {
  id: "code",
  type: "secret",
  secretKind: "one_time_code",
  prompt: "Enter the sign-in code phone.example.test sent you.",
} as const;
const request = (question: object, source = "system") =>
  Schema.decodeUnknownSync(InputRequest)({ id: randomUUID(), source, questions: [question] });

describe("the code question's resend", () => {
  it("takes { resend: true } for a code question that offers a resend, and a code as before", () => {
    const offered = request({ ...codeQuestion, allowResend: true });
    expect(validateAnswer(offered, { code: { resend: true } })).toEqual(
      Either.right({ code: { type: "resend", value: { resend: true } } }),
    );
    expect(validateAnswer(offered, { code: "424242" })).toEqual(
      Either.right({ code: { type: "secret", value: "424242" } }),
    );
  });

  it("refuses { resend: true } for a question that offers none", () => {
    const plain = request(codeQuestion);
    const answered = validateAnswer(plain, { code: { resend: true } });
    expect(Either.isLeft(answered) && answered.left).toMatchObject({
      reason: "unexpected_answer",
      questionId: "code",
    });
    // A text question never carries the offer, so the answer is no text.
    const text = request({ id: "code", type: "text", prompt: "Code?", allowResend: true });
    expect(text.questions[0]).not.toHaveProperty("allowResend");
    expect(Either.isLeft(validateAnswer(text, { code: { resend: true } }))).toBe(true);
    expect(Either.isLeft(validateAnswer(request({ ...codeQuestion, allowResend: true }), { code: { resend: false } }))).toBe(true);
  });

  it("refuses the word resend as a code where no resend is offered, and takes it as the request where one is", () => {
    for (const word of ["resend", " Resend "]) {
      const answered = validateAnswer(request(codeQuestion), { code: word });
      expect(Either.isLeft(answered) && answered.left).toMatchObject({
        reason: "resend_not_offered",
        questionId: "code",
      });
      expect(validateAnswer(request({ ...codeQuestion, allowResend: true }), { code: word })).toEqual(
        Either.right({ code: { type: "resend", value: { resend: true } } }),
      );
    }
    // Any other secret takes the word as typed.
    const other = request({ ...codeQuestion, secretKind: "private_text" });
    expect(validateAnswer(other, { code: "resend" })).toEqual(
      Either.right({ code: { type: "secret", value: "resend" } }),
    );
  });

  it.each([
    ["a secret that is no one-time code", { ...codeQuestion, secretKind: "private_text", allowResend: true }, "system"],
    ["a script's code question", { ...codeQuestion, allowResend: true }, "script"],
    ["the minting agent's code question", { ...codeQuestion, allowResend: true }, "agent"],
  ])("never offers a resend on %s", (_name, question, source) => {
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(InputRequest)({ id: randomUUID(), source, questions: [question] }),
      ),
    ).toBe(true);
  });
});

class UnavailableValue extends Data.TaggedError("UnavailableValue")<{
  readonly operation: string;
}> {}

describe("asking for a code on a screen with a resend control", () => {
  const codeStep: AutofillStep = { fields: [{ selector: "#code", slot: "code" }], submit: "#verify" };
  /** An owner who answers each code question with the next of `answers`, recording each. */
  const owner = (answers: readonly ("resend" | string)[]) => {
    const requests: Request[] = [];
    const queue = [...answers];
    const ask: InputAsker = (asked) =>
      Effect.sync(() => {
        requests.push(asked);
        const answer = queue.shift() ?? "424242";
        return {
          code:
            answer === "resend"
              ? { type: "resend" as const, value: { resend: true as const } }
              : { type: "secret" as const, value: answer },
        };
      });
    return { ask, requests };
  };
  /** A screen's resend, pressed `presses` times so far, whose presses go through when `works`. */
  const resend = (works = true) => {
    const state = { presses: 0 };
    return {
      state,
      resend: { left: () => 2 - state.presses, press: Effect.sync(() => (state.presses++, works)) },
    };
  };
  const ask = (answers: readonly string[], more: Partial<AutofillLogin>) => {
    const answering = owner(answers);
    const filled = Effect.runPromise(
      makeAutofillValues({
        broker: { register: () => Effect.void },
        unavailable: (operation) => new UnavailableValue({ operation }),
        site: "phone.example.test",
        given: { current: {} },
      }).valuesFor(codeStep, {
        credentials: { username: "+15555550123", phone: "+15555550123" },
        ask: answering.ask,
        ...more,
      }),
    );
    return { filled, requests: answering.requests };
  };
  const offered = (requests: readonly Request[]) =>
    requests.map((asked) => {
      const [question] = asked.questions;
      return question?.type === "secret" && question.allowResend === true;
    });

  it("presses the resend the owner asks for, then asks for the newest code", async () => {
    const { resend: control, state } = resend();
    const { filled, requests } = ask(["resend", "777777"], { resend: control });
    expect(await filled).toMatchObject({ values: ["777777"] });
    expect(state.presses).toBe(1);
    expect(offered(requests)).toEqual([true, true]);
    expect(requests.map((asked) => asked.questions[0]?.prompt)).toEqual([
      "Enter the sign-in code phone.example.test sent you.",
      "The site was asked to send a new code. Enter the newest sign-in code phone.example.test sent you.",
    ]);
  });

  it("offers a resend twice at most, then asks for the code alone", async () => {
    const { resend: control, state } = resend();
    const { filled, requests } = ask(["resend", "resend", "777777"], { resend: control });
    expect(await filled).toMatchObject({ values: ["777777"] });
    expect(state.presses).toBe(2);
    expect(offered(requests)).toEqual([true, true, false]);
  });

  it("says so when the press did not go through, and asks again", async () => {
    const { resend: control } = resend(false);
    const { filled, requests } = ask(["resend", "777777"], { resend: control });
    expect(await filled).toMatchObject({ values: ["777777"] });
    expect(requests[1]?.questions[0]?.prompt).toBe(
      "The site's resend control couldn't be pressed, so no new code was asked for. Enter the newest sign-in code phone.example.test sent you.",
    );
  });

  it("offers no resend on a screen without one", async () => {
    const { filled, requests } = ask(["777777"], {});
    expect(await filled).toMatchObject({ values: ["777777"] });
    expect(offered(requests)).toEqual([false]);
  });

  it("keeps offering the resend when it asks again for a code that doesn't fit its boxes", async () => {
    const { resend: control } = resend();
    const answering = owner(["12345", "12"]);
    const boxes: AutofillStep = {
      fields: [
        { selector: "#code-1", slot: "code" },
        { selector: "#code-2", slot: "code" },
      ],
      submit: "#verify",
    };
    await Effect.runPromise(
      makeAutofillValues({
        broker: { register: () => Effect.void },
        unavailable: (operation) => new UnavailableValue({ operation }),
        site: "phone.example.test",
        given: { current: {} },
      }).valuesFor(boxes, {
        credentials: { username: "+15555550123", phone: "+15555550123" },
        ask: answering.ask,
        resend: control,
      }),
    );
    expect(offered(answering.requests)).toEqual([true, true]);
  });

  it("spends none of a refused code's tries on a resend's question", async () => {
    const { resend: control } = resend();
    const codeRequests = { current: 1 };
    const { filled, requests } = ask(["resend", "777777"], {
      resend: control,
      codeAgain: "rejected",
      codeRequests,
    });
    expect(await filled).toMatchObject({ values: ["777777"] });
    expect(codeRequests.current).toBe(2);
    expect(requests[0]?.questions[0]?.prompt).toBe(
      "The site refused the last code. Enter the newest sign-in code phone.example.test sent you.",
    );
  });
});

describe("the terminal", () => {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  afterEach(() => {
    if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
    vi.restoreAllMocks();
  });

  /** Answers one code question by typing each of `lines` at each prompt in turn; keeps what was shown. */
  const typed = async (
    lines: string | readonly string[],
    allowResend: boolean,
    question: object = codeQuestion,
  ) => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => input });
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    const shown: string[] = [];
    const queue = typeof lines === "string" ? [lines] : [...lines];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      const text = String(chunk);
      shown.push(text);
      if (text === "> ") {
        const next = queue.shift() ?? "";
        setImmediate(() => input.write(`${next}\r`));
      }
      return true;
    });
    const answered = await Effect.runPromise(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [{ ...question, ...(allowResend ? { allowResend } : {}) } as Question],
      }),
    );
    return { answer: answered["code"], shown };
  };

  it("takes resend typed at a code question that offers one as the request for a new code", async () => {
    const { answer, shown } = await typed("resend", true);
    expect(answer).toEqual({ type: "resend", value: { resend: true } });
    expect(shown.join("")).toContain("Type resend to have the site send a new code.");
  });

  it("says no new code can be asked for when resend is typed at a question that offers none, and asks again", async () => {
    const { answer, shown } = await typed(["resend", "424242"], false);
    expect(answer).toEqual({ type: "secret", value: "424242" });
    expect(shown.join("")).not.toContain("Type resend");
    expect(shown.join("")).toContain("No new code can be asked for here. Type the code the site sent.");
  });

  it("takes the word as typed at a secret that is no code", async () => {
    const { answer, shown } = await typed(["resend", "never-read"], false, {
      ...codeQuestion,
      secretKind: "private_text",
    });
    expect(answer).toEqual({ type: "secret", value: "resend" });
    expect(shown.join("")).not.toContain("No new code can be asked for here.");
  });
});

it("tells an MCP caller how to ask for a new code", async () => {
  const description = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makePomeradoMcp({
          prepare: () => Effect.die(new Error("A listing prepares nothing")),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "pomerado-unit", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const { tools } = yield* Effect.promise(() => client.listTools());
        return tools.find((tool) => tool.name === "provide_input")?.description ?? "";
      }),
    ),
  );
  expect(description).toContain('A secret with allowResend may be {"resend": true} instead of a code');
});

it("tells an MCP caller a code question offers no new code, and keeps the question pending", async () => {
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const started = yield* jobs.start((ask) => ask(request(codeQuestion)));
        let view = yield* jobs.get(started.job_id, 200);
        for (let attempt = 0; attempt < 20 && view.status !== "input_required"; attempt++)
          view = yield* jobs.get(started.job_id, 200);
        const requestId = "pending_input" in view ? (view.pending_input?.id ?? "") : "";
        const refused = yield* Effect.flip(jobs.provide(started.job_id, requestId, { code: "resend" }));
        const still = yield* jobs.get(started.job_id);
        yield* jobs.provide(started.job_id, requestId, { code: "424242" });
        let done = yield* jobs.get(started.job_id, 200);
        for (let attempt = 0; attempt < 20 && done.status === "running"; attempt++)
          done = yield* jobs.get(started.job_id, 200);
        return { message: mcpFailureMessage(Cause.fail(refused), "run"), still: still.status, done };
      }),
    ),
  );
  expect(outcome.message).toBe("This code question offers no new code: answer with the code the site sent.");
  expect(outcome.still).toBe("input_required");
  expect(outcome.done).toMatchObject({ status: "completed", output: { code: { type: "secret", value: "424242" } } });
});

describe("a code screen's recorded resend", () => {
  const codeStep = { selector: "#code", slot: "code" } as const;
  const decode = (step: object) => Schema.decodeUnknownEither(SignInStep)(step);

  it("is a code step's own control, never one of its fields or its submit", () => {
    const step = { fields: [codeStep], submit: "#verify", resend: "#resend" };
    expect(decode(step)).toEqual(Either.right(step));
    expect(Either.isLeft(decode({ ...step, resend: "#verify" }))).toBe(true);
    expect(Either.isLeft(decode({ ...step, resend: "#code" }))).toBe(true);
    expect(Either.isLeft(decode({ ...step, dismiss: "#resend" }))).toBe(true);
    expect(
      Either.isLeft(decode({ fields: [{ selector: "#password", slot: "password" }], submit: "#next", resend: "#resend" })),
    ).toBe(true);
  });

  it("is never one of the screen's methods", () => {
    const step = { fields: [codeStep], submit: "#verify", resend: "#resend" };
    expect(resendFits({ ...step, methods: [{ selector: "#by-call" }] })).toBe(true);
    expect(resendFits({ ...step, methods: [{ selector: "#by-call" }, { selector: "#resend" }] })).toBe(false);
  });

  const phoneStep = { page: `${site}/login`, fields: [{ selector: "#phone", accepts: ["phone"] }], submit: "#send" };
  const recorded = { page: `${site}/verify`, fields: [codeStep], submit: "#verify", resend: "#resend" };
  const recipe = { version: 12, steps: [phoneStep, recorded], signedIn: { selector: "#account" } };

  it("is refused on a step that takes anything besides codes, so a press never sends a typed value", () => {
    const mixed = { fields: [{ selector: "#password", slot: "password" }, codeStep], submit: "#verify", resend: "#resend" };
    expect(Either.isLeft(decode(mixed))).toBe(true);
    expect(
      decodeSignInRecipe(
        JSON.stringify({ ...recipe, steps: [phoneStep, { ...recorded, fields: [{ selector: "#password", slot: "password" }, codeStep] }] }),
      ),
    ).toBe("invalid");
    const pressing = {
      inspect: () => Effect.dieMessage("Unexpected inspect"),
      resend: () => Effect.dieMessage("Unexpected press"),
    };
    const offered = (step: AutofillStep) =>
      makeCodeResend({ hooks: pressing, step, presses: new Map(), waitMs: 0, pollMs: 0, emit: () => Effect.void });
    expect(offered(mixed as AutofillStep)).toBeUndefined();
    expect(offered({ fields: [codeStep], submit: "#verify", resend: "#resend" })).toBeDefined();
  });

  it("reads a version 12 recipe and writes it back byte for byte", () => {
    const text = JSON.stringify(recipe, null, 2);
    const decoded = decodeSignInRecipe(text);
    expect(decoded).toEqual(recipe);
    if (typeof decoded === "string") throw new Error(decoded);
    expect(signInRecipeText(decoded)).toBe(text);
  });

  it("is refused by a host that knows version 11 at most, and a version 11 recipe with one is refused", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(CallingCodeAutofillRecipe)({ ...recipe, version: 11 }))).toBe(true);
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 11 }))).toBe("invalid");
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 13 }))).toBe("unknown_version");
    expect(
      decodeSignInRecipe(JSON.stringify({ ...recipe, steps: [{ ...phoneStep, resend: "#resend" }, recorded] })),
    ).toBe("invalid");
  });

  it("writes version 12 only when a screen records its resend, after its other keys", () => {
    const steps = [
      { ...phoneStep, fields: [{ selector: "#phone", slot: "phone" as const, accepts: ["phone" as const] }] },
      { ...recorded, fields: [codeStep] },
    ];
    const written = signInRecipe(steps, { selector: "#account" });
    expect(written.version).toBe(12);
    expect(Object.keys(written.steps[1] ?? {})).toEqual(["page", "fields", "submit", "resend"]);
    const { resend: _resend, ...without } = recorded;
    expect(signInRecipe([steps[0]!, { ...without, fields: [codeStep] }], { selector: "#account" }).version).toBe(1);
  });

  it("is checked as every recorded selector is", () => {
    const findings = checkSignInVersion({
      siteOrigin: site,
      version: {
        entryUrl: `${site}/login`,
        recipe: { ...recipe, steps: [phoneStep, { ...recorded, resend: "text=Send to [private]" }] },
      },
      signedOutSnapshots: [],
    } as never);
    expect(findings).toContainEqual({ rule: "selector_names_contact", part: "recipe.steps[1].resend" });
  });

  it("is refused when it signs out, as every control a step clicks", () => {
    const findings = checkSignInVersion({
      siteOrigin: site,
      version: {
        entryUrl: `${site}/login`,
        recipe: { ...recipe, steps: [phoneStep, { ...recorded, resend: "#signOutButton" }] },
      },
      signedOutSnapshots: [],
    } as never);
    expect(findings).toContainEqual({ rule: "sign_out", part: "recipe.steps[1].resend" });
  });

  it("tells a press the screen's own submit, methods and dismiss, none of which its control may be", async () => {
    const apart: (readonly string[])[] = [];
    const resend = makeCodeResend({
      hooks: {
        inspect: () => Effect.succeed({} as never),
        resend: ({ apartFrom }) =>
          Effect.sync(() => {
            apart.push(apartFrom);
            return { outcome: "filled", fields: [], submit: "clicked", url: site } as const;
          }),
      },
      step: {
        fields: [codeStep],
        submit: "#verify",
        methods: [
          { selector: "#by-call", method: "call" },
          { selector: "#by-text", method: "sms" },
        ],
        dismiss: "#close",
        resend: "#resend",
      },
      presses: new Map(),
      waitMs: 0,
      pollMs: 0,
      emit: () => Effect.void,
    });
    await Effect.runPromise(resend?.press ?? Effect.void);
    expect(apart).toEqual([["#verify", "#by-call", "#by-text", "#close"]]);
  });
});

describe("a press under a sign-in's bound", () => {
  const code = {
    step: { fields: [{ selector: "#code", slot: "code" as const }], submit: "#resend" },
    inspection: {} as never,
    apartFrom: ["#verify"],
  };
  const hooks = () => {
    const waits: number[] = [];
    const browser: BoundedSignInHooks<Error> = {
      inspect: () => Effect.dieMessage("Unexpected inspect"),
      fill: () => Effect.dieMessage("Unexpected fill"),
      open: () => Effect.void,
      resend: ({ waitMs }) =>
        Effect.sync(() => {
          waits.push(waitMs);
          return { outcome: "filled", fields: [], submit: "clicked", url: site } as const;
        }),
    };
    return { browser, waits };
  };
  const expired = () => new Error("The bound passed");

  it("waits for the site's timer only until the bound", async () => {
    const { browser, waits } = hooks();
    const stop = new AbortController();
    const bounded = boundedSignInHooks(browser, { untilMs: Date.now() + 1_000, stop: stop.signal }, expired);
    await Effect.runPromise(bounded.resend?.({ ...code, waitMs: 120_000 }) ?? Effect.void);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(1_000);
    await Effect.runPromise(bounded.resend?.({ ...code, waitMs: 10 }) ?? Effect.void);
    expect(waits[1]).toBe(10);
  });

  it("presses nothing once the bound passed", async () => {
    const { browser, waits } = hooks();
    const stop = new AbortController();
    const bounded = boundedSignInHooks(browser, { untilMs: Date.now() - 1, stop: stop.signal }, expired);
    const report = await Effect.runPromise(bounded.resend?.({ ...code, waitMs: 120_000 }) ?? Effect.void);
    expect(report).toMatchObject({ outcome: "refused", reason: "typing_unavailable" });
    expect(waits).toEqual([]);
  });

  it("presses nothing once the stop is raised", async () => {
    const { browser, waits } = hooks();
    const stop = new AbortController();
    stop.abort();
    const bounded = boundedSignInHooks(browser, { untilMs: Date.now() + 1_000, stop: stop.signal }, expired);
    const report = await Effect.runPromise(bounded.resend?.({ ...code, waitMs: 120_000 }) ?? Effect.void);
    expect(report).toMatchObject({ outcome: "refused", reason: "typing_unavailable" });
    expect(waits).toEqual([]);
  });

  it("hands the press the stop, which its wait watches", async () => {
    const stops: unknown[] = [];
    const { browser } = hooks();
    const stop = new AbortController();
    const bounded = boundedSignInHooks(
      {
        ...browser,
        resend: (input) =>
          Effect.sync(() => {
            stops.push(input.stop);
            return { outcome: "filled", fields: [], submit: "clicked", url: site } as const;
          }),
      },
      { untilMs: Date.now() + 1_000, stop: stop.signal },
      expired,
    );
    await Effect.runPromise(bounded.resend?.({ ...code, waitMs: 10 }) ?? Effect.void);
    expect(stops).toEqual([stop.signal]);
  });

  it("gives a browser without a resend none", () => {
    const { resend: _resend, ...browser } = hooks().browser;
    const stop = new AbortController();
    const bounded = boundedSignInHooks(browser, { untilMs: Date.now(), stop: stop.signal }, expired);
    expect(bounded).not.toHaveProperty("resend");
  });
});

describe("a build's code screen with a resend control", () => {
  const origin = "https://www.example.test";
  const target = { ownerUrl: `${origin}/code`, documentOrigin: origin, actions: [`${origin}/code`], methods: ["post"], submitMethod: "post", editable: true, control: "text" } as const;
  /** A control as Guardian reads it, by its text alone. */
  const described = (text: string) => ({
    tag: "button",
    role: null,
    formMethod: null,
    type: null,
    name: null,
    id: null,
    autocomplete: null,
    inputmode: null,
    label: null,
    placeholder: null,
    ariaLabel: null,
    text,
  });
  /** The screen as found; once pressed, as `afterPress` says, a resend may draw it anew. */
  const inspect = (step: AutofillStep, pressedOnce: boolean, afterPress?: { readonly boxes: number }) =>
    Effect.sync(() => ({
      url: `${origin}/code`,
      page: `${origin}/code`,
      targets: { fields: step.fields.map(() => target), submit: target },
      siteOrigin: origin,
      authenticationOrigins: [],
      screen: {
        origin,
        fields:
          pressedOnce && afterPress !== undefined && step.submit === "#verify"
            ? step.fields.map(() => ({
                ...described(""),
                tag: "input",
                slot: "code" as const,
                codeBox: { box: 1, of: afterPress.boxes },
              }))
            : [],
        submit: step.submit === undefined ? null : described(step.submit === "#resend" ? "Resend code" : "Verify"),
        buttons: [],
      },
    }));
  const build = (
    answers: readonly string[],
    options: {
      readonly review?: (step: AutofillStep, seen: unknown, resendControl?: unknown) => Effect.Effect<void, Error>;
      readonly afterPress?: { readonly boxes: number };
    } = {},
  ) => {
    const asked: Request[] = [];
    const queue = [...answers];
    const pressed: string[] = [];
    const inspected: AutofillStep[] = [];
    const filled: (string | undefined)[] = [];
    const recorder = makeSignInRecorder({
      browser: {
        inspect: (step) => {
          inspected.push(step);
          return inspect(step, pressed.length > 0, options.afterPress);
        },
        fill: ({ step }) =>
          Effect.sync(() => filled.push(step.submit)).pipe(Effect.as({
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/next`,
          })),
        resend: ({ step }) =>
          Effect.sync(() => {
            pressed.push(step.submit ?? "");
            return { outcome: "filled" as const, fields: [], submit: "clicked" as const, url: `${origin}/code` };
          }),
        confirm: () => Effect.succeed({ signedIn: true as const, url: `${origin}/account` }),
        authenticationOrigins: [],
        open: () => Effect.void,
        markerVisible: () => Effect.succeed(false),
      },
      login: {
        held: () => ({ username: "ada-owner", password: "synthetic-password" }),
        values: Effect.dieMessage("Unexpected login"),
        correct: () => Effect.dieMessage("Unexpected correction"),
      },
      ask: (request) =>
        Effect.sync(() => {
          asked.push(request);
          const answer = queue.shift() ?? "424242";
          return {
            code:
              answer === "resend"
                ? { type: "resend" as const, value: { resend: true as const } }
                : { type: "secret" as const, value: answer },
          };
        }),
      secrets: { register: () => {}, assertAbsent: () => Effect.void },
      review: options.review ?? (() => Effect.void),
      site: "example.test",
      signedOutPages: () => [],
    });
    return { recorder, asked, pressed, inspected, filled };
  };
  const step = {
    fields: [{ selector: "#code", slot: "code" }],
    submit: "#verify",
    resend: "#resend",
  } satisfies SignInStep;

  it("offers the resend, presses it, judges the screen again and records it in version 12", async () => {
    const { recorder, asked, pressed, inspected } = build(["resend", "424242"]);
    const identifier: SignInStep = { fields: [{ selector: "#user", accepts: ["username"] }], submit: "#next" };
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recorder.step(identifier, `${origin}/login`, Effect.void);
        yield* recorder.step(step, undefined, Effect.void);
        yield* recorder.step({ signedIn: { selector: "#account" } }, undefined, Effect.void);
      }),
    );
    expect(pressed).toEqual(["#resend"]);
    expect(asked.map((request) => request.questions[0])).toMatchObject([
      { id: "code", allowResend: true },
      { id: "code", allowResend: true },
    ]);
    // The screen, the resend step, then the screen again before its fill.
    expect(inspected.map((each) => each.submit)).toEqual(["#next", "#verify", "#resend", "#verify"]);
    expect(recorder.published()?.recipe).toMatchObject({
      version: 12,
      steps: [{}, { resend: "#resend" }],
    });
  });

  const identifier: SignInStep = { fields: [{ selector: "#user", accepts: ["username"] }], submit: "#next" };

  it("has Guardian judge the resend control as it shows before the press, then the screen again", async () => {
    const reviewed: unknown[] = [];
    const { recorder, pressed } = build(["resend", "424242"], {
      review: (step, _seen, resendControl) =>
        Effect.sync(() => {
          reviewed.push([step.submit, resendControl ?? null]);
        }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recorder.step(identifier, `${origin}/login`, Effect.void);
        yield* recorder.step(step, undefined, Effect.void);
      }),
    );
    expect(pressed).toEqual(["#resend"]);
    expect(reviewed).toEqual([
      ["#next", null],
      ["#verify", null],
      ["#verify", described("Resend code")],
      ["#verify", null],
    ]);
  });

  it("presses nothing when Guardian denies the resend control, and the build fails with the denial", async () => {
    const denied = new Error("Guardian denied the resend control");
    const { recorder, pressed, filled, asked } = build(["resend", "424242"], {
      review: (_step, _seen, resendControl) => (resendControl === undefined ? Effect.void : Effect.fail(denied)),
    });
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          yield* recorder.step(identifier, `${origin}/login`, Effect.void);
          yield* recorder.step(step, undefined, Effect.void);
        }),
      ),
    );
    expect(result).toEqual(Either.left(denied));
    expect(pressed).toEqual([]);
    expect(filled).toEqual(["#next"]);
    expect(asked).toHaveLength(1);
  });

  it("refuses a screen a resend drew anew with its code split across boxes the step doesn't name", async () => {
    const { recorder, pressed, filled } = build(["resend", "424242"], { afterPress: { boxes: 6 } });
    const answered = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recorder.step(identifier, `${origin}/login`, Effect.void);
        return yield* recorder.step(step, undefined, Effect.void);
      }),
    );
    expect(pressed).toEqual(["#resend"]);
    expect(answered.report).toMatchObject({ outcome: "refused", reason: "code_boxes_incomplete" });
    expect(filled).toEqual(["#next"]);
  });

  it("refuses a resend selector that names the account, as every recorded selector", async () => {
    const { recorder, filled } = build([]);
    const answer = await Effect.runPromise(
      recorder.step({ ...step, resend: "text=Send to ada-owner" }, undefined, Effect.void),
    );
    expect(JSON.stringify(answer.result)).toContain("selector_names_contact");
    expect(filled).toEqual([]);
  });

  it("refuses a resend selector that holds the mask, as every recorded selector", async () => {
    const { recorder, inspected } = build([]);
    const answer = await Effect.runPromise(
      recorder.step({ ...step, resend: "text=Send to [private]" }, undefined, Effect.void),
    );
    expect(JSON.stringify(answer.result)).toContain("selector_names_contact");
    expect(inspected).toEqual([]);
  });
});

it("has Guardian allow a code step's own resend control, and deny an explore that presses one", () => {
  const policy = guardianExecutionPolicy(nativeExecutionEnvironment);
  expect(policy).toContain(
    "A code step's resend names the screen's own control that asks the site to send a new code, such as Resend code or Send again, and a review's resendControl, when it has one, describes that control as the screen shows it, just before the host presses it: allow it when it is that control, since the host presses it only when the owner answers the code question by asking for a new code, never by itself, once the site enables it; deny a resend that signs in, submits the code or takes any other action.",
  );
  expect(policy).toContain("clicks its submit, Next, Continue, send-code or resend control");
});

describe("a run's code screen after a press", () => {
  const login = `${site}/login`;
  const recipe = {
    version: 12,
    steps: [
      { page: login, fields: [{ selector: "#phone", accepts: ["phone"] }], submit: "#send" },
      { page: `${site}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify", resend: "#resend" },
    ],
    signedIn: { selector: "#account" },
  } as const;

  /** What the screen is once pressed, with what its first look found. */
  type Found = { readonly page: string; readonly popupTargetId?: string; readonly boxes?: number };
  const unchanged: Found = { page: `${site}/verify` };

  /** A run that presses the screen's resend, then answers its code, on a screen `after` draws. */
  const afterPress = async (after: Found) => {
    const pressed: string[] = [];
    const filled: (string | undefined)[] = [];
    const answers = ["resend", "424242"];
    const ask = makeInputAsker((asked) =>
      Effect.sync(() => {
        const question = asked.questions[0];
        if (question?.type === "credential")
          return { login: { identifierKind: "phone", username: "+15555550123", saveLogin: false } };
        const answer = answers.shift() ?? "424242";
        return { code: answer === "resend" ? { resend: true } : answer };
      }),
    );
    const at = (step: AutofillStep): Found =>
      step.submit === "#send"
        ? { page: login }
        : pressed.length > 0 && step.submit === "#verify"
          ? after
          : unchanged;
    const secrets = makeRunSecrets();
    const failed = await Effect.runPromise(
      Effect.flip(
        signInForRun({
          recipe: recipe as never,
          entryUrl: login,
          browser: {
            inspect: (step) =>
              Effect.sync(() => {
                const { page, popupTargetId, boxes } = at(step);
                const origin = new URL(page).origin;
                const target = { ownerUrl: page, documentOrigin: origin, actions: [page], methods: ["post"], submitMethod: "post", editable: true, control: "text" } as const;
                return {
                  url: page,
                  page,
                  ...(popupTargetId === undefined ? {} : { popupTargetId }),
                  targets: { fields: step.fields.map(() => target), submit: target },
                  siteOrigin: site,
                  authenticationOrigins: [],
                  screen: {
                    origin,
                    fields:
                      boxes === undefined
                        ? []
                        : step.fields.map(() => ({ codeBox: { box: 1, of: boxes } }) as never),
                    submit: null,
                    buttons: [],
                  },
                };
              }),
            fill: ({ step }) =>
              Effect.sync(() => {
                filled.push(step.submit);
                return {
                  outcome: "filled" as const,
                  fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
                  submit: "clicked" as const,
                  url: `${site}/verify`,
                };
              }),
            resend: ({ step }) =>
              Effect.sync(() => {
                pressed.push(step.submit ?? "");
                return { outcome: "filled" as const, fields: [], submit: "clicked" as const, url: `${site}/verify` };
              }),
            confirm: () => Effect.succeed({ signedIn: false as const, failed: "indicator_not_visible" as const }),
            authenticationOrigins: [],
            open: () => Effect.void,
            markerVisible: () => Effect.succeed(false),
          },
          login: localSignInLogin({
            ask,
            register: secrets.register,
            siteOrigin: site,
            passwordless: { identifierKinds: ["phone"], password: false },
          }),
          ask,
          secrets,
          site: "phone.example.test",
          siteOrigin: site,
          timing: { stepWaitMs: 200, pollMs: 50 },
        }),
      ),
    );
    return { failed, pressed, filled };
  };

  it.each([
    ["moved to another origin", { page: "https://other.example.test/verify" }],
    ["moved to a popup", { ...unchanged, popupTargetId: "popup" }],
    ["drew anew with its code split across boxes", { ...unchanged, boxes: 6 }],
  ])("fills nothing on a screen the press %s", async (_name, after) => {
    const { failed, pressed, filled } = await afterPress(after);
    expect(pressed).toEqual(["#resend"]);
    expect(filled).toEqual(["#send"]);
    expect(failed).toMatchObject({ reason: "screen_changed" });
  });
});
