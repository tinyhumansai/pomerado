import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A notice's close button slotted into a shadow root. A click goes along the slot, so a link there
// is reached, but a browser ties the button to no form it is only slotted into: only a form of the
// page's own parents, or the one the button names, is its form.

const site = "https://portal.example.test";
const username = "synthetic-agent";
const password = "synthetic-slot-password";
const step: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#login",
  dismiss: "#close",
};

const signInFields = `<label>Username <input id="username" name="username"></label>
<label>Password <input id="password" name="password" type="password"></label>
<button id="login">Sign in</button>`;
const signInForm = `<form method="post" action="/login">${signInFields}</form>`;
/** The notice, whose shadow root is `root`; a click of its close button takes it away. */
const notice = (root: string) => `<div id="notice"><button id="close">Close</button></div>
<script>
const notice = document.getElementById("notice");
notice.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(root)};
document.getElementById("close").addEventListener("click", () => notice.remove());
</script>`;

const serve = async (page: Page, body: string) => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST")
      received.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
    await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${site}/login`);
  return received;
};

const fill = async (page: Page) => {
  const hosted = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: hosted, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: [username, password],
      inspection,
      page: hosted,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 1_000,
    }),
  );
  // Why the dismiss call refused, which the report leaves out.
  const refusedAs = hosted.calls.flatMap(({ answer }) =>
    typeof answer === "object" && answer !== null && "part" in answer ? [answer.part] : [],
  );
  return { report, refusedAs };
};

for (const [name, body] of [
  [
    "slotted into a form of a shadow root, with no type of its own",
    `${signInForm}${notice("<form><slot></slot></form>")}`,
  ],
  [
    "slotted into the shadow form that holds the sign-in",
    `<div id="notice"><button id="close" type="button">Close</button></div>
<script>
const notice = document.getElementById("notice");
notice.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(
      `<form method="post" action="/login">${signInFields}<slot></slot></form>`,
    )};
document.getElementById("close").addEventListener("click", (event) => event.currentTarget.remove());
</script>`,
  ],
] as const)
  test(`a close button ${name} is clicked, and the sign-in goes out`, async ({ page }) => {
    const received = await serve(page, body);
    const { report } = await fill(page);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received).toEqual([{ username, password }]);
  });

for (const [name, body, part] of [
  [
    "slotted into a link to another page",
    `${signInForm}${notice('<a href="/privacy"><slot></slot></a>')}`,
    "opens_page",
  ],
  [
    "in the sign-in's own form",
    `<form method="post" action="/login">${signInFields}${notice("<slot></slot>")}</form>`,
    "sign_in_form",
  ],
  [
    "in another form of the page",
    `${signInForm}<form method="post" action="/other">${notice("<slot></slot>")}</form>`,
    "submits_form",
  ],
] as const)
  test(`a close button ${name} is still refused, with nothing typed or sent`, async ({ page }) => {
    const received = await serve(page, body);
    const { report, refusedAs } = await fill(page);
    expect(report).toMatchObject({ outcome: "refused", reason: "dismiss_refused" });
    expect(refusedAs).toEqual([part]);
    expect(received).toEqual([]);
    expect(page.url()).toBe(`${site}/login`);
    await expect(page.locator("#username")).toHaveValue("");
  });
