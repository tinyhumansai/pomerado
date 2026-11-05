import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { heldPhoneDigits } from "../../src/destinations/login-field-formats.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";

const secret = "  correct  horse\tbattery  ";
const registered = (value = secret) => {
  const secrets = makeRunSecrets();
  secrets.register(value);
  return secrets;
};

describe("makeRunSecrets", () => {
  it.each([
    ["as given", secret],
    ["URL-encoded", encodeURIComponent(secret)],
    ["JSON-escaped", JSON.stringify(secret).slice(1, -1)],
    ["trimmed", "correct  horse\tbattery"],
    ["with its whitespace collapsed, as a page snapshot shows it", "correct horse battery"],
    [
      "form-encoded, with + for each space, as a query string carries it",
      "++correct++horse%09battery++",
    ],
    ["trimmed and form-encoded", "correct++horse%09battery"],
    ["collapsed and URL-encoded", "correct%20horse%20battery"],
    ["base64-encoded", Buffer.from(secret).toString("base64")],
  ])("redacts a secret %s", (_, shown) => {
    expect(registered().redact(`before ${shown} after`)).toBe("before [private] after");
    expect(Either.isLeft(Effect.runSync(Effect.either(registered().assertAbsent(shown))))).toBe(
      true,
    );
  });

  // An accessibility snapshot single-quotes a key that needs it and doubles each ' in it; a key
  // holds the name JSON-stringified. A quoted value writes other control characters as \xNN.
  it.each([
    [
      "with each ' doubled, as a quoted snapshot key shows it",
      "o'brien@example.com",
      "o''brien@example.com",
    ],
    ["JSON-escaped with each ' doubled", 'say "o\'hi"', "say \\\"o''hi\\\""],
    [
      "with control characters written as \\xNN, as a quoted snapshot value shows it",
      "ctl\u0007bell\u0085",
      "ctl\\x07bell\\x85",
    ],
    ["percent-encoded in lowercase hex", "a/b=c", "a%2fb%3dc"],
    ["as a URL's query carries it", "o'brien {x}", "o%27brien%20{x}"],
    ["as a URL's path carries it", "o'brien {x}", "o'brien%20%7Bx%7D"],
    ["with | encoded as a URL's path carries it", "a$b|c", "a$b%7Cc"],
    ["with ^ encoded as a URL's path carries it", "user@x^y", "user@x%5Ey"],
    ["with \\ turned into / as a URL's path carries it", "a\\b$c", "a/b$c"],
    ["without its tab, which a URL drops", "a\tb|c", "ab%7Cc"],
    ["as a URL's fragment carries it", "o'brien `x`", "o'brien%20%60x%60"],
  ])("redacts a secret %s", (_, value, shown) => {
    expect(registered(value).redact(`before ${shown} after`)).toBe("before [private] after");
  });

  it("keeps every form it can encode for a secret holding a lone surrogate", () => {
    const secrets = makeRunSecrets();
    expect(() => secrets.register("ab\ud800cd")).not.toThrow();
    expect(secrets.redact("x ab\ud800cd y")).toBe("x [private] y");
    expect(secrets.redact("x ab\\ud800cd y")).toBe("x [private] y");
  });

  it("collapses whitespace as the page snapshot does, dropping zero-width characters", () => {
    expect(registered("one​ two­\nthree").redact("one two three")).toBe("[private]");
  });

  it("adds no empty form for a secret of whitespace alone", () => {
    expect(registered("   ").redact("a b")).toBe("a b");
  });

  const absent = (secrets: ReturnType<typeof registered>, text: string) =>
    Either.isRight(Effect.runSync(Effect.either(secrets.assertAbsent(text))));

  // Redaction feeds everything a model sees, so it masks every form wherever it appears: a short
  // code that page code glued to letters, in a field's value or a URL path, is masked too, even
  // at the cost of masking a short answer inside longer words.
  it("redacts a short secret wherever it appears, glued to other text included", () => {
    const code = registered("123456");
    expect(code.redact('textbox "Code" value="A123456"')).toBe('textbox "Code" value="A[private]"');
    expect(code.redact("/verify/otp123456/next")).toBe("/verify/otp[private]/next");
    expect(registered("red").redact("required credit")).toBe("requi[private] c[private]it");
    expect(registered("red").redactCut("from her")).toBe("from he");
  });

  // Source a model wrote, or host-redacted captures, holds a short secret only by chance, so the
  // source-read check counts one only as a whole token, as the submission guard finds a code: an
  // all-digit form where no digit adjoins it, any other where no letter, mark or digit does.
  it("refuses source with a short secret only where it stands as a token", () => {
    const answer = registered("red");
    expect(absent(answer, "required ordered shared credit Ordered")).toBe(true);
    for (const shown of [
      "my answer is red",
      "red",
      '{"answer":"red"}',
      "/login?answer=red&next=1",
      'textbox "Answer": red',
    ])
      expect(absent(answer, shown)).toBe(false);
    const code = registered("482913");
    expect(absent(code, "ts=1759482913123")).toBe(true);
    expect(absent(code, "otp=482913;")).toBe(false);
    expect(absent(code, "const id = 'A482913';")).toBe(false);
    expect(absent(code, "/verify/otp482913/next")).toBe(false);
  });

  it("still refuses source with a longer secret inside other text", () => {
    const secrets = registered("hunter22");
    expect(secrets.redact("xhunter22y")).toBe("x[private]y");
    expect(absent(secrets, "xhunter22y")).toBe(false);
  });

  it("drops the prefix of a secret that a cut split at the end of the text", () => {
    const secrets = registered("fixture-private-value");
    expect(secrets.redactCut("page text fixture-priv")).toBe("page text ");
    expect(secrets.redactCut("page fixture-private-value tail")).toBe("page [private] tail");
    expect(secrets.redactCut("ends fixture-private-value")).toBe("ends [private]");
    // A cut through a character of several bytes reads back as one replacement character.
    expect(secrets.redactCut("page text fixture-priv\uFFFD")).toBe("page text ");
    // A collapsed form split by the cut leaves nothing of itself either.
    expect(
      registered("correct  horse  battery").redactCut('textbox "Code": correct horse ba'),
    ).toBe('textbox "Code": ');
  });
});

