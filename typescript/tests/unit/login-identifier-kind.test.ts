// Failure modes covered: a terminal answer to a login that offers several identifier kinds sent
// with no kind, which validation refuses, or with the wrong kind for its shape; a login prompt that
// says "Username" for a phone number; and an MCP caller told nothing of a login answer's kind or
// that a password-free login takes no password; and a phone login written outside the phone's shape
// taken from any surface, whose digits a picker would type and whose echo no masking would match,
// or a host's handle refused as such a number.
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Cause, Effect, Either, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  identifierKindOf,
  identifierLabel,
  makeTerminalAsker,
} from "../../src/inputs/terminal.js";
import { getRuntimeSources } from "../../src/execution/runtime-sources.js";
import { InputRequest, validateAnswer } from "../../src/runtime/input-request.js";
import { makeMcpJobs, mcpFailureMessage } from "../../src/standalone/mcp-jobs.js";
import { makePomeradoMcp } from "../../src/standalone/mcp-server.js";

describe("the terminal's login identifier", () => {
  it("labels the prompt by the kinds the login offers", () => {
    expect(identifierLabel(["phone"])).toBe("Phone number");
    expect(identifierLabel(["username"])).toBe("Username");
    expect(identifierLabel(["email", "phone"])).toBe("Email or phone number");
    expect(identifierLabel(["username", "email", "phone", "account_number"])).toBe(
      "Username, email, phone number or account number",
    );
  });

  it("takes the one kind offered, whatever the answer's shape", () => {
    expect(identifierKindOf("ada-owner", ["phone"])).toBe("phone");
    expect(identifierKindOf("+91 98123 45678", ["email"])).toBe("email");
  });

  it("reads an email address or a phone number by its shape among the kinds offered", () => {
    expect(identifierKindOf("ada@shop.example", ["email", "phone"])).toBe("email");
    expect(identifierKindOf("+91 98123 45678", ["email", "phone"])).toBe("phone");
    expect(identifierKindOf("ada@shop.example", ["username", "email"])).toBe("email");
    expect(identifierKindOf("(555) 010-4477", ["username", "phone"])).toBe("phone");
  });

  it("takes the one other kind offered for an answer of neither shape", () => {
    expect(identifierKindOf("ada-owner", ["username", "email", "phone"])).toBe("username");
    expect(identifierKindOf("AC-1042", ["email", "account_number"])).toBe("account_number");
  });

  it("leaves the kind to the owner when the answer's shape fits none or several offered", () => {
    expect(identifierKindOf("ada-owner", ["email", "phone"])).toBeUndefined();
    expect(identifierKindOf("AC-1042", ["username", "account_number"])).toBeUndefined();
  });

  it("leaves digits alone to the owner when a kind besides the phone also takes them", () => {
    expect(identifierKindOf("123456789", ["phone", "account_number"])).toBeUndefined();
    expect(identifierKindOf(" 12345678 ", ["username", "phone"])).toBeUndefined();
    // A phone number written as one, or digits where no other kind takes them, stays a phone.
    expect(identifierKindOf("+919812345678", ["phone", "account_number"])).toBe("phone");
    expect(identifierKindOf("(555) 010-4477", ["username", "phone"])).toBe("phone");
    expect(identifierKindOf("12345678", ["email", "phone"])).toBe("phone");
  });
});

describe("a terminal answer to a password-free login by email or phone", () => {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  afterEach(() => {
    if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
    vi.restoreAllMocks();
  });

  /** Asks the login, typing each reply once the prompt it answers shows; keeps what was shown. */
  const answer = async (replies: Readonly<Record<string, string>>) => {
    const input = new PassThrough();
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    const shown: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      const text = String(chunk);
      shown.push(text);
      const reply = replies[text];
      if (reply !== undefined) setImmediate(() => input.write(`${reply}\n`));
      return true;
    });
    const answered = await Effect.runPromise(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "login",
            type: "credential",
            prompt: "Sign in to the website so this request can continue.",
            fields: "username_password",
            reason: "missing_credentials",
            allowSave: false,
            siteOrigin: "https://shop.example",
            currentStep: { identifierKinds: ["email", "phone"], password: false },
          },
        ],
      }),
    );
    return { login: answered["login"], shown };
  };

  it("sends the kind the answer's shape shows, and asks no password", async () => {
    const { login, shown } = await answer({ "Email or phone number: ": "ada@shop.example" });
    expect(login).toEqual({
      type: "credential",
      value: { identifierKind: "email", username: "ada@shop.example", saveLogin: false },
    });
    expect(shown).not.toContain("Password: ");
  });

  it("asks which kind an answer of neither shape is", async () => {
    const { login } = await answer({ "Email or phone number: ": "ada-owner", "> ": "2" });
    expect(login).toEqual({
      type: "credential",
      value: { identifierKind: "phone", username: "ada-owner", saveLogin: false },
    });
  });
});

