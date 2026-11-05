import { Schema } from "effect";
import { QuantityOutcome, defineOperation, quantityCode, waitCode } from "../../src/browser/index.js";

// An observed product page whose cart control is ADD, then a "− n +" stepper that a loader covers
// while the site saves each press, dropping any press made under it. `setQuantity` presses one
// step at a time, waits out the loader, reads the count back after each press and stops at the
// site's limit, which this tool returns as its answer: `saved_differences` holds the quantity asked
// and the one the site kept. Each press is a cart write, so the call is marked first, and the count
// it read back confirms the write. This reference shows the stepper alone: a cart tool also reads
// the cart's lines before and after its write and checks that only this line changed, as the cart
// skill says. The labels are this site's evidence, not selectors for other sites.
export default defineOperation(
  {
    name: "set_cart_quantity",
    input: Schema.Struct({
      quantity: Schema.Int.pipe(Schema.between(0, 20)).annotations({
        description: "Units the cart line should hold; 0 removes it",
        examples: [3],
      }),
    }),
    output: Schema.Struct({
      quantity: Schema.Int.annotations({ description: "Units the cart line holds now" }),
      saved_differences: Schema.optional(
        Schema.Array(
          Schema.Struct({ field: Schema.Literal("quantity"), wanted: Schema.String, shown: Schema.String }),
        ).annotations({
          description: "The quantity asked and the one the site kept, at the most or the fewest units it takes",
        }),
      ),
    }),
    write: { confirmation: "readback", commits: ["set-quantity"] },
  },
  async ({ kernel, sessionId, input, errors, enteringCommit, verified }) => {
    enteringCommit("set-quantity");
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        ${quantityCode}
        return await setQuantity({
          count: page.locator(".product .count"),
          increase: page.getByRole("button", { name: "Add one", exact: true }),
          decrease: page.getByRole("button", { name: "Remove one", exact: true }),
          add: page.getByRole("button", { name: "ADD", exact: true }),
        }, ${input.quantity}, { overlays: page.locator("#cart-updating") });
      `,
    });
    // A failure may follow a press that landed: never press again here.
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr, dispatch: "sent" });
    const outcome = Schema.decodeUnknownSync(QuantityOutcome)(answer.result);
    verified();
    if (outcome.set) return { quantity: outcome.quantity };
    // The site's limit is its answer: the write applied as far as the site takes it.
    return {
      quantity: outcome.quantity,
      saved_differences: [{ field: "quantity" as const, wanted: String(input.quantity), shown: String(outcome.quantity) }],
    };
  },
);
