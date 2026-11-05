import { Schema } from "effect";
import {
  ChoiceStates,
  ChooseOutcome,
  chooseCode,
  defineOperation,
  normalizeText,
  waitCode,
} from "../../src/browser/index.js";

// An observed checkout whose ways to pay sit in a payment frame as an accordion: the open row is
// the way chosen, and pressing an open row again closes it. The frame saves the way chosen to the
// order as it opens, so choosing one is a commit. A first call waits for the frame's rows and reads
// every way with `readChoices`, which reads the page as it is at that moment, so a way it shows
// greyed out is read again once the frame has gone quiet. A way the frame does not name, names
// twice or keeps greyed out is refused with the site's words before the commit mark. Only a way
// named exactly, in any case, is chosen, never one whose name merely starts with the caller's
// words, as "Cash on delivery" starts with "Cash". The marked call chooses that one row, found by
// the text the read matched rather than by its accessible name, with `chooseOne`, which never
// presses a row already open, presses once and confirms the frame keeps it chosen. The frame's
// title and the rows' role are this site's evidence, not selectors for other sites.
const frame = `page.frameLocator('iframe[title="Payment options"]')`;
const rows = `${frame}.getByRole("button")`;

/** A way's name as the tool compares it: its words in lower case. */
const named = (text: string) => normalizeText(text).toLowerCase();

/** Whether a row's text starts with the way's words, as "Pay later Not available" starts with "Pay later". */
const startsWith = (label: string, way: string) => {
  const wanted = named(way).split(" ");
  return named(label).split(" ").slice(0, wanted.length).join(" ") === wanted.join(" ");
};

/**
 * The row whose whole text is `label`, as `readChoices` read it: an `aria-label`, or an icon's
 * hidden text, can give the row another accessible name. Words may run together where the page
 * breaks the line between two elements.
 */
const rowWithText = (label: string) => {
  const words = label.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return `${rows}.filter({ hasText: new RegExp(${JSON.stringify(`^\\s*${words.join("\\s*")}\\s*$`)}) })`;
};

export default defineOperation(
  {
    name: "choose_way_to_pay",
    input: Schema.Struct({
      way: Schema.NonEmptyTrimmedString.annotations({
        description: "Way to pay, as the checkout names it",
        examples: ["Cash on delivery"],
      }),
    }),
    output: Schema.Struct({
      way: Schema.NonEmptyTrimmedString.annotations({ description: "Way the checkout shows chosen, as it names it" }),
    }),
    write: { confirmation: "readback", commits: ["choose-way-to-pay"] },
  },
  async ({ kernel, sessionId, input, errors, enteringCommit, verified }) => {
    const read = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${waitCode}
        ${chooseCode}
        // The frame draws its rows after the page does.
        await ${rows}.first().waitFor({ state: "visible", timeout: waitLimits.answer });
        return await readChoices(${rows});
      `,
    });
    if (!read.success)
      throw new errors.OperationFailure(String(read.error), { stderr: read.stderr, dispatch: "not_sent" });
    const offered = Schema.decodeUnknownSync(ChoiceStates)(read.result);
    if (offered.length === 0)
      throw new errors.OperationFailure("the payment frame shows no way to pay", { dispatch: "not_sent" });
    const available = offered.filter((choice) => !choice.unavailable).map((choice) => choice.label);
    const exact = offered.filter((choice) => named(choice.label) === named(input.way));
    if (exact.length > 1)
      throw new errors.OperationFailure(`the payment frame lists ${exact.length} ways to pay named ${input.way}`, {
        dispatch: "not_sent",
      });
    let [way] = exact;
    if (way === undefined) {
      // A way greyed out can carry the site's note after its name, as "Pay later Not available".
      const noted = offered.filter((choice) => choice.unavailable && startsWith(choice.label, input.way));
      if (noted.length > 0)
        throw new errors.InvalidInput(
          `Caller input error: the checkout says ${noted.map((choice) => choice.label).join("; ")}`,
          { field: "way", kind: "unavailable", available },
        );
      throw new errors.InvalidInput(`Caller input error: the checkout offers no way to pay named ${input.way}`, {
        field: "way",
        kind: "option_missing",
        available,
      });
    }
    if (way.unavailable) {
      // A frame greys a way out for a moment while it recalculates: wait until the row is ready or
      // the frame has shown no progress for `waitLimits.unchanged`, then read the row again.
      const again = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 30,
        code: `
          ${waitCode}
          ${chooseCode}
          const ready = await waitForReady(${rowWithText(way.label)}, { noProgressMs: waitLimits.unchanged }).catch((error) => {
            if (error.name !== "ReadyWaitFailure") throw error;
          });
          await ready?.release();
          return await readChoices(${rowWithText(way.label)});
        `,
      });
      if (!again.success)
        throw new errors.OperationFailure(String(again.error), { stderr: again.stderr, dispatch: "not_sent" });
      const [now] = Schema.decodeUnknownSync(ChoiceStates)(again.result);
      if (now === undefined)
        throw new errors.OperationFailure("the way to pay left the payment frame", { dispatch: "not_sent" });
      if (now.unavailable)
        throw new errors.InvalidInput(`Caller input error: the checkout shows ${now.label} greyed out`, {
          field: "way",
          kind: "unavailable",
          available,
        });
      way = now;
    }
    // The way is offered: the marked call finds the row again and presses it at most once.
    enteringCommit("choose-way-to-pay");
    const chose = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${waitCode}
        ${chooseCode}
        return await chooseOne(${rowWithText(way.label)});
      `,
    });
    // A failure may follow the press: never press again here.
    if (!chose.success)
      throw new errors.OperationFailure(String(chose.error), { stderr: chose.stderr, dispatch: "sent" });
    const outcome = Schema.decodeUnknownSync(ChooseOutcome)(chose.result);
    // Offered a moment ago and greyed out now: `chooseOne` pressed nothing.
    if (!outcome.chosen)
      throw new errors.OperationFailure("the checkout greyed out the way to pay before it was chosen", {
        dispatch: "not_sent",
      });
    verified();
    return { way: outcome.label };
  },
);
