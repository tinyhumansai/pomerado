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
// reaches the count asked for. Other cards copy an optimistic stepper, which draws the new count at
// once and then the count the site answers with, one that gathers presses into one save sent a
// while after the last, steps greyed out while a save runs, a cart page that takes the line off at
// 0, a page that moves the count by itself, one that draws a stale count for a moment, and a cart
// drawer that scrolls.
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
  /** Draws each press's count at once, with no loader, then the count the site answers with. */
  readonly optimistic?: boolean;
  /** The most the site keeps: it answers each press with the count it holds, at most this. */
  readonly holds?: number;
  /** How long the site takes to answer each press. */
  readonly saveMs?: number;
  /** How long the page waits before it sends a press, as a stepper that gathers presses. */
  readonly saveAfterMs?: number;
  /** Sends one save this long after the last press, for every press before it, as many steppers do. */
  readonly debounceMs?: number;
  /** Writes one at a time: a press during a write sends the latest count once that write ends. */
  readonly queue?: boolean;
  /** How long the page takes to draw the site's answer after it comes; 350 ms by default. */
  readonly renderMs?: number;
  /** Greys out − and + for this long from each press. */
  readonly greyMs?: number;
  /** This long after each press, the page opens a long-poll on its own site that never answers. */
  readonly longPollAfterMs?: number;
  /** This long after each answer, the page takes the whole card off, leaving no ADD. */
  readonly dropLineAfterMs?: number;
  /** Greys out − and + from each press until the site's answer is drawn. */
  readonly greyWhileSaving?: boolean;
  /** Takes the line off the page at 0, as a cart page does, with no ADD. */
  readonly removes?: boolean;
  /** Shows the stepper with a 0 at 0, instead of ADD. */
  readonly zeroStepper?: boolean;
  /** This long after each answer, the page moves the count `steps` more the same way by itself. */
  readonly drift?: { readonly afterMs: number; readonly steps: number };
  /** Stops answering for this long, from just after each press, as a page busy with a long task. */
  readonly freezeMs?: number;
  /**
   * This long after each answer, the page draws the count moved `by` steps for `forMs`, then the
   * answer's count again, as a re-render from a stale store does.
   */
  readonly blip?: { readonly afterMs: number; readonly forMs: number; readonly by: number };
  /**
   * This long after each answer, the page starts drawing the count one step on and back every
   * `everyMs`, and never stops, as two scripts that fight over the line do.
   */
  readonly flicker?: { readonly afterMs: number; readonly everyMs: number };
  /**
   * Fetches from its own site from the start, these waits apart in turn, over and over, as a widget
   * or a tracker on the site's domain does, each time with a query of its own, so the waits never
   * take it for a steady poll.
   */
  readonly chatterMs?: readonly number[];
  /** Puts the card in a cart drawer that scrolls, below the drawer's fold. */
  readonly scrolls?: boolean;
}