describe("a phone number", () => {
  const phone = (number: string) => {
    const secrets = makeRunSecrets();
    secrets.register(number, "phone");
    return secrets;
  };
  const refused = (secrets: ReturnType<typeof phone>, text: string) =>
    Either.isLeft(Effect.runSync(Effect.either(secrets.assertAbsent(text))));

  it.each([
    ["+919876543210", "+919876543210"],
    ["+919876543210", "+91 98765 43210"],
    ["+919876543210", "+91-98765-43210"],
    ["+919876543210", "919876543210"],
    ["+919876543210", "9876543210"],
    ["+919876543210", "98765 43210"],
    ["+919876543210", "09876543210"],
    ["+919876543210", "+91 (0) 98765 43210"],
    ["+919876543210", "00919 8765 43210"],
    ["+919876543210", "00 91 98765 43210"],
    ["+919876543210", "%2B%2091%2098765%2043210"],
    ["+15555550123", "+1 (555) 555-0123"],
    ["+15555550123", "(555) 555-0123"],
    ["+15555550123", "555.555.0123"],
    ["+15555550123", "1-555-555-0123"],
    ["+15555550123", "+1\u00a0555\u00a0555\u20110123"],
    ["+15555550123", "%2B1%20(555)%20555-0123"],
    ["+15555550123", "?phone=%28555%29%20555-0123"],
    ["+15555550123", "?msg=sent%20to%20555-555-0123"],
    ["+15555550123", "?msg=sent%20to%201%20555%20555%200123"],
    ["+15555550123", "555\u2212555\u22120123"],
    ["+15555550123", "555\u00b7555\u00b70123"],
    ["+15555550123", "[555] 555 0123"],
    ["+15555550123", "555,555,0123"],
    ["+15555550123", "+1: 555: 555: 0123"],
    ["+15555550123", "555_555_0123"],
    ["00447700900123", "+44 7700 900123"],
    ["+44 7700 900123", "07700 900123"],
    ["07700 900123", "+44 7700 900123"],
    ["9876543210", "(987) 654-3210"],
    ["9876543210", "+91 98765 43210"],
  ])("masks and refuses %s as a page writes it: %s", (number, shown) => {
    const secrets = phone(number);
    const masked = secrets.redact(`Sent to ${shown}.`);
    expect(masked).toContain("[private]");
    expect(masked).not.toMatch(/[0-9]{3}/u);
    expect(refused(secrets, `const shown = "${shown}";`)).toBe(true);
  });

  // A phone box the host followed may hold any of these (`heldPhoneDigits`), which it reads back
  // as digits alone: a page that writes one out shows nothing of the number either.
  it.each([
    "+919876543210",
    "00 91 98765 43210",
    "+1 (555) 555-0123",
    "+44 7700 900123",
    "07700 900123",
    "+39 06 1234 5678",
  ])("masks and refuses each form a phone box may hold for %s", (number) => {
    const secrets = phone(number);
    const { whole, national } = heldPhoneDigits(number);
    for (const form of [...whole, ...national]) {
      const masked = secrets.redact(`Held ${form}.`);
      expect(masked).toContain("[private]");
      expect(masked).not.toMatch(/[1-9]/u);
      expect(refused(secrets, `const held = "${form}";`)).toBe(true);
    }
  });

  // Answers of a phone kind are refused at this shape, but a saved login's or another kind's value
  // never met that check, and a site still writes it back in its own format.
  it.each([
    ["+91/98765/00000", ["+91 98765 00000", "98765-00000", "9876500000"]],
    ["+91\u201398765\u201300000", ["+91 98765 00000", "98765 00000", "9876500000"]],
    ["+44 7700,900123", ["+44 7700 900123", "07700 900123", "7700900123"]],
    ["(0091) 98765 00000", ["+91 98765 00000", "98765-00000", "9876500000"]],
    ["(+91) 98765 00000", ["+91 98765 00000", "98765-00000", "9876500000"]],
    ["\u200e+91 98765 00000", ["+91 98765 00000", "98765-00000", "9876500000"]],
    ["0170/5550100", ["0170 5550100", "170/5550100", "1705550100"]],
  ])("masks and refuses a number outside the phone shape, %s", (number, shown) => {
    const secrets = phone(number);
    expect(secrets.redact(number)).toBe("[private]");
    for (const form of shown) {
      expect(secrets.redact(`Sent to ${form}.`)).toBe("Sent to [private].");
      expect(refused(secrets, `const shown = "${form}";`)).toBe(true);
    }
  });

  // A saved login or a login of another kind may hold an extension, whose digits aren't the number's.
  it.each([
    "+91 98765 00000 ext 12",
    "+91 98765 00000 x12",
    "+(91) 98765 00000 ext. 12",
    "+91 98765 00000 #12",
    "00 91 98765 00000 #12",
  ])(
    "masks and refuses the number before an extension, %s",
    (number) => {
      const secrets = phone(number);
      expect(secrets.redact(`Sent to ${number}.`)).toBe("Sent to [private].");
      for (const form of ["+91 98765 00000", "98765-00000", "9876500000", "098765 00000"]) {
        expect(secrets.redact(`Sent to ${form}.`)).toBe("Sent to [private].");
        expect(refused(secrets, `const shown = "${form}";`)).toBe(true);
      }
    },
  );

  // A login of digits may turn up inside a timestamp or an id, which then stands as it is.
  it("counts a value of digits as given only where no digit adjoins it", () => {
    const secrets = phone("5550123");
    expect(refused(secrets, "id=1755501234")).toBe(false);
    expect(Effect.runSync(secrets.json({ ts: 1755501234 }))).toEqual({ ts: 1755501234 });
    expect(secrets.redact("Sent to 5550123.")).toBe("Sent to [private].");
    expect(refused(secrets, 'const login = "5550123";')).toBe(true);
    expect(Effect.runSync(secrets.json({ login: 5550123 }))).toEqual({ login: "[private]" });
  });

  it("still counts as given a value that ends in digits, beside what isn't a digit", () => {
    const secrets = phone("(0091) 98765 00000");
    expect(secrets.redact("Sent to (0091) 98765 00000, today.")).toBe("Sent to [private], today.");
  });

  // A number is typed without the invisible marks it was pasted with (`typedValues`).
  it("masks and refuses a number in the form it is typed in, without its marks", () => {
    const secrets = phone("\u202a0555012\u202c");
    expect(secrets.redact("Sent to 0555012.")).toBe("Sent to [private].");
    expect(refused(secrets, 'const typed = "0555012";')).toBe(true);
    expect(secrets.redact("order 90555012")).toBe("order 90555012");
    expect(refused(secrets, "90555012")).toBe(false);
  });

  it("registers nothing more for a value of marks alone", () => {
    expect(phone("\u202a\u202c").redact("Sent to 1234.")).toBe("Sent to 1234.");
  });

  // A `#` ends a number only after a digit: before them it ends nothing, as in a login of digits.
  it.each(["#1234567", "# 1234567"])("masks and refuses the digits behind a lead of #: %s", (login) => {
    const secrets = phone(login);
    expect(secrets.redact("Sent to 1234567.")).toBe("Sent to [private].");
    expect(refused(secrets, 'const shown = "123 4567";')).toBe(true);
  });

  it("leaves another number and a longer run of digits as they are", () => {
    const secrets = phone("+15555550123");
    for (const text of [
      "+1 (555) 555-0124",
      "001 555 555 0124",
      "1-555-555-01234",
      "555-0123",
      "order 555 01",
      "555,555,0124",
      "[1, 555, 555, 01234]",
      "555_555_01234",
      "2026-11-06 12:30:45",
      "12:30, 555_0123",
    ]) {
      expect(secrets.redact(text)).toBe(text);
      expect(refused(secrets, text)).toBe(false);
    }
  });

  it("registers a value of no phone shape only as given, as a host's handle is", () => {
    const secrets = phone("sec_1234567890");
    expect(secrets.redact("sec_1234567890 1234567890")).toBe("[private] 1234567890");
  });

  it.each([
    ["a handle that starts as a number written in international form does", "00ab12345678", "12345678"],
    ["a value that holds a letter and has no plus, as a handle may", "00 91 98765 00000 ext 12", "9876500000"],
    ["an email address", "ada.5550100123@example.test", "5550100123"],
  ])("registers %s only as given", (_name, value, digits) => {
    const secrets = phone(value);
    expect(secrets.redact(`${value} ${digits}`)).toBe(`[private] ${digits}`);
  });

  // A number of few digits, as some countries' are, counts wherever its calling code stands with it.
  it.each([
    "+298 555012",
    "+298 55 50 12",
    "+298-555-012",
    "(+298) 555012",
    "00298 555012",
    "+298 0555012",
    "%2B298%20555012",
    "?phone=%2B298555012",
    "+ 298 55 50 12",
    "00 298 55 50 12",
    "+(298) 555012",
    "%2B%20298%20555012",
  ])("masks and refuses a short number with its calling code: %s", (shown) => {
    const secrets = phone("+298 555012");
    const masked = secrets.redact(`Sent to ${shown}.`);
    expect(masked).toContain("[private]");
    expect(masked).not.toMatch(/[0-9]{3}/u);
    expect(refused(secrets, `const shown = "${shown}";`)).toBe(true);
  });

  it.each([
    "555012",
    "55 50 12",
    "298555012",
    "298 55 50 12",
    "+299 555012",
    "+298 555013",
    "+555012",
    "+ 555012",
    "+ 299 555012",
    "100 298 555012",
    "00 555012",
  ])(
    "leaves what only looks like a short number as it is: %s",
    (text) => {
      const secrets = phone("+298 555012");
      expect(secrets.redact(text)).toBe(text);
      expect(refused(secrets, text)).toBe(false);
    },
  );

  it("drops what a cut left of a short number only with its calling code", () => {
    const secrets = phone("+298 555012");
    expect(secrets.redactCut("Sent to +298 55 5")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to 00298 55")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to + 298 55")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to 00 298 5")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +298 055")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +298 0")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to 555")).toBe("Sent to 555");
    expect(secrets.redactCut("Sent to +555")).toBe("Sent to +555");
    expect(secrets.redactCut("Sent to 298 55")).toBe("Sent to 298 55");
    expect(secrets.redactCut("Sent to 298 0")).toBe("Sent to 298 0");
  });

  // A calling code with so little after it says nothing: its patterns would mask every `+1`.
  it.each([
    ["+1 000 000 0000", "+1"],
    ["001000", "+1"],
    ["+1 000 000 0001", "+1 1"],
    ["+44 020", "+44 20"],
    ["+298 555", "+298 5 55"],
  ])("registers %s only as given, never by its calling code", (number, shown) => {
    const secrets = phone(number);
    expect(secrets.redact(number)).toBe("[private]");
    expect(secrets.redact(`Call ${shown} (800)`)).toBe(`Call ${shown} (800)`);
    expect(refused(secrets, `const i${shown};`)).toBe(false);
  });

  it("masks a number of the fewest digits any country's has, behind its calling code", () => {
    const secrets = phone("+298 5550");
    expect(secrets.redact("Sent to +298 55 50.")).toBe("Sent to [private].");
    expect(refused(secrets, "+298 55 50")).toBe(true);
  });

  it("registers no digits a number has too few of to tell it from any other", () => {
    const secrets = phone("+1234567");
    expect(secrets.redact("+1234567 234567 1234567")).toBe("[private] 234567 1234567");
  });

  // Digits a `national` field typed, or any short login of digits: inside a longer run they say
  // nothing, so they count only as a whole token, as they do in source.
  it("masks short digits only where no digit adjoins them", () => {
    const secrets = phone("1234");
    for (const text of ["order 912345", "91234", "12345"]) {
      expect(secrets.redact(text)).toBe(text);
      expect(refused(secrets, text)).toBe(false);
    }
    expect(secrets.redact("Code 1234.")).toBe("Code [private].");
    expect(secrets.redact("?to=%201234")).toBe("?to=%20[private]");
    expect(refused(secrets, 'const code = "1234";')).toBe(true);
    expect(Effect.runSync(secrets.json({ code: 1234, order: 912345 }))).toEqual({
      code: "[private]",
      order: 912345,
    });
  });

  it("keeps the encoded forms of short digits", () => {
    expect(phone("1234").redact(Buffer.from("1234").toString("base64"))).toBe("[private]");
  });

  it("drops what a cut left of short digits, unless more digits stand before it", () => {
    const secrets = phone("1234");
    expect(secrets.redactCut("Sent to 12")).toBe("Sent to ");
    expect(secrets.redactCut("Order 9912")).toBe("Order 9912");
  });

  it("masks a whole number before the short digits of it that were registered first", () => {
    const secrets = phone("555012");
    secrets.register("+298 555012", "phone");
    expect(secrets.redact("Sent to +298 555012.")).toBe("Sent to [private].");
    expect(secrets.redactCut("Sent to +298 55501")).toBe("Sent to ");
  });

  it.each([
    ["before", ["phone", undefined]],
    ["after", [undefined, "phone"]],
  ] as const)("masks digits anywhere when another secret holds them, %s", (_name, kinds) => {
    const secrets = makeRunSecrets();
    for (const kind of kinds) secrets.register("1234", kind);
    expect(secrets.redact("912345")).toBe("9[private]5");
  });

  it("masks a JSON number that holds it", () => {
    const secrets = phone("+919876543210");
    expect(
      Effect.runSync(secrets.json({ phone: 919876543210, national: 9876543210, count: 3 })),
    ).toEqual({ phone: "[private]", national: "[private]", count: 3 });
  });

  it("drops what a cut left of it, in any form", () => {
    const secrets = phone("+919876543210");
    expect(secrets.redactCut("Sent to +91 98765 43")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to 98765 4")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +91 ")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +91 0987")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +91 0")).toBe("Sent to ");
    expect(secrets.redactCut("Sent to +91 98765 43210 today")).toBe("Sent to [private] today");
    expect(secrets.redactCut("Sent to 12")).toBe("Sent to 12");
    expect(secrets.redactCut("?msg=sent%20to%2098765%2043")).toBe("?msg=sent%20to%20");
  });

  it("drops what a cut left of it before a character the cut broke", () => {
    expect(phone("+919876543210").redactCut("Sent to 98765\uFFFD")).toBe("Sent to ");
  });

  it("forgets its digits with every other value", () => {
    const secrets = phone("+15555550123");
    secrets.clear();
    expect(secrets.redact("+1 (555) 555-0123")).toBe("+1 (555) 555-0123");
    expect(refused(secrets, "+1 (555) 555-0123")).toBe(false);
  });

  it("registers no digits for a value that is not named a phone number", () => {
    const secrets = makeRunSecrets();
    secrets.register("+15555550123");
    expect(secrets.redact("+1 (555) 555-0123")).toBe("+1 (555) 555-0123");
  });
});
