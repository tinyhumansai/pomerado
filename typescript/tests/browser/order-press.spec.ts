import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { amountCode } from "../../src/browser/amounts.js";
import { chooseCode } from "../../src/browser/choose.js";
import { visibleTextCode } from "../../src/browser/visible-text.js";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { fixtureEngine } from "./autofill-host-page.js";

// The page's engine watches its navigations from the start, as a worker's does.
test.beforeEach(({ page }) => {
  fixtureEngine(page);
});

// An order press on a synthetic checkout: the call reads what the commit reports (the order
// button's words and amount, and the way to pay the page shows chosen), presses the button once,
// and waits through the site's pending state, which only polls for a few seconds, until the
// confirmation shows the order ID. The pending state shows no generic loading sign, so only the
// tool naming it keeps the wait alive.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 30,
    code: `${waitCode}\n${visibleTextCode}\n${amountCode}\n${chooseCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://shop.example.test";

const checkout = `<main id="checkout">
<section aria-label="Bill"><span>To pay</span> <span id="total">₹85</span></section>
<div role="radiogroup" aria-label="Pay with">
  <div role="radio" aria-checked="true" tabindex="0">Cash on delivery</div>
  <div role="radio" aria-checked="false" tabindex="0">UPI</div>
</div>
<button id="place" type="button">Pay ₹85 on delivery</button>
</main>
<output id="presses">0</output>
<script>
const checkout = document.getElementById("checkout");
document.getElementById("place").addEventListener("pointerdown", () => {
  const presses = document.getElementById("presses");
  presses.textContent = String(Number(presses.textContent) + 1);
});
document.getElementById("place").addEventListener("click", () => {
  fetch("/api/orders", { method: "POST" });
  checkout.innerHTML = '<p role="status" class="note">Confirming your order</p>';
  let polls = 0;
  const timer = setInterval(() => {
    fetch("/api/orders/status");
    polls += 1;
    if (polls < 12) return;
    clearInterval(timer);
    checkout.innerHTML = '<h2>Order placed</h2><p>Order ID <span id="order-id">OD4F2K91</span></p>';
  }, 300);
});
</script>`;

const serve = async (page: Page) => {
  await page.context().route(`${origin}/**`, (route) =>
    new URL(route.request().url()).pathname.startsWith("/api/")
      ? route.fulfill({ contentType: "application/json", body: '{"status":"pending"}' })
      : route.fulfill({ contentType: "text/html; charset=utf-8", body: checkout }),
  );
  await page.goto(`${origin}/checkout`);
};

/** The press and its wait; `loading` names the pending state, or not. */
const press = (loading: string) => `
const report = {
  button: await visibleText(page.locator("#place")),
  amount: (await readAmount(page.locator("#place"))).amount,
  pay: (await readChoices(page.getByRole("radio"))).filter((way) => way.chosen).map((way) => way.label),
};
try {
  const answer = await waitForOutcomeResult({
    failed: page.getByRole("alert"),
    placed: page.locator("#order-id"),
  }, {
    action: () => page.locator("#place").click({ timeout: 5000 }),
    ${loading}
    noProgressMs: 800,
    timeout: 15000,
  });
  return { report, outcome: answer.outcome, id: answer.evidence.text };
} catch (error) {
  if (error.reason === undefined) throw error;
  return { report, reason: error.reason };
}`;

const report = {
  button: "Pay ₹85 on delivery",
  amount: { minor: 8500, currency: "INR", free: false },
  pay: ["Cash on delivery"],
};

test("presses once and waits through a named pending state for the order ID", async ({ page }) => {
  await serve(page);
  expect(await call(page, press(`loading: page.getByText("Confirming your order"),`))).toEqual({
    result: { report, outcome: "placed", id: "OD4F2K91" },
  });
  expect(await page.locator("#presses").textContent()).toBe("1");
});

test("never takes a pending state nobody named for an answer, and never presses again", async ({ page }) => {
  await serve(page);
  expect(await call(page, press(""))).toEqual({ result: { report, reason: "outcome_unknown" } });
  await expect(page.locator("#order-id")).toHaveText("OD4F2K91");
  expect(await page.locator("#presses").textContent()).toBe("1");
});
