import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { amountCode } from "../../src/browser/amounts.js";
import { visibleTextCode } from "../../src/browser/visible-text.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `readAmount` and `readAmounts`, run as a Kernel call body runs them (`page` in scope) on a
// synthetic checkout: a bill whose lines show a struck-out old price beside the new one, a fee
// waived as FREE, a donation, a tip and a gift line at zero, a wallet deduction, a hidden coupon
// row, and a screen-reader copy of an old price, and an order button that names the amount; and
// on synthetic price tags: digits grouped by no-break or thin spaces, cents set in superscript
// right after the units or after a decimal mark, a raised currency symbol, and old prices struck
// out by s and strike elements or by a struck element around the price.
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

const eur = (minor: number) => ({ minor, currency: "EUR", free: false });

test("reads digits a no-break, narrow no-break or thin space groups, and returns the text as visibleText reads it", async ({
  page,
}) => {
  await page.setContent(`<p id="no-break">1&nbsp;234,50&nbsp;€</p>
<p id="narrow">1&#x202F;234,50&nbsp;€</p>
<p id="thin">€&nbsp;12&thinsp;345</p>
<p id="was"><del>1&nbsp;299,00&nbsp;€</del> 1&nbsp;199,00&nbsp;€</p>
<ul id="lines"><li><span class="name">Sofa</span><span class="value">2&nbsp;499,00&nbsp;€</span></li></ul>`);
  const { result } = await call(
    page,
    `return {
      noBreak: await readAmount(page.locator("#no-break")),
      narrow: await readAmount(page.locator("#narrow")),
      thin: await readAmount(page.locator("#thin")),
      was: await readAmount(page.locator("#was")),
      lines: await readAmounts(page.locator("#lines li"), { label: ".name", amount: ".value" }),
      text: await visibleText(page.locator("#no-break")),
    };`,
  );
  expect(result).toEqual({
    noBreak: { amount: eur(123450), struck: [], text: "1 234,50 €" },
    narrow: { amount: eur(123450), struck: [], text: "1 234,50 €" },
    thin: { amount: eur(1234500), struck: [], text: "€ 12 345" },
    was: { amount: eur(119900), struck: [eur(129900)], text: "1 199,00 €" },
    lines: [{ label: "Sofa", amount: eur(249900), struck: [], text: "2 499,00 €" }],
    text: "1 234,50 €",
  });
});

test("reads cents set in superscript apart from the units, never as more whole units", async ({ page }) => {
  await page.setContent(`<p id="sup">$12<sup>97</sup></p>
<p id="raised">$12<span style="vertical-align: super; font-size: 60%">97</span></p>
<p id="symbol"><sup>$</sup>12<sup>97</sup></p>`);
  const { result } = await call(
    page,
    `return {
      sup: await readAmount(page.locator("#sup"), { currency: "USD" }),
      raised: await readAmount(page.locator("#raised"), { currency: "USD" }),
      symbol: await readAmount(page.locator("#symbol"), { currency: "USD" }),
      text: await visibleText(page.locator("#sup")),
    };`,
  );
  expect(result).toEqual({
    sup: { amount: null, struck: [], text: "$12 97" },
    raised: { amount: null, struck: [], text: "$12 97" },
    symbol: { amount: null, struck: [], text: "$12 97" },
    text: "$1297",
  });
});

test("reads a currency code with words in capitals after it, and one that is also a word as a word", async ({
  page,
}) => {
  await page.setContent(`<p id="code">29,99 EUR TTC</p><p id="word">TOP 10</p><p id="dash">- 20,00 €</p><p id="joined">USD$20</p>`);
  const { result } = await call(
    page,
    `return {
      code: await readAmount(page.locator("#code")),
      word: await readAmount(page.locator("#word"), { currency: "INR" }),
      dash: await readAmount(page.locator("#dash")),
      joined: await readAmount(page.locator("#joined")),
    };`,
  );
  expect(result).toEqual({
    code: { amount: eur(2999), struck: [], text: "29,99 EUR TTC" },
    word: { amount: inr(1000), struck: [], text: "TOP 10" },
    dash: { amount: eur(-2000), struck: [], text: "- 20,00 €" },
    joined: { amount: { minor: 2000, currency: "USD", free: false }, struck: [], text: "USD$20" },
  });
});

const usd = (minor: number) => ({ minor, currency: "USD", free: false });

test("reads a raised part beside a decimal mark, or a raised symbol, as part of the amount", async ({ page }) => {
  await page.setContent(`<p id="point">$12.<sup>97</sup></p>
<p id="comma">12,<sup>99</sup> €</p>
<p id="mark">₹1,299<span style="vertical-align: super; font-size: 60%">.00</span></p>
<p id="symbol"><sup>₹</sup>1,299</p>
<p id="was"><del>$12.<sup>97</sup></del> $10.<sup>99</sup></p>`);
  const { result } = await call(
    page,
    `return {
      point: await readAmount(page.locator("#point"), { currency: "USD" }),
      comma: await readAmount(page.locator("#comma")),
      mark: await readAmount(page.locator("#mark")),
      symbol: await readAmount(page.locator("#symbol")),
      was: await readAmount(page.locator("#was"), { currency: "USD" }),
    };`,
  );
  expect(result).toEqual({
    point: { amount: usd(1297), struck: [], text: "$12.97" },
    comma: { amount: eur(1299), struck: [], text: "12,99 €" },
    mark: { amount: inr(129900), struck: [], text: "₹1,299.00" },
    symbol: { amount: inr(129900), struck: [], text: "₹1,299" },
    was: { amount: usd(1099), struck: [usd(1297)], text: "$10.99" },
  });
});

test("sets apart text an s or strike element strikes out, and an amount inside a struck-out element", async ({
  page,
}) => {
  await page.setContent(`<ul id="offers">
<li class="offer"><span class="name">Rice, 1 kg</span><span class="price"><s>₹99</s> ₹79</span></li>
<li class="offer"><span class="name">Delivery</span><span class="price"><strike>₹50</strike> FREE</span></li>
</ul>
<del id="old-total"><span class="price">₹120</span></del>
<div id="old-fee" style="text-decoration: line-through"><span class="price">₹30</span></div>`);
  const { result } = await call(
    page,
    `return {
      rows: await readAmounts(page.locator("#offers .offer"), { label: ".name", amount: ".price" }, { currency: "INR" }),
      insideDel: await readAmount(page.locator("#old-total .price")),
      insideLineThrough: await readAmount(page.locator("#old-fee .price")),
      text: await visibleText(page.locator("#old-total .price")),
      plain: await readRows(page.locator("#offers .offer"), { price: ".price" }),
    };`,
  );
  expect(result).toEqual({
    rows: [
      { label: "Rice, 1 kg", amount: inr(7900), struck: [inr(9900)], text: "₹79" },
      { label: "Delivery", amount: inr(0, true), struck: [inr(5000)], text: "FREE" },
    ],
    insideDel: { amount: null, struck: [inr(12000)], text: "" },
    insideLineThrough: { amount: null, struck: [inr(3000)], text: "" },
    text: "₹120",
    plain: [{ price: "₹99 ₹79" }, { price: "₹50 FREE" }],
  });
});
