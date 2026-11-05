// Failure modes covered: a code screen's resend control is refused by the step or recipe contract,
// or a host that predates version 12 replays one; a recipe without one changes version or bytes; a
// resend is named on a screen that takes no code, or is one of the screen's own controls; the code
// question offers a resend without a control to press, more than twice for a screen, or the
// answer `{ resend: true }` passes for a question that never offered it, or for any question but
// the host's own code question; a resend's question spends a refused code's tries; the terminal
// or an MCP caller can't ask for a resend; Guardian denies the step that names it, or lets an
// explore press it.
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Data, Effect, Either, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { makeTerminalAsker } from "../../src/inputs/terminal.js";
import { SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { checkSignInVersion } from "../../src/mint/sign-in-version.js";
import { type AutofillLogin, makeAutofillValues } from "../../src/runtime/autofill-values.js";
import {
  type InputAsker,
  InputRequest,
  type InputRequest as Request,
  validateAnswer,
} from "../../src/runtime/input-request.js";
import {
  boundedSignInHooks,
  type BoundedSignInHooks,
} from "../../src/runtime/session-sign-in.js";
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

  /** Answers one code question by typing `typed` once its prompt shows; keeps what was shown. */
  const typed = async (typedText: string, allowResend: boolean) => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => input });
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    const shown: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      const text = String(chunk);
      shown.push(text);
      if (text === "> ") setImmediate(() => input.write(`${typedText}\r`));
      return true;
    });
    const answered = await Effect.runPromise(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [{ ...codeQuestion, ...(allowResend ? { allowResend } : {}) }],
      }),
    );
    return { answer: answered["code"], shown };
  };

  it("takes resend typed at a code question that offers one as the request for a new code", async () => {
    const { answer, shown } = await typed("resend", true);
    expect(answer).toEqual({ type: "resend", value: { resend: true } });
    expect(shown.join("")).toContain("Type resend to have the site send a new code.");
  });

  it("takes resend typed at a question that offers none as what was typed", async () => {
    const { answer, shown } = await typed("resend", false);
    expect(answer).toEqual({ type: "secret", value: "resend" });
    expect(shown.join("")).not.toContain("Type resend");
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

  const phoneStep = { page: `${site}/login`, fields: [{ selector: "#phone", accepts: ["phone"] }], submit: "#send" };
  const recorded = { page: `${site}/verify`, fields: [codeStep], submit: "#verify", resend: "#resend" };
  const recipe = { version: 12, steps: [phoneStep, recorded], signedIn: { selector: "#account" } };

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
});

describe("a press under a sign-in's bound", () => {
  const code = { step: { fields: [{ selector: "#code", slot: "code" as const }], submit: "#resend" }, inspection: {} as never };
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
  const inspect = (step: AutofillStep) =>
    Effect.sync(() => ({
      url: `${origin}/code`,
      page: `${origin}/code`,
      targets: { fields: step.fields.map(() => target), submit: target },
      siteOrigin: origin,
      authenticationOrigins: [],
      screen: { origin, fields: [], submit: null, buttons: [] },
    }));
  const build = (answers: readonly string[]) => {
    const asked: Request[] = [];
    const queue = [...answers];
    const pressed: string[] = [];
    const inspected: AutofillStep[] = [];
    const recorder = makeSignInRecorder({
      browser: {
        inspect: (step) => {
          inspected.push(step);
          return inspect(step);
        },
        fill: ({ step }) =>
          Effect.succeed({
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/next`,
          }),
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
      review: () => Effect.void,
      site: "example.test",
      signedOutPages: () => [],
    });
    return { recorder, asked, pressed, inspected };
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
    "A code step's resend names the screen's own control that asks the site to send a new code, such as Resend code or Send again: allow it when it is that control, since the host presses it only when the owner answers the code question by asking for a new code, never by itself, once the site enables it; deny a resend that signs in, submits the code or takes any other action.",
  );
  expect(policy).toContain("clicks its submit, Next, Continue, send-code or resend control");
});