/** Serves the product card, records each quantity the site receives, and opens it. */
const shop = async (page: Page, options: Shop = {}) => {
  const received: number[] = [];
  const { saveMs, holds } = options;
  const card = `<div class="product"><h2>Instant noodles</h2><p>₹14</p><div class="cart-control"></div></div>`;
  const body = `<main>
${options.scrolls === true ? `<div class="drawer" style="height: 120px; overflow: auto"><p style="height: 200px">Free delivery on orders over ₹199</p>${card}</div>` : card}
<p id="limit-note" ${options.noteShown === true ? "" : "hidden"}>You can't add more of this item</p>
<div id="loader" hidden style="position: fixed; inset: 0; background: rgba(255, 255, 255, 0.7)">Updating cart</div>
<output id="presses">0</output>
</main>
<script>
let quantity = ${options.start ?? 0};
let busy = false;
let latest = 0;
let gathering;
let writing = false;
let dirty = false;
const max = ${options.max ?? 99};
const control = document.querySelector(".cart-control");
const loader = document.getElementById("loader");
const render = () => {
  if (quantity === 0 && ${options.removes === true}) {
    control.closest(".product")?.remove();
    return;
  }
  if (quantity === 0 && ${options.zeroStepper !== true}) {
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
  const direction = button.matches(".minus") ? -1 : 1;
  const next = quantity + direction * ${options.step ?? 1};
  if (next > max) {
    document.getElementById("limit-note").hidden = false;
    return;
  }
  const press = ++latest;
  if (${options.optimistic === true}) {
    quantity = next;
    render();
  } else {
    busy = true;
    loader.hidden = false;
  }
  if (${options.greyWhileSaving === true}) for (const step of control.querySelectorAll(".minus, .plus")) step.disabled = true;
  const grey = ${options.greyMs ?? 0};
  if (grey > 0) {
    for (const step of control.querySelectorAll(".minus, .plus")) step.disabled = true;
    setTimeout(() => { for (const step of control.querySelectorAll(".minus, .plus")) step.disabled = false; }, grey);
  }
  const longPoll = ${options.longPollAfterMs ?? -1};
  if (longPoll >= 0) setTimeout(() => fetch("/api/poll").catch(() => undefined), longPoll);
  const freeze = ${options.freezeMs ?? 0};
  if (freeze > 0)
    setTimeout(() => {
      const end = Date.now() + freeze;
      while (Date.now() < end);
    }, 100);
  const post = (count) =>
    fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: count }) })
      .then((response) => response.json());
  const draw = (answer) => setTimeout(() => {
    // An answer to a press a newer press replaced is never drawn.
    if (press !== latest && ${options.queue !== true}) return;
    quantity = answer.quantity;
    render();
    loader.hidden = true;
    busy = false;
    const drift = ${JSON.stringify(options.drift ?? null)};
    if (drift !== null)
      setTimeout(() => {
        quantity += direction * drift.steps;
        render();
      }, drift.afterMs);
    const blip = ${JSON.stringify(options.blip ?? null)};
    if (blip !== null)
      setTimeout(() => {
        const shown = control.querySelector(".count");
        if (shown === null) return;
        shown.textContent = String(quantity + blip.by);
        setTimeout(() => { shown.textContent = String(quantity); }, blip.forMs);
      }, blip.afterMs);
    const flicker = ${JSON.stringify(options.flicker ?? null)};
    if (flicker !== null)
      setTimeout(() => setInterval(() => {
        const shown = control.querySelector(".count");
        if (shown !== null) shown.textContent = String(shown.textContent === String(quantity) ? quantity + 1 : quantity);
      }, flicker.everyMs), flicker.afterMs);
    const dropLine = ${options.dropLineAfterMs ?? -1};
    if (dropLine >= 0) setTimeout(() => control.closest(".product")?.remove(), dropLine);
  }, ${options.renderMs ?? 350});
  const queued = async () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    let answer;
    do {
      dirty = false;
      answer = await post(quantity);
    } while (dirty);
    writing = false;
    draw(answer);
  };
  const send = ${options.queue === true} ? queued : () => post(next).then(draw);
  const after = ${options.saveAfterMs ?? 0};
  const debounce = ${options.debounceMs ?? 0};
  if (debounce > 0) {
    // A press made before the save goes out puts it off, and the save sends the latest count.
    clearTimeout(gathering);
    gathering = setTimeout(send, debounce);
  } else if (after > 0) setTimeout(send, after);
  else send();
});
render();
const chatter = ${JSON.stringify(options.chatterMs ?? [])};
const letters = "abcdefghijklmnopqrstuvwxyz";
let turn = 0;
const chat = () => {
  fetch("/api/track?event=" + letters[turn % 26] + letters[Math.floor(turn / 26) % 26]).catch(() => undefined);
  setTimeout(chat, chatter[turn++ % chatter.length]);
};
if (chatter.length > 0) chat();
</script>`;
  await page.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    // A long-poll stays open until the test ends.
    if (new URL(request.url()).pathname === "/api/poll") return;
    if (request.method() === "POST") {
      const asked = Number(JSON.parse(request.postData() ?? "{}").quantity);
      received.push(asked);
      if (saveMs !== undefined) await new Promise((resolve) => setTimeout(resolve, saveMs));
      const held = holds === undefined ? asked : Math.min(asked, holds);
      // The test may end while a slow answer is still on its way.
      await route
        .fulfill({ contentType: "application/json", body: JSON.stringify({ quantity: held }) })
        .catch(() => undefined);
    } else await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${origin}/product`);
  return received;
};

const stepper = `{
  count: page.locator(".product .count"),
  increase: page.getByRole("button", { name: "Add one" }),
  decrease: page.getByRole("button", { name: "Remove one" }),
  add: page.getByRole("button", { name: "ADD", exact: true }),
}`;

/** Runs `setQuantity` and returns its answer, or its failure's name, reason and numbers. */
const set = async (page: Page, wanted: number, options = "{}") => {
  const answer = await call(
    page,
    `try {
      return await setQuantity(${stepper}, ${wanted}, { overlays: page.locator("#loader"), ...${options} });
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { name: error.name, reason: error.reason, quantity: error.quantity, expected: error.expected, presses: error.presses };
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
  expect(await set(page, 3)).toEqual({ name: "QuantityFailure", reason: "not_changed", quantity: 2, presses: 2 });
  expect(await presses(page)).toBe(2);
});