describe("a login answer of the phone kind", () => {
  const loginQuestion = (identifierKinds: readonly string[]) =>
    Schema.decodeUnknownSync(InputRequest)({
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in to the website so this request can continue.",
          fields: "username_password",
          reason: "missing_credentials",
          allowSave: false,
          siteOrigin: "https://shop.example",
          currentStep: { identifierKinds, password: false },
        },
      ],
    });
  const outsideTheShape = [
    "+91/98765/00000",
    "+91\u201398765\u201300000",
    "+44 7700,900123",
    "0170/5550100",
    "+49 170 5550100 ext 12",
    "+(49) 170 5550100 ext 12",
    "+-49 170 5550100 ext 12",
    "\u0967\u0968\u0969\u096a\u096b\u096c\u096d\u096e",
    "12345",
  ];

  it.each(outsideTheShape)("refuses a number outside the phone shape, %s", (username) => {
    for (const answer of [
      { username, saveLogin: false },
      { identifierKind: "phone", username, saveLogin: false },
    ]) {
      const checked = validateAnswer(loginQuestion(["phone"]), { login: answer });
      expect(Either.isLeft(checked) && checked.left).toMatchObject({
        reason: "phone_unshaped",
        questionId: "login",
      });
    }
  });

  it.each([
    "+91 98765 00000",
    "(0170) 555-0100",
    "0170.555.0100",
    "+298 555012",
    "(+91) 98765 00000",
    "(0091) 98765 00000",
    // Marks a number copied from a contact or a page may carry.
    "\u200e+91 98765 00000",
    "\u202a+91 98765 00000\u202c",
    "+91\u200b98765\u200b00000",
  ])(
    "takes a number of the phone shape, %s",
    (username) => {
      const checked = validateAnswer(loginQuestion(["phone"]), {
        login: { identifierKind: "phone", username, saveLogin: false },
      });
      expect(Either.isRight(checked)).toBe(true);
    },
  );

  it.each([
    "sec_phone",
    "sec_1234567890",
    "ada@shop.example",
    "ada-owner",
    "001a2b345678",
    "00 91 98765 00000 ext 12",
  ])(
    "takes a host's handle or another value that isn't written as a number, %s",
    (username) => {
      const checked = validateAnswer(loginQuestion(["phone"]), {
        login: { identifierKind: "phone", username, saveLogin: false },
      });
      expect(Either.isRight(checked)).toBe(true);
    },
  );

  it.each(["username", "email", "account_number"])(
    "leaves the same text alone as a login of kind %s",
    (identifierKind) => {
      const checked = validateAnswer(loginQuestion(["phone", identifierKind]), {
        login: { identifierKind, username: "0170/5550100", saveLogin: false },
      });
      expect(Either.isRight(checked)).toBe(true);
    },
  );

  it("leaves a password-only login of that kind alone, which holds no username to check", () => {
    const request = Schema.decodeUnknownSync(InputRequest)({
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in to the website so this request can continue.",
          fields: "password",
          reason: "invalid_credentials",
          allowSave: false,
          siteOrigin: "https://shop.example",
          currentStep: { identifierKinds: ["phone"], password: true },
        },
      ],
    });
    const checked = validateAnswer(request, { login: { password: "synthetic", saveLogin: false } });
    expect(Either.isRight(checked)).toBe(true);
  });

  it("fails a host's answer, so nothing it holds reaches a screen", async () => {
    const ask = makeInputAsker(() =>
      Effect.succeed({ login: { identifierKind: "phone", username: "0170/5550100", saveLogin: false } }),
    );
    const failed = await Effect.runPromise(Effect.flip(ask(loginQuestion(["phone"]))));
    expect(failed).toMatchObject({ code: "Invalid", operation: "validateAnswer" });
  });

  it("is checked without the sign-in code, which a minted tool's runtime never loads", () => {
    const loaded = getRuntimeSources().map(([path]) => path);
    expect(loaded).toContain("runtime/input-request.js");
    expect(loaded).not.toContain("runtime/login-values.js");
  });

  it("tells an MCP caller how to write the number, and keeps the question pending", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run");
          const started = yield* jobs.start((ask) => ask(loginQuestion(["phone"])));
          let view = yield* jobs.get(started.job_id, 200);
          for (let attempt = 0; attempt < 20 && view.status !== "input_required"; attempt++)
            view = yield* jobs.get(started.job_id, 200);
          const requestId = "pending_input" in view ? (view.pending_input?.id ?? "") : "";
          const login = (username: string) => ({ login: { username, saveLogin: false } });
          const refused = yield* Effect.flip(
            jobs.provide(started.job_id, requestId, login("0170/5550100")),
          );
          const still = yield* jobs.get(started.job_id);
          yield* jobs.provide(started.job_id, requestId, login("0170 5550100"));
          let done = yield* jobs.get(started.job_id, 200);
          for (let attempt = 0; attempt < 20 && done.status === "running"; attempt++)
            done = yield* jobs.get(started.job_id, 200);
          return { message: mcpFailureMessage(Cause.fail(refused), "run"), still: still.status, done };
        }),
      ),
    );
    expect(outcome.message).toBe(
      "This phone number can't be used as written: send it with an optional leading + and the country code, at least 7 digits, and only spaces, dots, dashes or brackets between them.",
    );
    expect(outcome.still).toBe("input_required");
    expect(outcome.done).toMatchObject({
      status: "completed",
      output: { login: { type: "credential", value: { username: "0170 5550100" } } },
    });
  });

  describe("at the terminal", () => {
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    afterEach(() => {
      if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
      vi.restoreAllMocks();
    });

    /** Answers the login by typing each of `lines` at its prompt in turn; keeps what was shown. */
    const answer = async (lines: readonly string[], kinds: readonly string[]) => {
      const input = new PassThrough();
      Object.defineProperty(process, "stdin", { value: input, configurable: true });
      const shown: string[] = [];
      const queue = [...lines];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        const text = String(chunk);
        shown.push(text);
        if (text.endsWith(": ") || text === "> ")
          setImmediate(() => input.write(`${queue.shift() ?? ""}\n`));
        return true;
      });
      const answered = await Effect.runPromise(makeTerminalAsker()(loginQuestion(kinds)));
      return { login: answered["login"], shown: shown.join("") };
    };
    const rewrite =
      "Write the phone number with an optional leading + and the country code, at least 7 digits, and only spaces, dots, dashes or brackets between them.";

    it("asks again for a number outside the phone shape", async () => {
      const { login, shown } = await answer(["0170/5550100", "0170 5550100"], ["phone"]);
      expect(login).toEqual({
        type: "credential",
        value: { identifierKind: "phone", username: "0170 5550100", saveLogin: false },
      });
      expect(shown).toContain(rewrite);
    });

    it("asks again when the owner says such an answer is a phone number", async () => {
      const { login, shown } = await answer(
        ["+49 170/5550100", "2", "ada@shop.example"],
        ["email", "phone"],
      );
      expect(login).toEqual({
        type: "credential",
        value: { identifierKind: "email", username: "ada@shop.example", saveLogin: false },
      });
      expect(shown).toContain(rewrite);
    });

    it("takes such an answer as another kind the login offers", async () => {
      const { login, shown } = await answer(["0170/5550100"], ["username", "phone"]);
      expect(login).toEqual({
        type: "credential",
        value: { identifierKind: "username", username: "0170/5550100", saveLogin: false },
      });
      expect(shown).not.toContain(rewrite);
    });
  });
});

it("tells an MCP caller how a login names its kind, and when it has no password", async () => {
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
  expect(description).toContain('"identifierKind"');
  expect(description).toContain("currentStep.identifierKinds");
  expect(description).toContain("currentStep.password is false");
});
