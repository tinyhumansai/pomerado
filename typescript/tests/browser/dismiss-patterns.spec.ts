import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { fixtureEngine } from "./autofill-host-page.js";

// The page's engine watches its navigations from the start, as a worker's does.
test.beforeEach(({ page }) => {
  fixtureEngine(page);
});

// `waitForReady`'s `dismiss`, run as a Kernel call body runs it (`page` in scope), on synthetic
// pages that copy the layers shops put between a person and a button: a cookie banner, a consent
// banner served from another origin in a frame of its own, an app-install sheet that opens a
// moment after the page is ready, and an offer pop-up over the button. Each named close control is
// clicked once, before the press, and the press lands on the button.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 20,
    code: `${waitCode}\n${body}`,
  });
  if (!answer.success) throw new Error(String(answer.error));
  return answer.result as Record<string, unknown>;
};

const shop = "https://shop.example.test";

/** Serves `body` at the shop, with a Save button that counts its presses in `#saved`. */
const serve = async (page: Page, body: string, extra: Record<string, string> = {}) => {
  await page.context().route("https://*.example.test/**", (route) => {
    const url = new URL(route.request().url());
    const page = url.origin === shop ? body : extra[url.origin + url.pathname];
    return page === undefined
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ contentType: "text/html; charset=utf-8", body: page });
  });
  await page.goto(`${shop}/cart`);
};

const save = `<button id="save" type="button">Save</button><output id="saved">0</output>
<script>
document.getElementById("save").addEventListener("click", () => {
  const saved = document.getElementById("saved");
  saved.textContent = String(Number(saved.textContent) + 1);
});
</script>`;

/** Waits for Save with `dismiss`, presses it, and returns what the wait did. */
const press = (dismiss: string, before = "") => `
const ready = await waitForReady(page.getByRole("button", { name: "Save" }), { dismiss: ${dismiss} });
${before}
await page.getByRole("button", { name: "Save" }).click({ timeout: 5000 });
await ready.release();
return { dismissed: ready.dismissed, waitedFor: ready.waitedFor };`;

test("closes a cookie banner over the button with its decline control, never accepting", async ({ page }) => {
  await serve(
    page,
    `${save}
<div id="cookies" role="dialog" aria-label="Cookies" style="position: fixed; inset: 0; background: #fff">
  We use cookies. <button type="button" id="accept">Accept all</button> <button type="button" id="decline">Reject non-essential</button>
</div>
<output id="consent">none</output>
<script>
for (const id of ["accept", "decline"])
  document.getElementById(id).addEventListener("click", () => {
    document.getElementById("consent").textContent = id;
    document.getElementById("cookies").remove();
  });
</script>`,
  );
  const answer = await call(page, press(`page.getByRole("button", { name: "Reject non-essential" })`));
  expect(answer).toMatchObject({ dismissed: 1 });
  await expect(page.locator("#consent")).toHaveText("decline");
  await expect(page.locator("#saved")).toHaveText("1");
});

test("closes a consent banner the page shows in a frame from another origin", async ({ page }) => {
  await serve(
    page,
    `${save}
<iframe id="consent" title="Consent" src="https://consent.example.test/banner" style="position: fixed; inset: 0; width: 100%; height: 100%; border: 0"></iframe>
<script>
addEventListener("message", (event) => {
  if (event.origin === "https://consent.example.test" && event.data === "closed") document.getElementById("consent").remove();
});
</script>`,
    {
      "https://consent.example.test/banner": `<div style="background: #fff; height: 100vh">Your privacy choices
<button type="button" id="close" aria-label="Close">×</button></div>
<script>document.getElementById("close").addEventListener("click", () => parent.postMessage("closed", "*"));</script>`,
    },
  );
  const answer = await call(page, press(`page.frameLocator("#consent").getByRole("button", { name: "Close" })`));
  expect(answer).toMatchObject({ dismissed: 1 });
  await expect(page.locator("#consent")).toHaveCount(0);
  await expect(page.locator("#saved")).toHaveText("1");
});

test("closes an app-install sheet that opens after the button was ready, before the press", async ({ page }) => {
  await serve(
    page,
    `${save}
<div id="sheet" hidden style="position: fixed; inset: 0; background: #fff">Get the app for faster checkout
<button type="button" id="later">Not now</button></div>
<script>
document.getElementById("later").addEventListener("click", () => document.getElementById("sheet").remove());
</script>`,
  );
  // The sheet opens between the wait and the press. Nothing waits for it to show: the handler the
  // wait left closes it before any action, a wait for it included.
  const answer = await call(
    page,
    press(
      `page.getByRole("button", { name: "Not now" })`,
      `await page.evaluate(() => { document.getElementById("sheet").hidden = false; });`,
    ),
  );
  expect(answer).toMatchObject({ dismissed: 0 });
  await expect(page.locator("#sheet")).toHaveCount(0);
  await expect(page.locator("#saved")).toHaveText("1");
});

test("closes an offer pop-up that opens over the button while the wait runs", async ({ page }) => {
  await serve(
    page,
    `${save}
<div id="offer" hidden role="dialog" aria-label="Offer" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5)">
  <div style="background: #fff; margin: 40px; padding: 20px">Flat 10% off on your first order <button type="button" aria-label="Close offer">×</button></div>
</div>
<script>
document.querySelector("[aria-label='Close offer']").addEventListener("click", () => document.getElementById("offer").remove());
</script>`,
  );
  await expect(page.locator("#offer")).toBeHidden();
  // As the wait starts, the cart is still loading: Save stays disabled for 700 ms, and the offer
  // opens over it 300 ms in. The wait closes it itself, so it counts as dismissed.
  const answer = await call(
    page,
    `await page.evaluate(() => {
  document.getElementById("save").disabled = true;
  setTimeout(() => { document.getElementById("offer").hidden = false; }, 300);
  setTimeout(() => { document.getElementById("save").disabled = false; }, 700);
});
${press(`page.getByRole("button", { name: "Close offer" })`)}`,
  );
  expect(answer).toMatchObject({ dismissed: 1 });
  await expect(page.locator("#offer")).toHaveCount(0);
  await expect(page.locator("#saved")).toHaveText("1");
});
