import { expect } from "@playwright/test";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import type { PlaywrightExecutor } from "../../src/execution/playwright-execute.js";

// A sign-in page whose "email or mobile number" box gives way to a phone box once digits are
// typed, driven through the native executor, whose read-back runs in its worker. `held` is what
// the phone box holds, as a script expression over `national`, the digits after the +91 typed.

const site = "https://login.example.test";
const body = (held: string) => `<form action="/session" method="post">
<div id="box"><label>Email or mobile number <input id="identifier" name="identifier"></label></div>
<button id="continue">Continue</button>
</form>
<script>
const box = document.getElementById("box");
document.getElementById("identifier").addEventListener("input", (event) => {
  const national = event.target.value.replace(/[^0-9]/g, "").replace(/^91/, "");
  box.innerHTML = '<label>Mobile number <input id="phone" name="phone" type="tel"></label>';
  document.getElementById("phone").value = ${held};
});
</script>`;

const step: AutofillStep = {
  fields: [{ selector: "#identifier", slot: "phone", accepts: ["email", "phone"] }],
  submit: "#continue",
};

/** The fill of that page on the executor's own keyboard, with what the site received. */
const fill = async (executor: PlaywrightExecutor, held: string) => {
  await Effect.runPromise(
    executor.execute(`
      context.posted = [];
      await context.unroute('${site}/**');
      await context.route('${site}/**', (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: ${JSON.stringify(body(held))} });
        context.posted.push(request.postData());
        return route.fulfill({ contentType: 'text/html', body: '<p>Code sent</p>' });
      });
      await page.goto('${site}/login');
    `),
  );
  const host = { targetId: executor.targetId, execute: executor.execute };
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["+91 98765 43210"],
      inspection,
      page: host,
      keyboard: executor.keyboard,
      settleMs: 500,
    }),
  );
  const posted: unknown = await Effect.runPromise(executor.execute("return context.posted;"));
  return { report, posted };
};

/**
 * Follows a phone box that holds the number, and refuses one that holds another, or its national
 * digits alone with no picker beside it to say the country.
 */
export const expectPhoneSwapThroughWorker = async (executor: PlaywrightExecutor) => {
  const same = await fill(executor, '"+91" + national');
  expect(same.report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(same.posted).toEqual(["phone=%2B919876543210"]);
  const national = await fill(executor, "national");
  expect(national.report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    failureDetail: { phase: "not_found", context: { phoneSwap: "calling_code" } },
  });
  expect(national.posted).toEqual([]);
  const other = await fill(executor, '"9999988888"');
  expect(other.report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    failureDetail: { phase: "not_found", context: { phoneSwap: "value_changed" } },
  });
  expect(other.posted).toEqual([]);
};