test("fails as unexpected_count when one press moves the count by more than one", async ({ page }) => {
  const received = await shop(page, { start: 1, step: 2 });
  expect(await set(page, 4)).toEqual({
    name: "QuantityFailure",
    reason: "unexpected_count",
    quantity: 3,
    expected: 2,
    presses: 1,
  });
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

test("takes an optimistic count only once the site answers, and stops where the site takes it back", async ({
  page,
}) => {
  // The stepper draws each new count at once; the site keeps at most 2 and answers with that.
  const received = await shop(page, { start: 1, optimistic: true, holds: 2, saveMs: 600 });
  expect(await set(page, 4)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 2 });
  expect(received).toEqual([2, 3]);
  await expect(page.locator(".count")).toHaveText("2");
});

test("waits out steps greyed until a slow save answers, never taking them for the site's limit", async ({ page }) => {
  const received = await shop(page, { start: 1, optimistic: true, greyWhileSaving: true, saveMs: 2600 });
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
  expect(received).toEqual([2, 3]);
});

test("waits out steps greyed while the page saves a press it gathered, by the page's progress", async ({ page }) => {
  // The page sends each press 1.2 s after it, past the second a press's own requests start in.
  const received = await shop(page, {
    start: 1,
    optimistic: true,
    greyWhileSaving: true,
    saveAfterMs: 1200,
    saveMs: 1400,
  });
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
  await expect.poll(() => received).toEqual([2, 3]);
});

// A stepper that draws each new count at once, never greys its steps and sends one save 1.5 s after
// the last press, past the second a press's own requests start in.
test("waits out a save the page sends a while after the last press, and stops where the site caps the count", async ({
  page,
}) => {
  // The site keeps at most 2 and answers with that.
  const received = await shop(page, { start: 1, optimistic: true, debounceMs: 1500, holds: 2 });
  expect(await set(page, 3)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 2 });
  expect(received.at(-1)).toBe(3);
  await expect(page.locator(".count")).toHaveText("2");
});

test("answers only once a save the page sends a while after the last press has kept the count", async ({ page }) => {
  const received = await shop(page, { start: 1, optimistic: true, debounceMs: 1500 });
  expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
  // One save for both presses, sent and answered before the call answered: the wait is the call's
  // last, never one after each press.
  expect(received).toEqual([3]);
  await expect(page.locator(".count")).toHaveText("3");
});

test("stops where the site caps the count after several presses, back at the count the call started from", async ({
  page,
}) => {
  // The site keeps at most 1, the count the line held before the call.
  const received = await shop(page, { start: 1, optimistic: true, debounceMs: 1500, holds: 1 });
  expect(await set(page, 3)).toEqual({ set: false, reason: "limit", quantity: 1, presses: 2 });
  expect(received.at(-1)).toBe(3);
  await expect(page.locator(".count")).toHaveText("1");
});

test("stops where the site caps the count after several presses, short of the count the presses reached", async ({
  page,
}) => {
  const received = await shop(page, { start: 1, optimistic: true, debounceMs: 1500, holds: 2 });
  expect(await set(page, 4)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 3 });
  expect(received.at(-1)).toBe(4);
  await expect(page.locator(".count")).toHaveText("2");
});

