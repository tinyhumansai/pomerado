import { createInterface, emitKeypressEvents } from "node:readline";
import { Effect } from "effect";
import { makeInputAsker } from "./callback.js";
import { InputRequestFailure, publicOptionLabel } from "../runtime/input-request.js";
import type { CurrentLoginStep, InputAnswers, Question } from "../runtime/input-request.js";
import { emailShaped, phoneShaped, unshapedPhone } from "../runtime/login-values.js";

/**
 * The owner pressed Ctrl-C or Ctrl-D, or closed the input, at a question. It stays `NoResponse` for
 * everything that reads the code. A run's popup decision tells it apart from a window that ended
 * unanswered: the owner's cancel stops the step, where an unanswered popup is dismissed.
 */
export class OwnerCancelled extends InputRequestFailure {}
const cancelled = () => new OwnerCancelled({ code: "NoResponse" });
const cancelKeys = new Set<string | undefined>(["c", "d"]);
const submitKeys = new Set<string | undefined>(["return", "enter"]);
const containsControlCharacters = (text: string) =>
  Array.from(text).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

const line = (prompt: string, masked = false) =>
  Effect.async<string, InputRequestFailure>((resume) => {
    const input = process.stdin;
    const output = process.stderr;
    if (masked && !input.isTTY) {
      resume(
        Effect.fail(
          new InputRequestFailure({ code: "Unavailable", operation: "secret_input_requires_tty" }),
        ),
      );
      return;
    }
    if (!masked) {
      const reader = createInterface({ input, output, terminal: input.isTTY });
      let answered = false;
      const stop = () => {
        if (!answered) resume(Effect.fail(cancelled()));
      };
      reader.on("SIGINT", stop);
      reader.on("close", stop);
      reader.question(prompt, (value) => {
        answered = true;
        reader.close();
        resume(Effect.succeed(value));
      });
      return Effect.sync(() => {
        answered = true;
        reader.close();
      });
    }
    const previousRaw = input.isRaw;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(prompt);
    let value = "";
    let done = false;
    const cleanup = () => {
      input.off("keypress", keypress);
      input.off("end", end);
      input.setRawMode(previousRaw);
      input.pause();
    };
    const finish = (result: Effect.Effect<string, InputRequestFailure>) => {
      if (done) return;
      done = true;
      cleanup();
      output.write("\n");
      resume(result);
    };
    const end = () => finish(Effect.fail(cancelled()));
    const keypress = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && cancelKeys.has(key.name)) return end();
      if (submitKeys.has(key.name)) return finish(Effect.succeed(value));
      if (key.name === "backspace") {
        const last = Array.from(new Intl.Segmenter().segment(value)).at(-1);
        value = value.slice(0, last?.index ?? 0);
        return;
      }
      if (!key.ctrl && !key.meta && text !== undefined && !containsControlCharacters(text)) {
        if (value.length + text.length <= 16_384) value += text;
      }
    };
    input.on("keypress", keypress);
    input.on("end", end);
    return Effect.sync(cleanup);
  });

const answerChoices = (question: Extract<Question, { readonly type: "choice" | "multi_choice" }>) =>
  Effect.gen(function* () {
    for (const [index, option] of question.options.entries())
      process.stderr.write(`${index + 1}. ${publicOptionLabel(option)}\n`);
    const reply = (yield* line(
      question.type === "multi_choice" ? "Numbers separated by commas: " : "> ",
    )).trim();
    const selected = (part: string) => question.options[Number(part) - 1]?.id ?? part;
    const offered = (id: string) => question.options.some((option) => option.id === id);
    const ownWords = question.allowOther === true;
    const parts =
      question.type === "multi_choice"
        ? reply === ""
          ? []
          : reply.split(",").map((part) => selected(part.trim()))
        : [selected(reply)];
    // Anything but an option's number or id is the caller's own text, where it is allowed.
    const picks = ownWords ? parts.filter(offered) : parts;
    const own =
      ownWords && picks.length < parts.length
        ? question.type === "choice"
          ? reply
          : parts.filter((id) => !offered(id)).join(", ")
        : undefined;
    if (question.type === "choice" && own !== undefined) return { other: own };
    const note =
      question.allowNote === true
        ? (yield* line("Add a note (optional, Enter to skip): ")).trim()
        : "";
    if (question.type === "choice") return note === "" ? picks[0] : { option: picks[0], note };
    return own === undefined && note === ""
      ? picks
      : {
          options: picks,
          ...(own === undefined ? {} : { other: own }),
          ...(note === "" ? {} : { note }),
        };
  });

/** An identifier kind a login question may offer (`CurrentLoginStep`). */
type LoginKind = CurrentLoginStep["identifierKinds"][number];

const kindNames: Record<LoginKind, string> = {
  username: "username",
  email: "email",
  phone: "phone number",
  account_number: "account number",
};

/** `text` with its first letter in upper case. */
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The login prompt's name for the identifier kinds a question offers: "Email or phone number". */
export const identifierLabel = (kinds: readonly LoginKind[]) => {
  const names = kinds.map((kind) => kindNames[kind]);
  const last = names.pop() ?? kindNames.username;
  return capitalized(names.length === 0 ? last : `${names.join(", ")} or ${last}`);
};

