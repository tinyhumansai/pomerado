import { Schema } from "effect";
import { defineOperation, parseAmount, qrCodeCode } from "../../src/browser/index.js";

// An observed order page that shows its payment QR code in a payment frame once the order is
// placed. `readQrCode` never waits, so the call waits for the code to show first. It reads the code
// from a picture of the code's own element, never of the page, which shows the delivery address,
// and returns its text: the upi://pay link. The tool returns the link only when the amount it asks
// for is the amount the order was confirmed at. The frame's title and the image's name are this
// site's evidence, not selectors for other sites.
export default defineOperation(
  {
    name: "read_payment_code",
    input: Schema.Struct({
      amount_minor: Schema.Int.annotations({
        description: "Amount the order was confirmed at, in paise",
        examples: [7400],
      }),
    }),
    output: Schema.Struct({
      payment_link: Schema.NonEmptyTrimmedString.annotations({
        description: "The upi://pay link the payment QR code holds",
      }),
      amount_minor: Schema.Int.annotations({ description: "Amount the link asks for, in minor units" }),
      currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/u)).annotations({
        description: "ISO 4217 code of the amount, as the link names it",
      }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${qrCodeCode}
        const code = page.frameLocator('iframe[title="Payment"]').getByRole("img", { name: "Scan to pay", exact: true });
        await code.waitFor({ state: "visible", timeout: 15000 });
        return await readQrCode(code);
      `,
    });
    if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const link = String(answer.result);
    const url = URL.canParse(link) ? new URL(link) : undefined;
    if (url?.protocol !== "upi:") throw new errors.OperationFailure("the payment code holds no UPI payment link");
    const currency = url.searchParams.get("cu") ?? "INR";
    const amount = parseAmount(url.searchParams.get("am") ?? "", { currency });
    if (amount === null || amount.minor !== input.amount_minor)
      throw new errors.OperationFailure("the payment code asks for another amount than the order's");
    return { payment_link: link, amount_minor: amount.minor, currency };
  },
);