test("fails as unexpected_count when a save after the last press drops the count below where the call started", async ({
  page,
}) => {
  // The line held 2 before the call; the site now keeps at most 1.
  const received = await shop(page, { start: 2, optimistic: true, debounceMs: 1500, holds: 1 });
  expect(await set(page, 3)).toEqual({
    name: "QuantityFailure",
    reason: "unexpected_count",
    quantity: 1,
    expected: 3,
    presses: 1,
  });
  expect(received).toEqual([3]);
});

test("fails as unanswered, never set, when the deadline comes before a save sent after the last press ends", async ({
  page,
}) => {
  const received = await shop(page, { start: 1, optimistic: true, debounceMs: 1500, saveMs: 3000 });
  expect(await set(page, 2, `{ deadline: Date.now() + 3500 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 2,
    presses: 1,
  });
  // The save is still on its way: its outcome isn't known.
  expect(received).toEqual([2]);
});

test("answers set once it stops waiting for quiet, on a page whose own requests never pause, as the count holds", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Besides each press's save, the page fetches from its own site 1 s and 1.4 s apart in turn, each
  // time with a query of its own, so it never goes 2 s without a request the waits count.
  const received = await shop(page, { start: 1, chatterMs: [1000, 1400] });
  expect(await set(page, 3, `{ timeout: 20000 }`)).toEqual({ set: true, quantity: 3, presses: 2 });
  expect(received).toEqual([2, 3]);
});

test("waits out a save still on its way when it stops waiting for quiet, and stops where the site caps the count", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // A page that never goes quiet, as above, whose one save after the last press takes 16 s to
  // answer, past the 15 s the call waits for quiet; the site keeps at most 2, and the page draws
  // that 0.8 s after the answer comes, later than a count must hold.
  const received = await shop(page, {
    start: 1,
    optimistic: true,
    debounceMs: 1500,
    saveMs: 16000,
    renderMs: 800,
    holds: 2,
    chatterMs: [1000, 1400],
  });
  expect(await set(page, 3)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 2 });
  expect(received.at(-1)).toBe(3);
  await expect(page.locator(".count")).toHaveText("2");
});

// The deadline or the step's timeout cuts the wait short of the save's going out, 4 s after the
// last press, within the 5 s the call is told a page may stay still: a page not yet quiet for
// unchangedMs is no page that never goes quiet, so its count decides nothing.
for (const [name, wanted, options, presses] of [
  ["the deadline", 2, `{ deadline: Date.now() + 3000, unchangedMs: 5000 }`, 1],
  ["the step's timeout", 2, `{ timeout: 2500, unchangedMs: 5000 }`, 1],
  ["the deadline, after two presses", 3, `{ deadline: Date.now() + 4000, unchangedMs: 5000 }`, 2],
] as const)
  test(`fails as unanswered, never set, when ${name} comes before a gathered save goes out`, async ({ page }) => {
    const received = await shop(page, { start: 1, optimistic: true, debounceMs: 4000, holds: 1 });
    expect(await set(page, wanted, options)).toMatchObject({ name: "QuantityFailure", reason: "unanswered", presses });
    expect(received).toEqual([]);
  });

test("fails as unanswered, never set, when the deadline comes first on a page whose own requests never pause", async ({
  page,
}) => {
  await shop(page, { start: 1, chatterMs: [1000, 1400] });
  expect(await set(page, 2, `{ deadline: Date.now() + 4000 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 2,
    presses: 1,
  });
});

test("answers set within the deadline when the page has gone quiet before it", async ({ page }) => {
  const received = await shop(page, { start: 1 });
  expect(await set(page, 2, `{ deadline: Date.now() + 10000 }`)).toEqual({ set: true, quantity: 2, presses: 1 });
  expect(received).toEqual([2]);
});

test("waits out a write still in flight at the last press, and the one it queued, and stops where the site caps the count", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // One write at a time, each taking 5 s: the first starts 1.15 s after the first press, just before
  // the steps come back at 1.3 s, and the last press's count goes out only when it ends.
  const received = await shop(page, {
    start: 1,
    optimistic: true,
    debounceMs: 1150,
    greyMs: 1300,
    queue: true,
    saveMs: 5000,
    holds: 2,
  });
  expect(await set(page, 3)).toEqual({ set: false, reason: "limit", quantity: 2, presses: 2 });
  expect(received).toEqual([2, 3]);
  await expect(page.locator(".count")).toHaveText("2");
});