/**
 * The kind of identifier an answer is, among the kinds a login question offers: the one kind
 * offered; else an email-shaped answer is an email address and one shaped like a phone number a
 * phone number, where offered (`emailShaped`, `phoneShaped`), and an answer of neither shape the
 * one other kind offered, a username or an account number. Undefined when the answer's shape fits
 * none of the kinds offered or several, as digits alone do where a username or an account number
 * is offered beside a phone number, so the owner is asked which it is.
 */
export const identifierKindOf = (
  value: string,
  kinds: readonly LoginKind[],
): LoginKind | undefined => {
  if (kinds.length === 1) return kinds[0];
  if (kinds.includes("email") && emailShaped(value)) return "email";
  const digitsAlone = /^\d+$/u.test(value.trim());
  const takesDigits = kinds.includes("username") || kinds.includes("account_number");
  if (kinds.includes("phone") && phoneShaped(value))
    return digitsAlone && takesDigits ? undefined : "phone";
  const others = kinds.filter((kind) => kind !== "email" && kind !== "phone");
  return others.length === 1 ? others[0] : undefined;
};

/** Asks which of the kinds offered the identifier just typed is, by number or name. */
const askKind = (kinds: readonly LoginKind[]) =>
  Effect.gen(function* () {
    process.stderr.write("Which is it?\n");
    for (const [index, kind] of kinds.entries())
      process.stderr.write(`${index + 1}. ${capitalized(kindNames[kind])}\n`);
    for (;;) {
      const reply = (yield* line("> ")).trim().toLowerCase();
      const kind =
        kinds[Number(reply) - 1] ?? kinds.find((offered) => kindNames[offered] === reply);
      if (kind !== undefined) return kind;
    }
  });

const answerQuestion = (question: Question): Effect.Effect<unknown, InputRequestFailure> =>
  Effect.gen(function* () {
    process.stderr.write(`\n${question.prompt}\n`);
    switch (question.type) {
      case "text":
        return yield* line("> ");
      case "secret": {
        // A code question that offers a resend takes the word resend as the request for one; one
        // that offers none says so and asks again, so the word is never typed as the code.
        if (question.allowResend === true)
          process.stderr.write("Type resend to have the site send a new code.\n");
        for (;;) {
          const typed = yield* line("> ", true);
          if (typed.trim().toLowerCase() !== "resend") return typed;
          if (question.allowResend === true) return { resend: true };
          if (question.secretKind !== "one_time_code") return typed;
          process.stderr.write("No new code can be asked for here. Type the code the site sent.\n");
        }
      }
      case "credential": {
        // A login that offers identifier kinds is asked for by them, and its answer says its kind.
        const kinds = question.currentStep?.identifierKinds ?? [];
        const label = kinds.length === 0 ? "Username" : identifierLabel(kinds);
        // A phone number the host can't use is asked again, as validation would end the login.
        for (;;) {
          const username =
            question.fields === "username_password"
              ? yield* line(
                  question.allowDecline === true
                    ? `${label} (leave empty to go on without signing in): `
                    : `${label}: `,
                )
              : undefined;
          // An empty username, where the question offers it, declines the login.
          if (question.allowDecline === true && username?.trim() === "")
            return { declined: "public_only", saveLogin: false };
          const identifierKind =
            username === undefined || kinds.length === 0
              ? undefined
              : (identifierKindOf(username, kinds) ?? (yield* askKind(kinds)));
          if (identifierKind === "phone" && unshapedPhone(username ?? "")) {
            process.stderr.write(
              "Write the phone number with digits, spaces, dots, dashes or brackets alone.\n",
            );
            continue;
          }
          const login = {
            ...(identifierKind === undefined ? {} : { identifierKind }),
            ...(username === undefined ? {} : { username }),
          };
          // A sign-in that types no password, such as by a phone number and a code, asks for none.
          if (question.currentStep?.password === false) return { ...login, saveLogin: false };
          const password = yield* line("Password: ", true);
          return { ...login, password, saveLogin: false };
        }
      }
      case "confirm": {
        const reply = (yield* line("[y/N] ")).trim().toLowerCase();
        const confirmed = ["y", "yes"].includes(reply);
        const text =
          confirmed && question.followUp !== undefined
            ? yield* line(`${question.followUp.prompt} `)
            : undefined;
        return { confirmed, ...(text === undefined ? {} : { text }) };
      }
      case "choice":
      case "multi_choice":
        return yield* answerChoices(question);
    }
  });

/** Terminal is one caller surface, with secrets collected without echo or persistence. */
export const makeTerminalAsker = () =>
  makeInputAsker((request) =>
    Effect.gen(function* () {
      if (request.notice !== undefined) process.stderr.write(`\n${request.notice}\n`);
      const answers: Record<string, unknown> = {};
      for (const question of request.questions)
        answers[question.id] = yield* answerQuestion(question);
      return answers satisfies InputAnswers;
    }),
  );
