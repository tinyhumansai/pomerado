import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { quantityCode } from "../../src/browser/quantity.js";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { fixtureEngine } from "./autofill-host-page.js";

// The page's engine watches its navigations from the start, as a worker's does.
test.beforeEach(({ page }) => {
  fixtureEngine(page);
});

// `setQuantity`, run as a Kernel call body runs it (`page` in scope) on a synthetic product card
// whose cart control is an ADD button that becomes a "− n +" stepper. Each press posts the new
// quantity to the site, and a loader covers the stepper until the answer is drawn. A press made
// while the loader shows is lost, as on many shops, so only one press at a time, each read back,
// reaches the count asked for.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 60,
    code: `${waitCode}\n${quantityCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://grocer.example.test";

interface Shop {
  /** Quantity the card starts at. */
  readonly start?: number;
  /** The most the site takes; past it, `+` is disabled, or it says so when `says` is set. */
  readonly max?: number;
  readonly says?: boolean;
  /** How much one press adds; 2 copies a site that steps twice. */
  readonly step?: number;
  /** Shows the count in a read-only input instead of text. */
  readonly input?: boolean;
  /** Greys out − and + for this long after each answer, as sites that hold them while they save. */
  readonly holdMs?: number;
  /** Shows the limit note from the start, as a standing "at most n" note. */
  readonly noteShown?: boolean;
}

/** Serves the product card, records each quantity the site receives, and opens it. */
const shop = async (page: Page, options: Shop = {}) => {
  const received: number[] = [];
  const body = `<main>
<div class="product"><h2>Instant noodles</h2><p>₹14</p><div class="cart-control"></div></div>
<p id="limit-note" ${options.noteShown === true ? "" : "hidden"}>You can't add more of this item</p>
<div id="loader" hidden style="position: fixed; inset: 0; background: rgba(255, 255, 255, 0.7)">Updating cart</div>
<output id="presses">0</output>
</main>
<script>
let quantity = ${options.start ?? 0};
let busy = false;
const max = ${options.max ?? 99};
const control = document.querySelector(".cart-control");
const loader = document.getElementById("loader");
const render = () => {
  if (quantity === 0) {
    control.innerHTML = '<button type="button" class="add">ADD</button>';
    return;
  }
  const count = ${options.input === true}
    ? '<input class="count" aria-label="Quantity" readonly size="2">'
    : '<span class="count">' + quantity + '</span>';
  control.innerHTML = '<button type="button" class="minus" aria-label="Remove one">−</button>' + count +
    '<button type="button" class="plus" aria-label="Add one"' + (quantity >= max && ${options.says !== true} ? " disabled" : "") + '>+</button>';
  const input = control.querySelector("input.count");
  if (input) input.value = String(quantity);
  const hold = ${options.holdMs ?? 0};
  if (hold > 0) {
    const steps = [...control.querySelectorAll(".minus, .plus")].filter((step) => !step.disabled);
    for (const step of steps) step.disabled = true;
    setTimeout(() => { for (const step of steps) step.disabled = false; }, hold);
  }
};
control.addEventListener("pointerdown", () => {
  const presses = document.getElementById("presses");
  presses.textContent = String(Number(presses.textContent) + 1);
});
control.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || busy) return;
  const next = button.matches(".minus") ? quantity - ${options.step ?? 1} : quantity + ${options.step ?? 1};
  if (next > max) {
    document.getElementById("limit-note").hidden = false;
    return;
  }
  busy = true;
  loader.hidden = false;
  fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: next }) })
    .then(() => setTimeout(() => {
      quantity = next;
      render();
      loader.hidden = true;
      busy = false;
    }, 350));
});
render();
</script>`;
  await page.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(Number(JSON.parse(request.postData() ?? "{}").quantity));
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${origin}/product`);
  return received;
};

const stepper = `{
  count: page.locator(".product .count"),
  increase: page.getByRole("button", { name: "Add one" }),
  decrease: page.getByRole("button", { name: "Remove one" }),
  add: page.getByRole("button", { name: "ADD" }),
}`;