test("answers set past a long-poll the page opens after the last press, as the count holds", async ({ page }) => {
  test.setTimeout(60_000);
  await shop(page, { start: 1, longPollAfterMs: 1500 });
  expect(await set(page, 2, `{ timeout: 20000 }`)).toEqual({ set: true, quantity: 2, presses: 1 });
});

test("fails as unanswered, never count_unknown, when the line goes off the page after the last press", async ({ page }) => {
  await shop(page, { start: 1, dropLineAfterMs: 1500 });
  expect(await set(page, 2, `{ noProgressMs: 3000 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 2,
    presses: 1,
  });
});

test("fails as unanswered, never count_unknown, when the deadline has passed before the first read", async ({ page }) => {
  const received = await shop(page, { start: 1 });
  expect(await set(page, 2, `{ deadline: Date.now() - 10 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    presses: 0,
  });
  expect(received).toEqual([]);
});

test("bounds each read by the step's timeout too, so a page that stops answering after a press fails on time", async ({
  page,
}) => {
  await shop(page, { start: 1, freezeMs: 5000 });
  const answer = await call(
    page,
    `const started = Date.now();
    try {
      return await setQuantity(${stepper}, 2, { overlays: page.locator("#loader"), timeout: 1200 });
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { reason: error.reason, presses: error.presses, ms: Date.now() - started };
    }`,
  );
  expect(answer.result).toMatchObject({ reason: "unanswered", presses: 1 });
  expect((answer.result as { ms: number }).ms).toBeLessThan(4000);
});

test("fails as unanswered, never set, when the count keeps moving after the last press", async ({ page }) => {
  // From 1.2 s after each answer, the page draws the count one step on and back every 0.3 s.
  await shop(page, { start: 1, flicker: { afterMs: 1200, everyMs: 300 } });
  expect(await set(page, 2, `{ deadline: Date.now() + 5000 }`)).toMatchObject({
    name: "QuantityFailure",
    reason: "unanswered",
    presses: 1,
  });
});

test("fails as unanswered, never not_changed, when the deadline comes before the site answers a press", async ({
  page,
}) => {
  const received = await shop(page, { start: 1, saveMs: 3000 });
  expect(await set(page, 2, `{ deadline: Date.now() + 1500 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 1,
    presses: 1,
  });
  expect(received).toEqual([2]);
});

test("fails as unanswered, never limit, when the deadline cuts short a wait on greyed steps", async ({ page }) => {
  await shop(page, { start: 1, holdMs: 4000 });
  expect(await set(page, 3, `{ deadline: Date.now() + 1200 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 1,
    presses: 0,
  });
  expect(await presses(page)).toBe(0);
});

test("bounds each read by the deadline, so a page that stops answering after a press fails on time", async ({
  page,
}) => {
  await shop(page, { start: 1, freezeMs: 3000 });
  const answer = await call(
    page,
    `const started = Date.now();
    try {
      return await setQuantity(${stepper}, 2, { overlays: page.locator("#loader"), deadline: started + 1200 });
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { reason: error.reason, presses: error.presses, ms: Date.now() - started };
    }`,
  );
  expect(answer.result).toMatchObject({ reason: "unanswered", presses: 1 });
  expect((answer.result as { ms: number }).ms).toBeLessThan(2200);
});

test("stops pressing once presses outrun the steps asked for, while the page keeps moving the count", async ({
  page,
}) => {
  // A moment after each answer, with its steps still greyed, the page moves the count three more
  // steps the same way by itself, past the quantity asked for.
  const received = await shop(page, { start: 1, holdMs: 1200, drift: { afterMs: 1000, steps: 3 } });
  expect(await set(page, 3, `{ deadline: Date.now() + 20000 }`)).toEqual({
    name: "QuantityFailure",
    reason: "too_many_presses",
    quantity: 1,
    presses: 4,
  });
  expect(received).toEqual([2, 4, 2, 4]);
});

test("names the count and the presses when a second count shows after a press", async ({ page }) => {
  await shop(page, { start: 1 });
  await page.evaluate(() => {
    // Once the first answer is drawn, the page shows the count a second time, as a mini cart does.
    new MutationObserver((_records, observer) => {
      if (document.querySelector(".product .count")?.textContent !== "2") return;
      observer.disconnect();
      document.querySelector(".product")?.insertAdjacentHTML("beforeend", '<span class="count">2</span>');
    }).observe(document.querySelector(".cart-control") as Element, { childList: true, subtree: true });
  });
  expect(await set(page, 3)).toEqual({ name: "QuantityFailure", reason: "count_ambiguous", quantity: 1, presses: 1 });
});

test("reads a line a cart page takes off at its last − as holding none, with ADD named", async ({ page }) => {
  const received = await shop(page, { start: 1, removes: true });
  expect(await set(page, 0)).toEqual({ set: true, quantity: 0, presses: 1 });
  expect(received).toEqual([0]);
});

test("presses + on a stepper that shows 0, never an ADD that is not there", async ({ page }) => {
  const received = await shop(page, { zeroStepper: true });
  expect(await set(page, 2)).toEqual({ set: true, quantity: 2, presses: 2 });
  expect(received).toEqual([1, 2]);
});

test("presses a stepper below the fold of a cart drawer that scrolls, as each click scrolls to it", async ({ page }) => {
  const received = await shop(page, { scrolls: true });
  expect(await set(page, 2)).toEqual({ set: true, quantity: 2, presses: 2 });
  expect(received).toEqual([1, 2]);
});

for (const [by, shown] of [
  [-1, "the count from before the press, never taking it for the site's limit"],
  [1, "a count one step on, never taking it for the quantity asked for"],
] as const)
  test(`waits out a stale count the page draws for a moment between steps: ${shown}`, async ({ page }) => {
    // A second after each answer, while its steps are still greyed, the page draws the stale count
    // for 0.4 s, less than the 0.5 s a count must hold.
    const received = await shop(page, { start: 1, holdMs: 1800, blip: { afterMs: 1000, forMs: 400, by } });
    expect(await set(page, 3)).toEqual({ set: true, quantity: 3, presses: 2 });
    expect(received).toEqual([2, 3]);
  });

test("fails as unanswered, never press_failed, when the reads before a press use up the deadline", async ({ page }) => {
  const received = await shop(page, { start: 1 });
  // A stand-in for the limit sign's locator whose read outlasts the time left, as a page busy with
  // a long task answers.
  const slowLimit = `{ filter: () => ({ count: () => new Promise((resolve) => setTimeout(() => resolve(0), 3000)) }) }`;
  expect(await set(page, 2, `{ limit: ${slowLimit}, deadline: Date.now() + 1500 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 1,
    presses: 0,
  });
  expect(received).toEqual([]);
});

test("fails as unanswered, never press_failed, when the page holds up a press past the step's timeout", async ({ page }) => {
  await shop(page, { start: 1 });
  await page.evaluate(() => {
    // As in the test below: the press reaches the page once a 3 s task ends.
    let held = false;
    document.querySelector(".cart-control")?.addEventListener("pointermove", () => {
      if (held) return;
      held = true;
      const end = Date.now() + 3000;
      while (Date.now() < end);
    });
  });
  expect(await set(page, 2, `{ timeout: 1500 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 1,
    presses: 0,
  });
});

test("fails as unanswered, never press_failed, when the page holds up a press past the deadline", async ({ page }) => {
  await shop(page, { start: 1 });
  await page.evaluate(() => {
    // The first time the pointer reaches the stepper, the page runs a 3 s task, as a hover that
    // loads something in one go does. The press reaches the page once that ends.
    let held = false;
    document.querySelector(".cart-control")?.addEventListener("pointermove", () => {
      if (held) return;
      held = true;
      const end = Date.now() + 3000;
      while (Date.now() < end);
    });
  });
  expect(await set(page, 2, `{ deadline: Date.now() + 1500 }`)).toEqual({
    name: "QuantityFailure",
    reason: "unanswered",
    quantity: 1,
    presses: 0,
  });
});
