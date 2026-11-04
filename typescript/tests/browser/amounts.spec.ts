import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { amountCode } from "../../src/browser/amounts.js";
import { visibleTextCode } from "../../src/browser/visible-text.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `readAmount` and `readAmounts`, run as a Kernel call body runs them (`page` in scope) on a
// synthetic checkout: a bill whose lines show a struck-out old price beside the new one, a fee
// waived as FREE, a donation, a tip and a gift line at zero, a wallet deduction, a hidden coupon
// row, and a screen-reader copy of an old price, and an order button that names the amount.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${visibleTextCode}\n${amountCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const srOnly = "position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap";

const checkout = `<section id="bill" aria-label="Bill details">
<div class="line"><span class="name">Item total</span>
  <span class="value"><del>₹120</del><span style="${srOnly}">Was ₹120, now</span> ₹100</span></div>
<div class="line"><span class="name">Delivery charge</span>
  <span class="value"><span style="text-decoration: line-through">₹25</span> FREE</span></div>
<div class="line"><span class="name">Handling charge</span><span class="value">₹4</span></div>
<div class="line"><span class="name">Donation</span><span class="value">₹1</span></div>
<div class="line"><span class="name">Tip for your delivery partner</span><span class="value">₹0</span></div>
<div class="line"><span class="name">Wallet balance used</span><span class="value">− ₹20</span></div>
<div class="line"><span class="name">Free gift: sample sachet</span><span class="value">₹0</span></div>
<div class="line" hidden><span class="name">Coupon</span><span class="value">-₹50</span></div>
<div class="line total"><span class="name">To pay</span><span class="value">₹85</span></div>
</section>
<button type="button" id="place">Pay ₹85 on delivery</button>
<p id="note">Prices include taxes</p>`;

const inr = (minor: number, free = false) => ({ minor, currency: "INR", free });

test("reads every visible bill line as data: its label, its amount and any struck-out old one", async ({ page }) => {
  await page.setContent(checkout);
  const { result } = await call(
    page,
    `return await readAmounts(page.locator("#bill .line"), { label: ".name", amount: ".value" }, { currency: "INR" });`,
  );
  expect(result).toEqual([
    { label: "Item total", amount: inr(10000), struck: [inr(12000)], text: "₹100" },
    { label: "Delivery charge", amount: inr(0, true), struck: [inr(2500)], text: "FREE" },
    { label: "Handling charge", amount: inr(400), struck: [], text: "₹4" },
    { label: "Donation", amount: inr(100), struck: [], text: "₹1" },
    { label: "Tip for your delivery partner", amount: inr(0), struck: [], text: "₹0" },
    { label: "Wallet balance used", amount: inr(-2000), struck: [], text: "− ₹20" },
    { label: "Free gift: sample sachet", amount: inr(0), struck: [], text: "₹0" },
    { label: "To pay", amount: inr(8500), struck: [], text: "₹85" },
  ]);
});

test("reads one element's amount, such as the amount the order button names", async ({ page }) => {
  await page.setContent(checkout);
  const { result } = await call(
    page,
    `return {
      button: await readAmount(page.locator("#place")),
      line: await readAmount(page.locator("#bill .line").first().locator(".value")),
      none: await readAmount(page.locator("#note")),
    };`,
  );
  expect(result).toEqual({
    button: { amount: inr(8500), struck: [], text: "Pay ₹85 on delivery" },
    line: { amount: inr(10000), struck: [inr(12000)], text: "₹100" },
    none: { amount: null, struck: [], text: "Prices include taxes" },
  });
});

test("fails as visibleText does for a missing, hidden or ambiguous element, naming no page text", async ({
  page,
}) => {
  await page.setContent(checkout);
  const { result } = await call(
    page,
    `const failure = async (read) => {
      try {
        await read;
        return null;
      } catch (error) {
        return { name: error.name, reason: error.reason };
      }
    };
    return {
      missing: await failure(readAmount(page.locator("#absent"))),
      hidden: await failure(readAmount(page.locator(".line[hidden] .value"))),
      ambiguous: await failure(readAmount(page.locator("#bill .value"))),
    };`,
  );
  expect(result).toEqual({
    missing: { name: "VisibleTextFailure", reason: "not_found" },
    hidden: { name: "VisibleTextFailure", reason: "hidden_only" },
    ambiguous: { name: "VisibleTextFailure", reason: "ambiguous" },
  });
});

test("leaves visibleText and readRows reading struck-out text as before", async ({ page }) => {
  await page.setContent(checkout);
  const { result } = await call(
    page,
    `return {
      text: await visibleText(page.locator("#bill .line").first().locator(".value")),
      rows: await readRows(page.locator("#bill .line"), { value: ".value" }, { limit: 2 }),
    };`,
  );
  expect(result).toEqual({
    text: "₹120 ₹100",
    rows: [{ value: "₹120 ₹100" }, { value: "₹25 FREE" }],
  });
});