/** Runs `setQuantity` and returns its answer, or its failure's name, reason and numbers. */
const set = async (page: Page, wanted: number, options = "{}") => {
  const answer = await call(
    page,
    `try {
      return await setQuantity(${stepper}, ${wanted}, { overlays: page.locator("#loader"), ...${options} });
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { name: error.name, reason: error.reason, quantity: error.quantity, expected: error.expected };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as Record<string, unknown>;
};

const presses = async (page: Page) => Number(await page.locator("#presses").textContent());

test("adds from ADD to three, one press at a time, each read back", async ({ page }) => {
  const received = await shop(page);
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 3 });
  expect(received).toEqual([1, 2, 3]);
  expect(await presses(page)).toBe(3);
  await expect(page.locator(".count")).toHaveText("3");
});

test("steps down to one, and down to nothing, where ADD shows again", async ({ page }) => {
  const received = await shop(page, { start: 3 });
  expect(await set(page, 1)).toEqual({ set: true, quantity: 1, presses: 2 });
  expect(await set(page, 0)).toEqual({ set: true, quantity: 0, presses: 1 });
  expect(received).toEqual([2, 1, 0]);
  await expect(page.getByRole("button", { name: "ADD" })).toBeVisible();
});

test("presses nothing when the line already holds the quantity", async ({ page }) => {
  const received = await shop(page, { start: 2 });
  expect(await set(page, 2)).toEqual({ set: true, quantity: 2, presses: 0 });
  expect(received).toEqual([]);
  expect(await presses(page)).toBe(0);
});

test("stops at the site's limit when the site greys out its + button", async ({ page }) => {
  const received = await shop(page, { start: 1, max: 2 });
  expect(await set(page, 4)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 1 });
  expect(received).toEqual([2]);
});

test("stops at the site's limit when the site says so, with the limit sign named", async ({ page }) => {
  const received = await shop(page, { start: 1, max: 2, says: true });
  expect(await set(page, 4, `{ limit: page.locator("#limit-note") }`)).toEqual({
    set: false,
    reason: "limit",
    quantity: 2,
    presses: 2,
  });
  expect(received).toEqual([2]);
});

test("waits out steps the site greys out for a moment after each answer, never taking them for its limit", async ({
  page,
}) => {
  const received = await shop(page, { start: 1, holdMs: 800 });
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
  expect(received).toEqual([2, 3]);
});

test("takes a limit sign that showed before the press only once the count stays put", async ({ page }) => {
  const received = await shop(page, { start: 1, max: 2, says: true, noteShown: true });
  expect(await set(page, 4, `{ limit: page.locator("#limit-note") }`)).toEqual({
    set: false,
    reason: "limit",
    quantity: 2,
    presses: 2,
  });
  expect(received).toEqual([2]);
});

test("fails as not_changed, pressing once, when a press leaves the count as it was", async ({ page }) => {
  await shop(page, { start: 1, max: 2, says: true });
  expect(await set(page, 3)).toEqual({ name: "QuantityFailure", reason: "not_changed", quantity: 2 });
  expect(await presses(page)).toBe(2);
});

test("fails as unexpected_count when one press moves the count by more than one", async ({ page }) => {
  const received = await shop(page, { start: 1, step: 2 });
  expect(await set(page, 4)).toEqual({ name: "QuantityFailure", reason: "unexpected_count", quantity: 3, expected: 2 });
  expect(received).toEqual([3]);
});

test("reads a count the stepper shows in an input", async ({ page }) => {
  const received = await shop(page, { start: 1, input: true });
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
  expect(received).toEqual([2, 3]);
});

test("refuses, before any press, more steps than maxSteps allows", async ({ page }) => {
  const received = await shop(page);
  expect(await set(page, 30)).toMatchObject({ name: "QuantityFailure", reason: "too_many_steps", quantity: 0 });
  expect(received).toEqual([]);
  expect(await presses(page)).toBe(0);
});
