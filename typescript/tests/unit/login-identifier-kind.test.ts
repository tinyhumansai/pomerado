// Failure modes covered: a terminal answer to a login that offers several identifier kinds sent
// with no kind, which validation refuses, or with the wrong kind for its shape; a login prompt that
// says "Username" for a phone number; and an MCP caller told nothing of a login answer's kind or
// that a password-free login takes no password.
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  identifierKindOf,
  identifierLabel,
  makeTerminalAsker,
} from "../../src/inputs/terminal.js";
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
