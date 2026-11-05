import { Schema } from "effect";
import { AmountLines, AmountRead, amountCode, defineOperation, visibleTextCode } from "../../src/browser/index.js";

// An observed checkout whose bill lists the item total beside its old price struck out, a fee
// waived as FREE, a donation, a wallet deduction and a free gift, then the amount to pay.
// `readAmounts` reads every line the bill shows as data in paise, with a struck-out old amount
// apart from the live one, and `readAmount` the total. No line is left out or folded into
// another: the caller decides what each one means. The page prices in rupees, so FREE takes INR.
// This bill shows its wallet line with a minus sign, which `readAmounts` reads as negative; a bill
// that shows a deduction unsigned needs the line's own label to tell it. The selectors are this
// site's evidence, not selectors for other sites.
const Line = Schema.Struct({
  label: Schema.NonEmptyTrimmedString.annotations({ description: "The line as the bill names it" }),
  amount_minor: Schema.Int.annotations({
    description: "The line's amount in paise, negative where the bill shows it with a minus, such as the wallet",
  }),
  was_minor: Schema.NullOr(Schema.Int).annotations({
    description: "The struck-out amount the bill shows beside it, in paise; null when none shows",
  }),
  free: Schema.Boolean.annotations({ description: "The bill shows the line as free" }),
});

export default defineOperation(
  {
    name: "read_bill",
    input: Schema.Struct({}),
    output: Schema.Struct({
      lines: Schema.Array(Line),
      total_minor: Schema.Int.annotations({ description: "Amount to pay, in paise" }),
      currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/u)).annotations({
        description: "ISO 4217 code of every amount",
      }),
    }),
  },
  async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${visibleTextCode}
        ${amountCode}
        return {
          lines: await readAmounts(page.locator("#bill .line"), { label: ".name", amount: ".value" }, { currency: "INR" }),
          total: await readAmount(page.locator("#to-pay"), { currency: "INR" }),
        };
      `,
    });
    if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const read = Schema.decodeUnknownSync(Schema.Struct({ lines: AmountLines, total: AmountRead }))(answer.result);
    const lines = read.lines.map((line) => {
      if (line.label === null || line.amount === null)
        throw new errors.OperationFailure("a bill line shows no label or no single amount");
      return {
        label: line.label,
        amount_minor: line.amount.minor,
        was_minor: line.struck[0]?.minor ?? null,
        free: line.amount.free,
      };
    });
    if (read.total.amount === null) throw new errors.OperationFailure("the bill shows no single total");
    return { lines, total_minor: read.total.amount.minor, currency: read.total.amount.currency ?? "INR" };
  },
);
