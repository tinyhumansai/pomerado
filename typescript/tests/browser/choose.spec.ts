import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { chooseCode } from "../../src/browser/choose.js";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { fixtureEngine } from "./autofill-host-page.js";

// The page's engine watches its navigations from the start, as a worker's does.
test.beforeEach(({ page }) => {
  fixtureEngine(page);
});

// `chooseOne` and `readChoices`, run as a Kernel call body runs them (`page` in scope) on synthetic
// pages that copy common ways a page offers one choice among several: native radios, ARIA radios,
// an accordion whose open row is the choice and closes when pressed again, tiles that show the
// choice only by a class, CSS Modules names and names that start with a chosen word among them, a
// greyed-out row, rows with controls of their own, a list of ways to pay in a frame from another
// origin, and options inside a shadow root; and pages that mislead a reader: a dialog, a tab or
// accordion panel, a section or a plain panel or wrapper with a state of its own around options,
// alike, each with a class of its own or each with a generated class, a chosen tile that holds a
// toggle or a "Save card" checkbox, class names with chosen words inside them or on every option,
// today's date, a slider's slide in view, a highlight beside the choice, a tooltip's trigger, a
// disclosure's state beside a chosen class, and ways to pay greyed out for a moment. Each page
// counts the presses it gets in `#presses`, in the DOM, so an isolated world reads it too.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 20,
    code: `${waitCode}\n${chooseCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

/** Runs `chooseOne` on `option` (code) and returns its answer, or its failure's name and reason. */
const choose = async (page: Page, option: string, options = "{}") => {
  const answer = await call(
    page,
    `try {
      return await chooseOne(${option}, ${options});
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { name: error.name, reason: error.reason, message: error.message };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as Record<string, unknown>;
};

const presses = async (page: Page, frame = page.mainFrame()) =>
  Number(await frame.locator("#presses").textContent());

/**
 * Counts each press of an element matching `selector` in `#presses`: each pointerdown, since a
 * label passes its click on to its radio as a second click event, and Firefox counts both.
 */
const counting = (selector: string) => `<output id="presses">0</output>
<script>
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(${JSON.stringify(selector)})) return;
  const presses = document.getElementById("presses");
  presses.textContent = String(Number(presses.textContent) + 1);
}, true);
</script>`;

/**
 * Drops each press while an element matching `selector` shows, as many pages do under a loader,
 * and counts the presses it dropped in `#dropped`.
 */
const dropping = (selector: string) => `<output id="dropped">0</output>
<script>
for (const type of ["pointerdown", "mousedown", "click"])
  document.addEventListener(type, (event) => {
    if (document.querySelector(${JSON.stringify(selector)}) === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (type !== "pointerdown") return;
    const dropped = document.getElementById("dropped");
    dropped.textContent = String(Number(dropped.textContent) + 1);
  }, true);
</script>`;

const dropped = async (page: Page, frame = page.mainFrame()) =>
  Number(await frame.locator("#dropped").textContent());

const radios = `<fieldset><legend>Delivery slot</legend>
<label><input type="radio" name="slot" value="morning"> Morning</label>
<label><input type="radio" name="slot" value="evening"> Evening</label>
</fieldset>${counting("label")}`;

// Ways to pay as an accordion: pressing a closed row opens it and closes the others, and pressing
// the open row again closes it, so the open row is the choice.
const accordion = (open: string) => `<div class="methods">
${["Cash", "UPI"]
  .map(
    (name) =>
      `<h3><button type="button" class="method" aria-expanded="${name === open}" aria-controls="${name}-panel">${name}</button></h3>
<div id="${name}-panel" ${name === open ? "" : "hidden"}>Details for ${name}</div>`,
  )
  .join("\n")}
</div>
${counting(".method")}
<script>
for (const button of document.querySelectorAll(".method"))
  button.addEventListener("click", () => {
    const opening = button.getAttribute("aria-expanded") !== "true";
    for (const other of document.querySelectorAll(".method")) {
      other.setAttribute("aria-expanded", "false");
      document.getElementById(other.getAttribute("aria-controls")).hidden = true;
    }
    button.setAttribute("aria-expanded", String(opening));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !opening;
  });
</script>`;

// Tiles that show the choice only by a class on the chosen tile.
const tiles = (selected: string | null) => `<div class="sizes">
${["Small", "Large"]
  .map((name) => `<div class="tile${name === selected ? " tile--selected" : ""}" tabindex="0">${name}</div>`)
  .join("\n")}
</div>
<p id="summary"></p>
${counting(".tile")}
<script>
for (const tile of document.querySelectorAll(".tile"))
  tile.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tile")) other.classList.remove("tile--selected");
    tile.classList.add("tile--selected");
    document.getElementById("summary").textContent = "Size: " + tile.textContent;
  });
</script>`;

// Ways to pay as ARIA radios, Cash greyed out for `greyMs` after the page opens, as while the page
// recalculates its totals, under a loader that lets presses through when `loader` is set.
const greyedWays = (greyMs: number, loader = false) => `<div role="radiogroup" aria-label="Pay with">
<div role="radio" class="way" aria-checked="false" aria-disabled="true" tabindex="0">Cash</div>
<div role="radio" class="way" aria-checked="true" tabindex="0">UPI</div>
</div>
${loader ? '<div id="loader" style="position: fixed; inset: 0; background: rgba(255, 255, 255, 0.6); pointer-events: none">Updating totals</div>' : ""}
${counting(".way")}
<script>
const ways = document.querySelectorAll(".way");
setTimeout(() => {
  ways[0].removeAttribute("aria-disabled");
  document.getElementById("loader")?.remove();
}, ${greyMs});
for (const way of ways)
  way.addEventListener("click", () => {
    if (way.getAttribute("aria-disabled") === "true" || document.getElementById("loader")) return;
    for (const other of ways) other.setAttribute("aria-checked", "false");
    way.setAttribute("aria-checked", "true");
  });
</script>`;

// Ways to pay that show the chosen one only by a class, which moves to the way pressed, inside
// whatever `around` draws around them; with `own`, each way also carries a class of its own beside
// the one they share, as BEM's way--cash does.
const classedWays = (around: (ways: string) => string, own = false) => `${around(`<div class="way${own ? " way--cash" : ""}" tabindex="0">Cash</div>
<div class="way${own ? " way--upi" : ""} way--selected" tabindex="0">UPI</div>`)}
${counting(".way")}
<script>
for (const way of document.querySelectorAll(".way"))
  way.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".way")) other.classList.remove("way--selected");
    way.classList.add("way--selected");
  });
</script>`;

test.describe("chooseOne", () => {
  test("presses an unchosen native radio once, reads it checked, and never presses a chosen one again", async ({
    page,
  }) => {
    await page.setContent(radios);
    const evening = `page.locator("label", { hasText: "Evening" })`;
    expect(await choose(page, evening)).toEqual({ chosen: true, pressed: true, label: "Evening", by: "checked" });
    expect(await page.getByLabel("Evening").isChecked()).toBe(true);
    expect(await choose(page, evening)).toEqual({ chosen: true, pressed: false, label: "Evening", by: "checked" });
    expect(await presses(page)).toBe(1);
  });

  test("leaves an accordion row that is already open as it is, since pressing it again closes it", async ({
    page,
  }) => {
    await page.setContent(accordion("Cash"));
    expect(await choose(page, `page.getByRole("button", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Cash",
      by: "aria-expanded",
    });
    expect(await presses(page)).toBe(0);
    await expect(page.getByText("Details for Cash")).toBeVisible();
  });

  test("opens a closed accordion row with one press and reads it open", async ({ page }) => {
    await page.setContent(accordion("UPI"));
    expect(await choose(page, `page.getByRole("button", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-expanded",
    });
    expect(await presses(page)).toBe(1);
    await expect(page.getByText("Details for Cash")).toBeVisible();
    await expect(page.getByText("Details for UPI")).toBeHidden();
  });

  test("answers a greyed-out option as unavailable with its words, and never presses it", async ({ page }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Pay with">
<div role="radio" class="way" aria-checked="false" aria-disabled="true" tabindex="-1">Cash <small>Not available at the moment</small></div>
<div role="radio" class="way" aria-checked="true" tabindex="0">UPI</div>
</div>${counting(".way")}`);
    expect(await choose(page, `page.getByRole("radio", { name: /Cash/ })`)).toEqual({
      chosen: false,
      reason: "unavailable",
      label: "Cash Not available at the moment",
    });
    expect(await presses(page)).toBe(0);
  });

  test("answers an option whose own words say it is unavailable as unavailable, with no disabled mark", async ({
    page,
  }) => {
    await page.setContent(`<div class="ways">
<div class="way">Cash on delivery <span class="note">Currently unavailable for this order</span></div>
<div class="way way--active">Pay online</div>
</div>${counting(".way")}`);
    expect(await choose(page, `page.locator(".way", { hasText: "Cash on delivery" })`)).toEqual({
      chosen: false,
      reason: "unavailable",
      label: "Cash on delivery Currently unavailable for this order",
    });
    expect(await presses(page)).toBe(0);
  });

  test("answers a radio in a disabled group as unavailable, and never presses its label", async ({ page }) => {
    await page.setContent(radios.replace("<fieldset>", "<fieldset disabled>"));
    expect(await choose(page, `page.locator("label", { hasText: "Evening" })`)).toEqual({
      chosen: false,
      reason: "unavailable",
      label: "Evening",
    });
    expect(await presses(page)).toBe(0);
  });

  test("chooses a tile that shows the choice only by a class, and leaves the chosen tile alone", async ({
    page,
  }) => {
    await page.setContent(tiles("Large"));
    expect(await choose(page, `page.locator(".tile", { hasText: "Large" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Large",
      by: "class",
    });
    expect(await choose(page, `page.locator(".tile", { hasText: "Small" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Small",
      by: "class",
    });
    expect(await presses(page)).toBe(1);
    await expect(page.locator("#summary")).toHaveText("Size: Small");
  });

  test("refuses, before any press, an option whose page shows no chosen state anywhere", async ({ page }) => {
    await page.setContent(tiles(null));
    expect(await choose(page, `page.locator(".tile", { hasText: "Small" })`)).toMatchObject({
      name: "ChooseFailure",
      reason: "state_unknown",
    });
    expect(await presses(page)).toBe(0);
  });

  test("takes the page's own sign of the choice when one is named as chosen", async ({ page }) => {
    await page.setContent(tiles(null));
    expect(
      await choose(
        page,
        `page.locator(".tile", { hasText: "Small" })`,
        `{ chosen: page.locator("#summary", { hasText: "Size: Small" }) }`,
      ),
    ).toEqual({ chosen: true, pressed: true, label: "Small", by: "chosen" });
    expect(await presses(page)).toBe(1);
  });

  test("waits for a loader drawn over the option to clear, then presses it once", async ({ page }) => {
    // The loader lets presses through to the option, and the page drops each one while it shows.
    await page.setContent(`${radios}
<div id="loader" style="position: fixed; inset: 0; background: rgba(255, 255, 255, 0.8); pointer-events: none">Updating</div>
${dropping("#loader")}
<script>setTimeout(() => document.getElementById("loader").remove(), 700);</script>`);
    expect(
      await choose(page, `page.locator("label", { hasText: "Morning" })`, `{ overlays: page.locator("#loader") }`),
    ).toEqual({ chosen: true, pressed: true, label: "Morning", by: "checked" });
    expect(await presses(page)).toBe(1);
    expect(await dropped(page)).toBe(0);
  });

  test("fails as not_chosen when the page ignores the press, and never presses twice", async ({ page }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Speed">
<div role="radio" class="speed" aria-checked="false" tabindex="0">Express</div>
<div role="radio" class="speed" aria-checked="true" tabindex="0">Standard</div>
</div>${counting(".speed")}`);
    expect(await choose(page, `page.getByRole("radio", { name: "Express" })`, `{ timeout: 1500 }`)).toMatchObject({
      name: "ChooseFailure",
      reason: "not_chosen",
    });
    expect(await presses(page)).toBe(1);
  });

  test("fails as reverted when the page takes the choice back after showing it", async ({ page }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Speed">
<div role="radio" class="speed" aria-checked="false" tabindex="0">Express</div>
<div role="radio" class="speed" aria-checked="true" tabindex="0">Standard</div>
</div>${counting(".speed")}
<script>
const [express, standard] = document.querySelectorAll(".speed");
express.addEventListener("click", () => {
  express.setAttribute("aria-checked", "true");
  standard.setAttribute("aria-checked", "false");
  setTimeout(() => {
    express.setAttribute("aria-checked", "false");
    standard.setAttribute("aria-checked", "true");
  }, 150);
});
</script>`);
    expect(await choose(page, `page.getByRole("radio", { name: "Express" })`, `{ timeout: 2500 }`)).toMatchObject({
      name: "ChooseFailure",
      reason: "reverted",
    });
    expect(await presses(page)).toBe(1);
  });

  test("names the failure when the locator matches several visible options", async ({ page }) => {
    await page.setContent(radios);
    expect(await choose(page, `page.locator("label")`)).toMatchObject({ name: "ChooseFailure", reason: "ambiguous" });
    expect(await presses(page)).toBe(0);
  });

  test("chooses an option inside an open shadow root", async ({ page }) => {
    await page.setContent(`<pay-ways></pay-ways>
<script>
customElements.define("pay-ways", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div role="radiogroup" aria-label="Pay with">' +
      '<div role="radio" aria-checked="true" tabindex="0">Card</div>' +
      '<div role="radio" aria-checked="false" tabindex="0">Cash</div></div>';
    for (const radio of root.querySelectorAll("[role=radio]"))
      radio.addEventListener("click", () => {
        for (const other of root.querySelectorAll("[role=radio]")) other.setAttribute("aria-checked", "false");
        radio.setAttribute("aria-checked", "true");
      });
  }
});
</script>`);
    expect(await choose(page, `page.getByRole("radio", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-checked",
    });
    await expect(page.getByRole("radio", { name: "Card" })).toHaveAttribute("aria-checked", "false");
  });

  test("leaves a chosen option the site disables, such as the current tab, as chosen", async ({ page }) => {
    await page.setContent(`<div role="tablist" aria-label="Get it by">
<button type="button" role="tab" aria-selected="true" disabled>Delivery</button>
<button type="button" role="tab" aria-selected="false">Pickup</button>
</div>${counting("[role=tab]")}`);
    expect(await choose(page, `page.getByRole("tab", { name: "Delivery" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Delivery",
      by: "aria-selected",
    });
    expect(await presses(page)).toBe(0);
  });

  test("waits out a way to pay greyed for a moment while totals recalculate, then presses it once", async ({
    page,
  }) => {
    await page.setContent(greyedWays(1000));
    expect(await choose(page, `page.getByRole("radio", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-checked",
    });
    expect(await presses(page)).toBe(1);
  });

  test("waits out a way greyed behind a named loader for longer than the unchanged window", async ({ page }) => {
    await page.setContent(greyedWays(2600, true));
    expect(await choose(page, `page.getByRole("radio", { name: "Cash" })`, `{ overlays: page.locator("#loader") }`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-checked",
    });
    expect(await presses(page)).toBe(1);
  });

  test("fails as timeout, never unavailable, when the deadline comes while a greyed way's page is still busy", async ({
    page,
  }) => {
    await page.setContent(greyedWays(60_000, true));
    expect(
      await choose(page, `page.getByRole("radio", { name: "Cash" })`, `{ overlays: page.locator("#loader"), timeout: 1500 }`),
    ).toMatchObject({ name: "ChooseFailure", reason: "timeout" });
    expect(await presses(page)).toBe(0);
  });

  test("chooses an option whose own label holds the word unavailable, and still reads a note on a line of its own", async ({
    page,
  }) => {
    await page.setContent(`<fieldset><legend>If an item is out of stock</legend>
<label><input type="radio" name="missing" value="refund"> Refund unavailable items</label>
<label><input type="radio" name="missing" value="call" checked> Call me</label>
<label><input type="radio" name="missing" value="swap"> Swap it<br>Not available for this order</label>
</fieldset>${counting("label")}`);
    expect(await choose(page, `page.locator("label", { hasText: "Refund unavailable items" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Refund unavailable items",
      by: "checked",
    });
    expect(await choose(page, `page.locator("label", { hasText: "Swap it" })`)).toEqual({
      chosen: false,
      reason: "unavailable",
      label: "Swap it Not available for this order",
    });
    expect(await presses(page)).toBe(1);
  });

  test("answers an option that renders late, already greyed out, as unavailable without waiting on it", async ({
    page,
  }) => {
    await page.setContent(`<div class="methods"></div>${counting(".method")}
<script>
setTimeout(() => {
  document.querySelector(".methods").innerHTML =
    '<h3><button type="button" class="method" aria-expanded="false" disabled>Cash <span>Not available at the moment</span></button></h3>' +
    '<h3><button type="button" class="method" aria-expanded="true">UPI</button></h3>';
}, 500);
</script>`);
    expect(await choose(page, `page.getByRole("button", { name: /Cash/ })`, `{ timeout: 6000 }`)).toEqual({
      chosen: false,
      reason: "unavailable",
      label: "Cash Not available at the moment",
    });
    expect(await presses(page)).toBe(0);
  });

  test("fails as timeout, never pressing, when the deadline passes while it looks before the press", async ({ page }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Speed">
<div role="radio" class="speed" aria-checked="false" tabindex="0">Express</div>
<div role="radio" class="speed" aria-checked="true" tabindex="0">Standard</div>
</div>${counting(".speed")}`);
    // The caller's sign answers at once, then takes 1.6 s, past the deadline, on its next look.
    const slowSign = `(() => {
      let looks = 0;
      return async () => {
        looks += 1;
        if (looks > 1) await waitSleep(1600);
        return false;
      };
    })()`;
    expect(
      await choose(page, `page.getByRole("radio", { name: "Express" })`, `{ timeout: 1500, chosen: ${slowSign} }`),
    ).toMatchObject({ name: "ChooseFailure", reason: "timeout" });
    expect(await presses(page)).toBe(0);
  });

  test("fails as timeout, never press_failed, when the deadline cuts the click short", async ({ page }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Speed">
<div role="radio" class="speed" aria-checked="false" tabindex="0">Express</div>
<div role="radio" class="speed" aria-checked="true" tabindex="0">Standard</div>
</div>${counting(".speed")}`);
    // The caller's sign answers at once, and on its last look before the press sets the option
    // moving, so the click waits for it to hold still until the deadline.
    const movingSign = `(() => {
      let looks = 0;
      return async () => {
        looks += 1;
        if (looks > 1)
          await page.getByRole("radio", { name: "Express" }).evaluate((option) => {
            option.animate([{ transform: "translateX(0)" }, { transform: "translateX(60px)" }], { duration: 300, iterations: Infinity });
          });
        return false;
      };
    })()`;
    expect(
      await choose(page, `page.getByRole("radio", { name: "Express" })`, `{ timeout: 1500, chosen: ${movingSign} }`),
    ).toMatchObject({ name: "ChooseFailure", reason: "timeout" });
    expect(await presses(page)).toBe(0);
  });

  test("restarts the hold when the page takes the choice back for a moment, and fails as reverted once it keeps it back", async ({
    page,
  }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Speed">
<div role="radio" class="speed" aria-checked="false" tabindex="0">Express</div>
<div role="radio" class="speed" aria-checked="true" tabindex="0">Standard</div>
</div>${counting(".speed")}
<script>
const [express, standard] = document.querySelectorAll(".speed");
const show = (on) => {
  express.setAttribute("aria-checked", String(on));
  standard.setAttribute("aria-checked", String(!on));
};
express.addEventListener("click", () => {
  show(true);
  setTimeout(() => show(false), 250);
  setTimeout(() => show(true), 600);
  setTimeout(() => show(false), 700);
});
</script>`);
    expect(await choose(page, `page.getByRole("radio", { name: "Express" })`, `{ timeout: 3000 }`)).toMatchObject({
      name: "ChooseFailure",
      reason: "reverted",
    });
    expect(await presses(page)).toBe(1);
  });
});

test.describe("an option's state", () => {
  for (const [name, around] of [
    ["an open dialog", (ways: string) => `<div role="dialog" aria-label="Pay with" data-state="open">${ways}</div>`],
    ["an active tab panel", (ways: string) => `<div role="tabpanel" aria-label="Pay with" data-state="active">${ways}</div>`],
    ["an open accordion panel", (ways: string) => `<div role="region" aria-label="Pay with" data-state="open">${ways}</div>`],
    ["an expanded section", (ways: string) => `<section aria-expanded="true"><h2>Pay with</h2>${ways}</section>`],
  ] as const)
    for (const own of [false, true])
      test(`never comes from ${name} around several options${own ? " that each carry a class of their own" : ""}, so an unchosen one is pressed`, async ({
        page,
      }) => {
        await page.setContent(classedWays(around, own));
        expect(await call(page, `return await readChoices(page.locator(".way"));`)).toEqual({
          result: [
            { label: "Cash", chosen: false, unavailable: false, by: "class" },
            { label: "UPI", chosen: true, unavailable: false, by: "class" },
          ],
        });
        expect(await choose(page, `page.locator(".way", { hasText: "Cash" })`)).toEqual({
          chosen: true,
          pressed: true,
          label: "Cash",
          by: "class",
        });
        expect(await presses(page)).toBe(1);
      });

  // Each pair's options share no class and the element around them has a state of its own: a
  // panel that marks itself expanded, as some collapse scripts do, around buttons, a button and a
  // link, or a button and a plain element; an active tab panel around plain elements, of one tag or
  // two; and an open panel, as a disclosure's content shows it, around plain elements, together or
  // one in each.
  for (const [name, html] of [
    [
      "a panel marked expanded around buttons",
      `<div class="collapse" aria-expanded="true"><button type="button" class="pay-upi">UPI</button><button type="button" class="pay-card">Card</button></div>`,
    ],
    [
      "a panel marked expanded around a button and a link",
      `<div class="collapse" aria-expanded="true"><button type="button" class="pay-upi">UPI</button><a href="#card" class="pay-card">Card</a></div>`,
    ],
    [
      "a panel marked expanded around a button and a plain element",
      `<div class="collapse" aria-expanded="true"><button type="button" class="pay-upi">UPI</button><div class="pay-card">Card</div></div>`,
    ],
    [
      "a panel marked expanded around a plain element and a button",
      `<div class="collapse" aria-expanded="true"><div class="pay-card">Card</div><button type="button" class="pay-upi">UPI</button></div>`,
    ],
    [
      "an active tab panel around plain elements",
      `<div role="tabpanel" aria-label="Pay with" data-state="active"><div class="pay-upi">UPI</div><div class="pay-card">Card</div></div>`,
    ],
    [
      "an active tab panel around plain elements of two tags",
      `<div role="tabpanel" aria-label="Pay with" data-state="active"><span class="pay-upi">UPI</span><div class="pay-card">Card</div></div>`,
    ],
    [
      "an open panel around plain elements",
      `<div data-state="open"><div class="pay-upi">UPI</div><div class="pay-card">Card</div></div>`,
    ],
    [
      "an open and a closed panel around one plain element each",
      `<div data-state="open"><div class="pay-upi">UPI</div></div><div data-state="closed"><div class="pay-card">Card</div></div>`,
    ],
  ] as const)
    test(`never comes from ${name} that look nothing alike, so the state stays unknown`, async ({ page }) => {
      await page.setContent(`${html}${counting(".pay-upi, .pay-card")}`);
      expect(await call(page, `return await readChoices(page.locator(".pay-upi, .pay-card"));`)).toEqual({
        result: expect.arrayContaining(["UPI", "Card"].map((label) => ({ label, chosen: null, unavailable: false, by: null }))),
      });
      expect(await choose(page, `page.getByText("Card", { exact: true })`)).toMatchObject({
        name: "ChooseFailure",
        reason: "state_unknown",
      });
      expect(await presses(page)).toBe(0);
    });

  test("never comes from a plain wrapper with a state of its own around options whose generated classes differ", async ({
    page,
  }) => {
    // CSS-in-JS gives each style its own generated class, so options share none, the chosen one's
    // differs, and only unchosen ones may share one. Each wrapper has a state of its own: an
    // expanded mark, an active data attribute, a chosen class that only it carries among wrappers
    // alike, or a pressed mark around swatches named only by a label.
    await page.setContent(`<div class="group" aria-expanded="true">
<div class="css-1q2w3e">UPI</div>
<div class="css-4r5t6y">Card</div>
</div>
<div class="group" data-active>
<div class="css-7u8i9o">Morning</div>
<div class="css-7u8i9o">Noon</div>
<div class="css-0p9o8i">Evening</div>
</div>
<div class="group group--active">
<div class="css-a1s2d3">Gift wrap</div>
<div class="css-f4g5h6">No wrap</div>
</div>
<div class="group" aria-pressed="true">
<div class="css-m3n4b5" aria-label="Red" style="height: 20px"></div>
<div class="css-v6c7x8" aria-label="Blue" style="height: 20px"></div>
</div>${counting(".group > div")}`);
    expect(await call(page, `return await readChoices(page.locator(".group > div"));`)).toEqual({
      result: ["UPI", "Card", "Morning", "Noon", "Evening", "Gift wrap", "No wrap", "Red", "Blue"].map((label) => ({
        label,
        chosen: null,
        unavailable: false,
        by: null,
      })),
    });
    for (const option of [
      `page.getByText("Card", { exact: true })`,
      `page.getByText("Evening", { exact: true })`,
      `page.getByText("Gift wrap", { exact: true })`,
      `page.getByLabel("Blue")`,
    ])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("comes from an option's own sign inside a wrapper with a state of its own, and presses the unchosen one once", async ({
    page,
  }) => {
    // Generated classes again: the chosen way's class moves with the choice, as its style does.
    await page.setContent(`<div class="ways" aria-expanded="true">
<div class="css-1q2w3e" data-selected="false">UPI</div>
<div class="css-4r5t6y" data-selected="true">Card</div>
</div>${counting(".ways > div")}
<script>
const ways = document.querySelectorAll(".ways > div");
for (const way of ways)
  way.addEventListener("click", () => {
    for (const other of ways) {
      other.setAttribute("data-selected", "false");
      other.className = "css-1q2w3e";
    }
    way.setAttribute("data-selected", "true");
    way.className = "css-4r5t6y";
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".ways > div"));`)).toEqual({
      result: [
        { label: "UPI", chosen: false, unavailable: false, by: "data-selected" },
        { label: "Card", chosen: true, unavailable: false, by: "data-selected" },
      ],
    });
    expect(await choose(page, `page.getByText("UPI", { exact: true })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "UPI",
      by: "data-selected",
    });
    expect(await presses(page)).toBe(1);
  });

  test("reads the locator's other matches as the other options, so a wrapper around them gives none its state", async ({
    page,
  }) => {
    // The ways are drawn alike by nothing: no class, no tag, nothing pressed.
    await page.setContent(`<div class="ways" aria-expanded="true" data-active>
<span class="css-1q2w3e">UPI</span>
<div class="css-4r5t6y">Card</div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".ways > *"));`)).toEqual({
      result: ["UPI", "Card"].map((label) => ({ label, chosen: null, unavailable: false, by: null })),
    });
  });

  test("never reads a hidden match as another option, so the row around a match still gives its state", async ({
    page,
  }) => {
    // The locator also matches a copy of the name that the open row hides.
    await page.setContent(`<div class="rows">
<div class="row is-expanded"><h3 class="name">UPI</h3><p class="name" hidden>UPI</p></div>
<div class="row"><h3 class="name">Card</h3></div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".name"));`)).toEqual({
      result: [
        { label: "UPI", chosen: true, unavailable: false, by: "class" },
        { label: "Card", chosen: false, unavailable: false, by: "class" },
      ],
    });
  });

  test("comes from a tile around the part a caller names, beside an icon that shows no words", async ({ page }) => {
    // An empty element drawn as an icon, and an icon font's ligature hidden from assistive
    // technology, sit beside the name in each tile, of the name's own tag.
    await page.setContent(`<div class="tiles">
<div class="tile tile--selected"><div class="icon"></div><div class="name">UPI</div></div>
<div class="tile"><div class="icon"></div><div class="name">Card</div></div>
</div>
<div class="picks">
<div class="pick pick--selected"><span class="glyph" aria-hidden="true">payments</span><span class="word">Wallet</span></div>
<div class="pick"><span class="glyph" aria-hidden="true">credit_score</span><span class="word">Cash</span></div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".name, .word"));`)).toEqual({
      result: [
        { label: "UPI", chosen: true, unavailable: false, by: "class" },
        { label: "Card", chosen: false, unavailable: false, by: "class" },
        { label: "Wallet", chosen: true, unavailable: false, by: "class" },
        { label: "Cash", chosen: false, unavailable: false, by: "class" },
      ],
    });
  });

  test("comes from a button, a label or a tile that takes focus around the part a caller names", async ({ page }) => {
    // Buttons and labels pressed as one, whose name and note share a tag, and tiles that take focus
    // and hold a button of their own, whose names each have a generated class.
    await page.setContent(`<div class="ways">
<button type="button" class="way" aria-pressed="true"><span class="name">UPI</span> <span class="note">Any app</span></button>
<button type="button" class="way" aria-pressed="false"><span class="name">Card</span> <span class="note">Debit or credit</span></button>
</div>
<div class="wraps">
<label class="wrap is-selected"><span class="name">Gift wrap</span> <span class="note">Free</span></label>
<label class="wrap"><span class="name">No wrap</span> <span class="note">Free</span></label>
</div>
<div class="tiles">
<div class="tile" tabindex="0" aria-pressed="true"><span class="css-1q2w3e">Wallet</span> <button type="button">Offers</button></div>
<div class="tile" tabindex="0" aria-pressed="false"><span class="css-4r5t6y">Cash</span> <button type="button">Offers</button></div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".name, .tile > span"));`)).toEqual({
      result: [
        { label: "UPI", chosen: true, unavailable: false, by: "aria-pressed" },
        { label: "Card", chosen: false, unavailable: false, by: "aria-pressed" },
        { label: "Gift wrap", chosen: true, unavailable: false, by: "class" },
        { label: "No wrap", chosen: false, unavailable: false, by: "class" },
        { label: "Wallet", chosen: true, unavailable: false, by: "aria-pressed" },
        { label: "Cash", chosen: false, unavailable: false, by: "aria-pressed" },
      ],
    });
  });

  test("never comes from a panel around a button and a link, though buttons like the option sit in other panels", async ({
    page,
  }) => {
    // Each panel marks itself expanded or not and holds one button, its words in the button or in
    // an element inside it, beside a link: the option is a thing a person presses, so the link may
    // be another option, though no other button sits in its panel.
    await page.setContent(`<div class="collapse" aria-expanded="true"><button type="button">Card</button> <a href="#upi">UPI</a></div>
<div class="collapse" aria-expanded="false"><button type="button"><b>Cash</b></button> <a href="#wallet">Wallet</a></div>
<div class="collapse" aria-expanded="true"><button type="button"><b>Bank</b></button> <a href="#later">Later</a></div>
${counting("button")}`);
    for (const option of [`page.getByRole("button", { name: "Card" })`, `page.getByText("Cash", { exact: true })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("comes from a row with controls of its own when the caller names the row's header", async ({ page }) => {
    // Each row marks itself expanded and holds an Edit button beside its header, which the caller
    // names by its text.
    await page.setContent(`<div class="rows">
<div class="row" aria-expanded="true"><h3 class="row-title">Cash</h3><button type="button" class="edit">Edit</button></div>
<div class="row" aria-expanded="false"><h3 class="row-title">UPI</h3><button type="button" class="edit">Edit</button></div>
</div>${counting(".row-title")}
<script>
const rows = document.querySelectorAll(".row");
for (const row of rows)
  row.querySelector(".row-title").addEventListener("click", () => {
    for (const other of rows) other.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-expanded", "true");
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".row-title"));`)).toEqual({
      result: [
        { label: "Cash", chosen: true, unavailable: false, by: "aria-expanded" },
        { label: "UPI", chosen: false, unavailable: false, by: "aria-expanded" },
      ],
    });
    expect(await choose(page, `page.getByText("UPI", { exact: true })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "UPI",
      by: "aria-expanded",
    });
    expect(await presses(page)).toBe(1);
  });

  test("comes from the option around the element pressed, though parts inside the option look alike", async ({
    page,
  }) => {
    await page.setContent(`<div role="radiogroup" aria-label="Pay with">
<div role="radio" aria-checked="true" tabindex="0"><span class="text">UPI</span> <span class="text">Any UPI app</span></div>
<div role="radio" aria-checked="false" tabindex="0"><span class="text">Card</span> <span class="text">Debit or credit</span></div>
</div>${counting("[role=radio]")}
<script>
const ways = document.querySelectorAll("[role=radio]");
for (const way of ways)
  way.addEventListener("click", () => {
    for (const other of ways) other.setAttribute("aria-checked", "false");
    way.setAttribute("aria-checked", "true");
  });
</script>`);
    const card = `page.getByText("Card", { exact: true })`;
    expect(await choose(page, card)).toEqual({ chosen: true, pressed: true, label: "Card", by: "aria-checked" });
    expect(await choose(page, card)).toEqual({ chosen: true, pressed: false, label: "Card", by: "aria-checked" });
    expect(await presses(page)).toBe(1);
  });

  test("reads a chosen tile that is a tooltip's trigger, or holds a toggle of its own, as chosen, and never presses it", async ({
    page,
  }) => {
    await page.setContent(`<div class="ways">
<button type="button" class="way" data-state="closed">Cash</button>
<button type="button" class="way way--selected" data-state="closed">UPI</button>
</div>
<div class="cards">
<div class="card" tabindex="0">Debit card <button type="button" aria-expanded="false">Offers</button></div>
<div class="card card--selected" tabindex="0">Credit card <button type="button" aria-expanded="false">Offers</button></div>
</div>${counting(".way, .card")}`);
    expect(await choose(page, `page.locator(".way", { hasText: "UPI" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "UPI",
      by: "class",
    });
    expect(await choose(page, `page.locator(".card", { hasText: "Credit card" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Credit card Offers",
      by: "class",
    });
    expect(await presses(page)).toBe(0);
  });

  test("never reads a chosen word inside a compound class name, a Tailwind variant or a lone option's class", async ({
    page,
  }) => {
    // Each pair is the same but for the class under test, so only its own rule keeps that class
    // from reading as chosen; the lone option's class does say chosen.
    await page.setContent(`<div class="ways">
<div class="method" tabindex="0">UPI</div>
<div class="method has-active-offer" tabindex="0">Card</div>
</div>
<div class="sizes">
<button type="button" class="rounded border px-4">Small</button>
<button type="button" class="rounded border px-4 hover:btn-active">Large</button>
</div>
<div class="extras">
<button type="button" class="gift is-selected">Gift wrap</button>
</div>${counting(".method, button")}`);
    expect(await call(page, `return await readChoices(page.locator(".method, button"));`)).toEqual({
      result: ["UPI", "Card", "Small", "Large", "Gift wrap"].map((label) => ({
        label,
        chosen: null,
        unavailable: false,
        by: null,
      })),
    });
    for (const option of [
      `page.locator(".method", { hasText: "Card" })`,
      `page.getByRole("button", { name: "Large" })`,
      `page.getByRole("button", { name: "Gift wrap" })`,
    ])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("reads a class in the CSS Modules shape by its own name, and keeps a BEM element's last word", async ({
    page,
  }) => {
    await page.setContent(`<div class="sizes">
<div class="Tile_tile__a1b2c" tabindex="0">Small</div>
<div class="Tile_tile__a1b2c Tile_selected__x7f3a" tabindex="0">Large</div>
</div>
<div class="slots">
<div class="slot" tabindex="0">Morning</div>
<div class="slot slot__active" tabindex="0">Evening</div>
</div>${counting(".sizes > div")}
<script>
for (const tile of document.querySelectorAll(".sizes > div"))
  tile.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".sizes > div")) other.classList.remove("Tile_selected__x7f3a");
    tile.classList.add("Tile_selected__x7f3a");
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".sizes > div, .slot"));`)).toEqual({
      result: [
        { label: "Small", chosen: false, unavailable: false, by: "class" },
        { label: "Large", chosen: true, unavailable: false, by: "class" },
        { label: "Morning", chosen: false, unavailable: false, by: "class" },
        { label: "Evening", chosen: true, unavailable: false, by: "class" },
      ],
    });
    expect(await choose(page, `page.locator(".sizes > div", { hasText: "Small" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Small",
      by: "class",
    });
    expect(await presses(page)).toBe(1);
  });

  test("reads a class that starts with a chosen word whose rest the options carry, never one with the word inside or on every option", async ({
    page,
  }) => {
    // Slots and tabs whose chosen class is a chosen word before a class each option carries, chips
    // whose chosen one carries only that class, a slot whose class holds the word after a negation,
    // ways that each carry a class starting with a chosen word whose rest names a count, plans that
    // each carry such a class whose rest is theirs, and tallies with such classes whose rest no
    // element carries.
    await page.setContent(`<div class="slots">
<div class="slot" tabindex="0">Morning</div>
<div class="slot not-selected-slot" tabindex="0">Noon</div>
<div class="slot selected-slot" tabindex="0">Evening</div>
</div>
<div class="tabs">
<div class="tab" tabindex="0">Delivery</div>
<div class="tab active-tab" tabindex="0">Pickup</div>
</div>
<div class="chips">
<div class="chip" tabindex="0">Plain</div>
<div class="selected-chip" tabindex="0">Gift</div>
</div>
<div class="ways">
<div class="way way--cash-on-delivery selected-items-count" tabindex="0">Cash on delivery</div>
<div class="way way--upi selected-items-count" tabindex="0">UPI</div>
</div>
<div class="plans">
<div class="plan selected-plan" tabindex="0">Monthly</div>
<div class="plan selected-plan" tabindex="0">Yearly</div>
</div>
<div class="tallies">
<div class="tally selected-count active-count" tabindex="0">3 picked</div>
<div class="tally active-count" tabindex="0">2 running</div>
</div>${counting(".slot")}
<script>
const slots = document.querySelectorAll(".slot");
for (const slot of slots)
  slot.addEventListener("click", () => {
    for (const other of slots) other.classList.remove("selected-slot");
    slot.classList.add("selected-slot");
  });
</script>`);
    const state = (label: string, chosen: boolean | null) => ({
      label,
      chosen,
      unavailable: false,
      by: chosen === null ? null : "class",
    });
    expect(await call(page, `return await readChoices(page.locator(".slots > div, .tabs > div, .chips > div, .way, .plan, .tally"));`)).toEqual({
      result: [
        state("Morning", false),
        state("Noon", null),
        state("Evening", true),
        state("Delivery", false),
        state("Pickup", true),
        state("Plain", false),
        state("Gift", true),
        state("Cash on delivery", null),
        state("UPI", null),
        state("Monthly", null),
        state("Yearly", null),
        state("3 picked", null),
        state("2 running", null),
      ],
    });
    expect(await choose(page, `page.getByText("Morning", { exact: true })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Morning",
      by: "class",
    });
    expect(await choose(page, `page.locator(".way", { hasText: "UPI" })`)).toMatchObject({
      name: "ChooseFailure",
      reason: "state_unknown",
    });
    expect(await presses(page)).toBe(1);
  });

  test("never takes the state from a control in the option's own content, and prefers the option's own radio", async ({
    page,
  }) => {
    // Ways to pay as an accordion whose open row's panel shows a "Save card" checkbox and whose
    // closed row's panel holds a switch named by the words beside it, and plans and rates whose own
    // radio, labelled by a picture alone, comes after a switch of their own, named or not, as a
    // radio drawn at a row's end.
    await page.setContent(`<style>.way:not(.way--expanded) .panel { display: none }</style>
<div class="ways">
<div class="way way--expanded" tabindex="0">Card<div class="panel"><label><input type="checkbox"> Save card</label></div></div>
<div class="way" tabindex="0">UPI<div class="panel"><button type="button" role="switch" aria-checked="false" aria-labelledby="save-upi"></button> <span id="save-upi">Save UPI ID</span></div></div>
</div>
<div class="plans">
<div class="plan"><span>Monthly</span> <button type="button" role="switch" aria-checked="false" aria-label="Renew"></button> <input type="radio" name="plan" id="monthly" checked><label for="monthly"><img alt="" width="12" height="12"></label></div>
<div class="plan"><span>Yearly</span> <button type="button" role="switch" aria-checked="true" aria-label="Renew"></button> <input type="radio" name="plan" id="yearly"><label for="yearly"><img alt="" width="12" height="12"></label></div>
</div>
<div class="rates">
<div class="rate"><span>Daily</span> <button type="button" role="switch" aria-checked="false"></button> <input type="radio" name="rate" id="daily" checked><label for="daily"><img alt="" width="12" height="12"></label></div>
<div class="rate"><span>Weekly</span> <button type="button" role="switch" aria-checked="true"></button> <input type="radio" name="rate" id="weekly"><label for="weekly"><img alt="" width="12" height="12"></label></div>
</div>${counting(".way")}
<script>
// Pressing a row opens it and closes the others, and pressing the open row closes it.
for (const way of document.querySelectorAll(".way"))
  way.addEventListener("click", (event) => {
    if (event.target.closest(".panel")) return;
    const opening = !way.classList.contains("way--expanded");
    for (const other of document.querySelectorAll(".way")) other.classList.remove("way--expanded");
    way.classList.toggle("way--expanded", opening);
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".way, .plan, .rate"));`)).toEqual({
      result: [
        { label: "Card Save card", chosen: true, unavailable: false, by: "class" },
        { label: "UPI", chosen: false, unavailable: false, by: "class" },
        { label: "Monthly", chosen: true, unavailable: false, by: "checked" },
        { label: "Yearly", chosen: false, unavailable: false, by: "checked" },
        { label: "Daily", chosen: true, unavailable: false, by: "checked" },
        { label: "Weekly", chosen: false, unavailable: false, by: "checked" },
      ],
    });
    expect(await choose(page, `page.locator(".way", { hasText: "Card" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Card Save card",
      by: "class",
    });
    expect(await presses(page)).toBe(0);
    await expect(page.getByText("Save card")).toBeVisible();
  });

  test("never reads an aria-current of date or time as chosen, and still reads the day picked by its class", async ({
    page,
  }) => {
    // Today's cell marks itself as the date, the picked day shows only a class, and the time slot
    // that is now marks itself as the time beside the one pressed.
    await page.setContent(`<div class="days">
<span class="day today" aria-current="date" tabindex="-1">5</span>
<span class="day day--selected" tabindex="0">6</span>
<span class="day" tabindex="-1">7</span>
</div>
<div class="slots">
<button type="button" class="slot" aria-current="time">Now</button>
<button type="button" class="slot" aria-pressed="true">Later</button>
</div>${counting(".day, .slot")}`);
    expect(await call(page, `return await readChoices(page.locator(".day, .slot"));`)).toEqual({
      result: [
        { label: "5", chosen: null, unavailable: false, by: null },
        { label: "6", chosen: true, unavailable: false, by: "class" },
        { label: "7", chosen: false, unavailable: false, by: "class" },
        { label: "Now", chosen: null, unavailable: false, by: null },
        { label: "Later", chosen: true, unavailable: false, by: "aria-pressed" },
      ],
    });
    for (const option of [`page.getByText("5", { exact: true })`, `page.getByRole("button", { name: "Now" })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("reads an aria-current on the element around the option, as on the option, and never of a date", async ({
    page,
  }) => {
    // A nav whose current page marks its list item, and a row whose cell marks today around the
    // radio-like row that holds the state.
    await page.setContent(`<nav><div class="item" aria-current="page"><a href="#a" class="link">Delivery</a></div>
<div class="item"><a href="#b" class="link">Pickup</a></div></nav>
<div role="radio" aria-checked="false" class="pick"><span aria-current="date"><b>Today</b></span></div>${counting(".link")}`);
    expect(await call(page, `return await readChoices(page.locator(".link, .pick b"));`)).toEqual({
      result: [
        { label: "Delivery", chosen: true, unavailable: false, by: "aria-current" },
        { label: "Pickup", chosen: null, unavailable: false, by: null },
        { label: "Today", chosen: false, unavailable: false, by: "aria-checked" },
      ],
    });
    expect(await choose(page, `page.getByRole("link", { name: "Delivery" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Delivery",
      by: "aria-current",
    });
    expect(await presses(page)).toBe(0);
  });

  test("never takes the state from a control named only by words of its own, and presses the plan left unchosen", async ({
    page,
  }) => {
    // Plans whose switch, named only by an aria-label, is left on in the unchosen one; rows with a
    // box named only by an aria-label that holds a word of the row's name; and tiles with a box
    // named only by a title.
    await page.setContent(`<div class="plans">
<div class="plan" tabindex="0">Basic <button type="button" role="switch" aria-checked="true" aria-label="Auto-renew"></button></div>
<div class="plan plan--selected" tabindex="0">Gold <button type="button" role="switch" aria-checked="false" aria-label="Auto-renew"></button></div>
</div>
<div class="ways">
<div class="way" tabindex="0">UPI <input type="checkbox" aria-label="Save UPI ID" checked></div>
<div class="way way--selected" tabindex="0">Card <input type="checkbox" aria-label="Save card"></div>
</div>
<div class="tiles">
<div class="tile tile--selected" tabindex="0">Small <input type="checkbox" title="Compare"></div>
<div class="tile" tabindex="0">Large <input type="checkbox" title="Compare" checked></div>
</div>${counting(".plan")}
<script>
const plans = document.querySelectorAll(".plan");
for (const plan of plans)
  plan.addEventListener("click", () => {
    for (const other of plans) other.classList.remove("plan--selected");
    plan.classList.add("plan--selected");
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".plan, .way, .tile"));`)).toEqual({
      result: [
        { label: "Basic", chosen: false, unavailable: false, by: "class" },
        { label: "Gold", chosen: true, unavailable: false, by: "class" },
        { label: "UPI", chosen: false, unavailable: false, by: "class" },
        { label: "Card", chosen: true, unavailable: false, by: "class" },
        { label: "Small", chosen: true, unavailable: false, by: "class" },
        { label: "Large", chosen: false, unavailable: false, by: "class" },
      ],
    });
    expect(await choose(page, `page.locator(".plan", { hasText: "Basic" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Basic",
      by: "class",
    });
    expect(await presses(page)).toBe(1);
  });

  test("keeps a control named only by the option's first text, a radio that holds it, and a nameless one as its own", async ({
    page,
  }) => {
    // A radio whose name holds the option's name, a box named just as its option, a nameless box, a
    // switch named just as its option in another case, and a radio whose name only holds the
    // option's name inside a word, which is not its own.
    await page.setContent(`<div class="ways">
<div class="way">UPI <input type="radio" name="way" aria-label="Pay by UPI" checked></div>
<div class="way">Card <input type="radio" name="way" title="Pay by Card"></div>
</div>
<div class="wraps">
<div class="wrap">Gift wrap <input type="checkbox" aria-label="Gift wrap" checked></div>
<div class="wrap">No wrap <input type="checkbox" aria-label="No wrap"></div>
</div>
<div class="extras">
<div class="extra">Tip <input type="checkbox" checked></div>
<div class="extra">Bag <button type="button" role="switch" aria-checked="false" aria-label="bag"></button></div>
</div>
<div class="bins">
<div class="bin">Card <input type="radio" name="bin" aria-label="Discard" checked></div>
<div class="bin">Keep <input type="radio" name="bin" aria-label="Discard"></div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".way, .wrap, .extra, .bin"));`)).toEqual({
      result: [
        { label: "UPI", chosen: true, unavailable: false, by: "checked" },
        { label: "Card", chosen: false, unavailable: false, by: "checked" },
        { label: "Gift wrap", chosen: true, unavailable: false, by: "checked" },
        { label: "No wrap", chosen: false, unavailable: false, by: "checked" },
        { label: "Tip", chosen: true, unavailable: false, by: "checked" },
        { label: "Bag", chosen: false, unavailable: false, by: "aria-checked" },
        { label: "Card", chosen: null, unavailable: false, by: null },
        { label: "Keep", chosen: null, unavailable: false, by: null },
      ],
    });
  });

  test("takes no class sign from a slider's parts, whose active class marks the slide in view", async ({ page }) => {
    // Each library's slide in view carries its active class, around date chips or as the option,
    // and nothing is chosen, or only a generated class shows the choice.
    await page.setContent(`<div class="swiper"><div class="swiper-wrapper">
<div class="swiper-slide swiper-slide-active"><button type="button" class="date sc-a bXyz">Today</button></div>
<div class="swiper-slide swiper-slide-next"><button type="button" class="date sc-a cWvu">Tomorrow</button></div>
<div class="swiper-slide"><button type="button" class="date sc-a bXyz">Saturday</button></div>
</div></div>
<div class="slick-track">
<div class="slick-slide slick-current slick-active"><div><div class="pick">Nine</div></div></div>
<div class="slick-slide slick-active"><div><div class="pick">Ten</div></div></div>
<div class="slick-slide"><div><div class="pick">Eleven</div></div></div>
</div>
<div class="owl-stage">
<div class="owl-item active"><div class="cell"><a href="#m">Mon</a></div></div>
<div class="owl-item"><div class="cell"><a href="#t">Tue</a></div></div>
</div>
<div class="carousel-inner">
<div class="carousel-item active" tabindex="0">First</div>
<div class="carousel-item" tabindex="0">Second</div>
</div>
<div class="splide__list">
<div class="splide__slide is-active" tabindex="0">Third</div>
<div class="splide__slide" tabindex="0">Fourth</div>
</div>
<div class="glide__slides">
<div class="glide__slide glide__slide--active" tabindex="0">Fifth</div>
<div class="glide__slide" tabindex="0">Sixth</div>
</div>
<div class="slider-track">
<div class="slider-item active" tabindex="0">Seventh</div>
<div class="slider-item" tabindex="0">Eighth</div>
</div>${counting(".date, .pick, a, [tabindex]")}`);
    const options = [".date", ".pick", ".cell a", ".carousel-item", ".splide__slide", ".glide__slide", ".slider-item"].join(", ");
    expect(await call(page, `return await readChoices(page.locator(${JSON.stringify(options)}));`)).toEqual({
      result: ["Today", "Tomorrow", "Saturday", "Nine", "Ten", "Eleven", "Mon", "Tue", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"].map(
        (label) => ({ label, chosen: null, unavailable: false, by: null }),
      ),
    });
    for (const name of ["Today", "Tomorrow", "Nine", "Mon", "First", "Third", "Fifth", "Seventh"])
      expect(await choose(page, `page.getByText(${JSON.stringify(name)}, { exact: true })`)).toMatchObject({
        name: "ChooseFailure",
        reason: "state_unknown",
      });
    expect(await presses(page)).toBe(0);
  });

  test("still reads an option's own class inside a slider's slide, and a row marked expanded that holds more than the option", async ({
    page,
  }) => {
    // A chip chosen by its own class in a slide out of view; rows that take the remaining width by
    // a class saying expanded and hold only their button; accordion rows that say expanded and hold
    // their panel or their text; and a header that says expanded itself, its panel beside it.
    await page.setContent(`<div class="swiper-wrapper">
<div class="swiper-slide swiper-slide-active"><button type="button" class="chip">Today</button></div>
<div class="swiper-slide"><button type="button" class="chip chip--selected">Tomorrow</button></div>
</div>
<div class="fields">
<p class="control is-expanded"><button type="button" class="action">Standard</button></p>
<p class="control"><button type="button" class="action">Express</button></p>
</div>
<div class="rows">
<div class="row is-expanded"><button type="button" class="head">Cash</button><div class="body">Pay when it arrives</div></div>
<div class="row"><button type="button" class="head">UPI</button></div>
</div>
<div class="lines">
<div class="line is-expanded"><button type="button" class="fold">Wallet</button> Pay from your balance</div>
<div class="line"><button type="button" class="fold">Bank</button></div>
</div>
<div class="titles">
<div class="title expanded" tabindex="0"><span>Gift</span></div>
<div class="note">Wrapped for free</div>
<div class="title" tabindex="0"><span>Plain</span></div>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".chip, .action, .head, .fold, .title"));`)).toEqual({
      result: [
        { label: "Today", chosen: false, unavailable: false, by: "class" },
        { label: "Tomorrow", chosen: true, unavailable: false, by: "class" },
        { label: "Standard", chosen: null, unavailable: false, by: null },
        { label: "Express", chosen: null, unavailable: false, by: null },
        { label: "Cash", chosen: true, unavailable: false, by: "class" },
        { label: "UPI", chosen: false, unavailable: false, by: "class" },
        { label: "Wallet", chosen: true, unavailable: false, by: "class" },
        { label: "Bank", chosen: false, unavailable: false, by: "class" },
        { label: "Gift", chosen: true, unavailable: false, by: "class" },
        { label: "Plain", chosen: false, unavailable: false, by: "class" },
      ],
    });
  });

  test("never acts on a class that another like option's sign says is a highlight, or on a run from the first option", async ({
    page,
  }) => {
    // A list that highlights a row by one word and marks the choice by another, in either meaning
    // of the words; a row highlighted by a class beside the row marked aria-selected or with a data
    // attribute; a highlight on the chosen row and another; and rating stars filled up to the
    // choice. An option with no mark is still not the chosen one.
    await page.setContent(`<div class="menu">
<div class="option option--active" tabindex="0">Standard</div>
<div class="option option--selected" tabindex="0">Express</div>
<div class="option" tabindex="0">Pickup</div>
</div>
<div class="list">
<div class="item selected">Male</div>
<div class="item active">Female</div>
<div class="item">Other</div>
</div>
<div class="rows">
<div class="row is-active" tabindex="0">Cash</div>
<div class="row" tabindex="0" aria-selected="true">UPI</div>
<div class="row" tabindex="0">Card</div>
</div>
<div class="deals">
<div class="deal is-active" tabindex="0">Early</div>
<div class="deal" tabindex="0" data-selected="true">Late</div>
<div class="deal" tabindex="0">Never</div>
</div>
<div class="pills">
<div class="pill active selected" tabindex="0">Mine</div>
<div class="pill active" tabindex="0">Yours</div>
<div class="pill" tabindex="0">Theirs</div>
</div>
<div class="stars">
<span class="star active" tabindex="0">1</span>
<span class="star active" tabindex="0">2</span>
<span class="star active" tabindex="0">3</span>
<span class="star" tabindex="0">4</span>
</div>${counting(".option, .item, .row, .star")}`);
    expect(await call(page, `return await readChoices(page.locator(".option, .item, .row:not([aria-selected]), .deal:not([data-selected]), .pill, .star"));`)).toEqual({
      result: [
        { label: "Standard", chosen: null, unavailable: false, by: null },
        { label: "Express", chosen: null, unavailable: false, by: null },
        { label: "Pickup", chosen: false, unavailable: false, by: "class" },
        { label: "Male", chosen: null, unavailable: false, by: null },
        { label: "Female", chosen: null, unavailable: false, by: null },
        { label: "Other", chosen: false, unavailable: false, by: "class" },
        { label: "Cash", chosen: null, unavailable: false, by: null },
        { label: "Card", chosen: false, unavailable: false, by: "class" },
        { label: "Early", chosen: null, unavailable: false, by: null },
        { label: "Never", chosen: false, unavailable: false, by: "class" },
        { label: "Mine", chosen: true, unavailable: false, by: "class" },
        { label: "Yours", chosen: null, unavailable: false, by: null },
        { label: "Theirs", chosen: false, unavailable: false, by: "class" },
        { label: "1", chosen: null, unavailable: false, by: null },
        { label: "2", chosen: null, unavailable: false, by: null },
        { label: "3", chosen: null, unavailable: false, by: null },
        { label: "4", chosen: false, unavailable: false, by: "class" },
      ],
    });
    for (const option of [`page.getByText("Standard", { exact: true })`, `page.getByText("Cash", { exact: true })`, `page.getByText("1", { exact: true })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("still reads options chosen by one class unless they run unbroken over several from the first", async ({ page }) => {
    // Toggle chips, two of three on with the first off, three of four on with a gap, and the first
    // of two chosen alone.
    await page.setContent(`<div class="chips">
<button type="button" class="chip">Veg</button>
<button type="button" class="chip chip--active">Jain</button>
<button type="button" class="chip chip--active">Vegan</button>
</div>
<div class="toppings">
<button type="button" class="topping topping--active">Salt</button>
<button type="button" class="topping topping--active">Oil</button>
<button type="button" class="topping">Ghee</button>
<button type="button" class="topping topping--active">Nuts</button>
</div>
<div class="firsts">
<button type="button" class="first first--selected">One</button>
<button type="button" class="first">Two</button>
</div>`);
    expect(await call(page, `return await readChoices(page.locator(".chip, .topping, .first"));`)).toEqual({
      result: [
        { label: "Veg", chosen: false, unavailable: false, by: "class" },
        { label: "Jain", chosen: true, unavailable: false, by: "class" },
        { label: "Vegan", chosen: true, unavailable: false, by: "class" },
        { label: "Salt", chosen: true, unavailable: false, by: "class" },
        { label: "Oil", chosen: true, unavailable: false, by: "class" },
        { label: "Ghee", chosen: false, unavailable: false, by: "class" },
        { label: "Nuts", chosen: true, unavailable: false, by: "class" },
        { label: "One", chosen: true, unavailable: false, by: "class" },
        { label: "Two", chosen: false, unavailable: false, by: "class" },
      ],
    });
  });

  test("never reads an option role around another control a person presses when the option is one", async ({ page }) => {
    // A radio card holding terms as buttons, chosen list rows holding sizes as buttons, their words
    // alone or in an element inside each, and a button role holding buttons with classes of their
    // own; parts of a radio named together are the locator's other matches, and one part named alone
    // still reads its radio.
    await page.setContent(`<div role="radiogroup" aria-label="Plan">
<div role="radio" aria-checked="true" class="plan" tabindex="0">Gold <button type="button" class="term">Monthly</button> <button type="button" class="term term--on">Yearly</button></div>
</div>
<div role="listbox" aria-label="Food"><div role="option" aria-selected="true">Pizza <button type="button" class="size">Small</button> <button type="button" class="size">Large</button></div>
<div role="option" aria-selected="true">Soup <button type="button" class="bowl"><i>Cup</i></button> <button type="button" class="bowl"><i>Bowl</i></button></div></div>
<div role="button" aria-pressed="true" tabindex="0" class="wrap"><button type="button" class="alpha">Alpha</button> <button type="button" class="beta">Beta</button></div>
<div role="radiogroup" aria-label="Way">
<div role="radio" aria-checked="true" tabindex="0"><span class="way-name">UPI</span> <span class="way-note">Any app</span></div>
</div>${counting("button")}`);
    expect(await call(page, `return await readChoices(page.locator(".term, .size, .alpha, .beta"));`)).toEqual({
      result: ["Monthly", "Yearly", "Small", "Large", "Alpha", "Beta"].map((label) => ({
        label,
        chosen: null,
        unavailable: false,
        by: null,
      })),
    });
    for (const option of [`page.getByRole("button", { name: "Monthly" })`, `page.getByRole("button", { name: "Small" })`, `page.locator(".alpha")`, `page.getByText("Cup", { exact: true })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
    expect(await call(page, `return await readChoices(page.locator(".way-name, .way-note"));`)).toEqual({
      result: ["UPI", "Any app"].map((label) => ({ label, chosen: null, unavailable: false, by: null })),
    });
    expect(await call(page, `return await readChoices(page.locator(".way-note"));`)).toEqual({
      result: [{ label: "Any app", chosen: true, unavailable: false, by: "aria-checked" }],
    });
  });

  test("never comes from a panel beyond a lone option's own parent, or from one with a title of its own", async ({
    page,
  }) => {
    // A saved card, the one plain option in an open row's body beside the row's header button or
    // above its Add button; steps and days whose active one holds a heading above its one button;
    // and links that alone fill the item marked active, or follow an icon hidden from assistive
    // technology, which do read it.
    await page.setContent(`<div class="acc">
<div class="acc-item active"><button type="button" class="acc-head">Cards</button><div class="acc-body"><div class="opt">Visa</div></div></div>
<div class="acc-item"><button type="button" class="acc-head">UPI</button><div class="acc-body" hidden><div class="opt">Any app</div></div></div>
</div>
<div class="saved">
<div class="panel active"><div class="body"><div class="kept">Rupay</div></div><button type="button">Add</button></div>
<div class="panel"><div class="body"><div class="kept">Amex</div></div><button type="button">Add</button></div>
</div>
<div class="steps">
<div class="step step--active"><h3>Delivery</h3><button type="button" class="ship">Standard</button></div>
<div class="step"><h3>Payment</h3><button type="button" class="ship">Pay now</button></div>
</div>
<div class="days">
<div class="day is-active"><span class="date">Mon</span><button type="button" class="time">Nine</button></div>
<div class="day"><span class="date">Tue</span><button type="button" class="time">Ten</button></div>
</div>
<div class="nav">
<div class="item active"><a href="#a">Home</a></div>
<div class="item"><a href="#b">Shop</a></div>
</div>
<div class="tabs">
<div class="tab active"><i aria-hidden="true">sell</i><a href="#c">Sell</a></div>
<div class="tab"><i aria-hidden="true">shop</i><a href="#d">Buy</a></div>
</div>${counting(".opt, button, a")}`);
    expect(await call(page, `return await readChoices(page.locator(".acc-item.active .opt, .kept, .ship, .time, .nav a, .tabs a"));`)).toEqual({
      result: [
        { label: "Visa", chosen: null, unavailable: false, by: null },
        { label: "Rupay", chosen: null, unavailable: false, by: null },
        { label: "Amex", chosen: null, unavailable: false, by: null },
        { label: "Standard", chosen: null, unavailable: false, by: null },
        { label: "Pay now", chosen: null, unavailable: false, by: null },
        { label: "Nine", chosen: null, unavailable: false, by: null },
        { label: "Ten", chosen: null, unavailable: false, by: null },
        { label: "Home", chosen: true, unavailable: false, by: "class" },
        { label: "Shop", chosen: false, unavailable: false, by: "class" },
        { label: "Sell", chosen: true, unavailable: false, by: "class" },
        { label: "Buy", chosen: false, unavailable: false, by: "class" },
      ],
    });
    for (const option of [`page.getByText("Visa", { exact: true })`, `page.getByText("Rupay", { exact: true })`, `page.getByRole("button", { name: "Standard" })`, `page.getByRole("button", { name: "Nine" })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
  });

  test("never reads an open or closed data-state as a sign on what a person presses with no aria-expanded", async ({
    page,
  }) => {
    // Tiles that are tooltips' triggers and show the choice by utility classes alone, and a link
    // that a hover card holds open under the pointer. A chosen tile is never pressed, as pressing
    // it would toggle it off. A plain header's data-state still reads.
    await page.setContent(`<div class="grid">
<button type="button" data-state="closed" class="rounded border ring-2">Small</button>
<button type="button" data-state="closed" class="rounded border">Large</button>
</div>
<div class="cards"><a href="#p" data-state="open" class="card">Profile</a><a href="#q" data-state="closed" class="card">Queue</a></div>
<div class="heads"><h3 data-state="open" class="head">Open row</h3><h3 data-state="closed" class="head">Closed row</h3></div>
${counting(".grid button, .card, .head")}
<script>
for (const tile of document.querySelectorAll(".grid button")) tile.addEventListener("click", () => tile.classList.toggle("ring-2"));
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".grid button, .card, .head"));`)).toEqual({
      result: [
        { label: "Small", chosen: null, unavailable: false, by: null },
        { label: "Large", chosen: null, unavailable: false, by: null },
        { label: "Profile", chosen: null, unavailable: false, by: null },
        { label: "Queue", chosen: null, unavailable: false, by: null },
        { label: "Open row", chosen: true, unavailable: false, by: "data-state" },
        { label: "Closed row", chosen: false, unavailable: false, by: "data-state" },
      ],
    });
    for (const option of [`page.getByRole("button", { name: "Small" })`, `page.getByRole("link", { name: "Profile" })`])
      expect(await choose(page, option)).toMatchObject({ name: "ChooseFailure", reason: "state_unknown" });
    expect(await presses(page)).toBe(0);
    await expect(page.locator(".ring-2")).toHaveCount(1);
  });

  test("reads a disclosure's aria-expanded as a choice only when no class says which option is chosen", async ({ page }) => {
    // Tiles chosen by a class that each hold a closed disclosure of their own; a class on one tile
    // beside an open disclosure on another, as a chosen tile beside an unchosen one's open details
    // shows it and an accordion's highlighted row beside its open row does too, which no sign tells
    // apart, and the row beside them, which is neither; tiles chosen by a data attribute; a row open
    // and marked by a class; and an accordion that shows nothing else.
    await page.setContent(`<div class="ships">
<button type="button" class="ship ship--selected" aria-expanded="false">Standard</button>
<button type="button" class="ship" aria-expanded="false">Express</button>
</div>
<div class="gifts">
<button type="button" class="gift gift--selected" aria-expanded="false">Wrap</button>
<button type="button" class="gift" aria-expanded="true">Box</button>
</div>
<div class="methods">
<button type="button" class="method method--active" aria-expanded="false">Cash</button>
<button type="button" class="method" aria-expanded="true">UPI</button>
<button type="button" class="method" aria-expanded="false">Card</button>
</div>
<div class="deals">
<button type="button" class="deal" aria-expanded="false" data-selected="true">Early</button>
<button type="button" class="deal" aria-expanded="false" data-selected="false">Late</button>
</div>
<div class="lines">
<button type="button" class="line line--active" aria-expanded="true">Open</button>
<button type="button" class="line" aria-expanded="false">Shut</button>
</div>
<div class="tails">
<button type="button" class="tail" aria-expanded="true">Tail</button>
<button type="button" class="tail" aria-expanded="false">Rest</button>
</div>${counting(".ship")}
<script>
const ships = document.querySelectorAll(".ship");
for (const ship of ships)
  ship.addEventListener("click", () => {
    for (const other of ships) other.classList.remove("ship--selected");
    ship.classList.add("ship--selected");
  });
</script>`);
    expect(await call(page, `return await readChoices(page.locator(".ship, .gift, .method, .deal, .line, .tail"));`)).toEqual({
      result: [
        { label: "Standard", chosen: true, unavailable: false, by: "class" },
        { label: "Express", chosen: false, unavailable: false, by: "class" },
        { label: "Wrap", chosen: null, unavailable: false, by: null },
        { label: "Box", chosen: null, unavailable: false, by: null },
        { label: "Cash", chosen: null, unavailable: false, by: null },
        { label: "UPI", chosen: null, unavailable: false, by: null },
        { label: "Card", chosen: false, unavailable: false, by: "class" },
        { label: "Early", chosen: true, unavailable: false, by: "data-selected" },
        { label: "Late", chosen: false, unavailable: false, by: "data-selected" },
        { label: "Open", chosen: true, unavailable: false, by: "aria-expanded" },
        { label: "Shut", chosen: false, unavailable: false, by: "class" },
        { label: "Tail", chosen: true, unavailable: false, by: "aria-expanded" },
        { label: "Rest", chosen: false, unavailable: false, by: "aria-expanded" },
      ],
    });
    expect(await choose(page, `page.getByRole("button", { name: "Standard" })`)).toEqual({
      chosen: true,
      pressed: false,
      label: "Standard",
      by: "class",
    });
    expect(await presses(page)).toBe(0);
    expect(await choose(page, `page.getByRole("button", { name: "Express" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Express",
      by: "class",
    });
    expect(await presses(page)).toBe(1);
  });
});

test.describe("ways to pay in a frame from another origin", () => {
  const shop = "https://shop.example.test";
  const payments = "https://pay.example.test";

  /** A checkout whose ways to pay are an accordion in a payment frame from another origin. */
  const checkout = async (page: Page, frameBody: string) => {
    await page.context().route(`${shop}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<h1>Checkout</h1><iframe title="Payments" src="${payments}/ways" style="width: 480px; height: 320px"></iframe>
<button type="button">Pay Now</button>`,
      }),
    );
    await page.context().route(`${payments}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: frameBody }),
    );
    await page.goto(`${shop}/checkout`);
    const frame = page.frames().find((candidate) => candidate.url().startsWith(payments));
    if (frame === undefined) throw new Error("Fixture frame missing");
    await frame.locator(".method").first().waitFor();
    return frame;
  };

  test("opens the cash row in the frame with one press and reads every way's state", async ({ page }) => {
    const frame = await checkout(page, accordion("UPI"));
    const ways = `page.frameLocator('iframe[title="Payments"]')`;
    expect(await choose(page, `${ways}.getByRole("button", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-expanded",
    });
    expect(await presses(page, frame)).toBe(1);
    const read = await call(page, `return await readChoices(${ways}.locator(".method"));`);
    expect(read).toEqual({
      result: [
        { label: "Cash", chosen: true, unavailable: false, by: "aria-expanded" },
        { label: "UPI", chosen: false, unavailable: false, by: "aria-expanded" },
      ],
    });
  });

  test("waits out a layer the checkout draws over the frame, then presses the row once", async ({ page }) => {
    // The layer lets presses through to the frame. While it shows, the checkout tells the frame
    // so, and the frame drops each press made under it.
    const frame = await checkout(
      page,
      `${accordion("UPI")}
<script>
addEventListener("message", (event) => {
  if (event.data === "updating") document.body.insertAdjacentHTML("beforeend", '<i id="updating" hidden></i>');
  if (event.data === "updated") document.getElementById("updating")?.remove();
});
</script>
${dropping("#updating")}`,
    );
    await page.evaluate(() => {
      const layer = document.createElement("div");
      layer.id = "updating";
      layer.style.cssText = "position: fixed; inset: 0; background: rgba(255, 255, 255, 0.6); pointer-events: none";
      document.body.append(layer);
      const payments = document.querySelector("iframe")?.contentWindow;
      payments?.postMessage("updating", "*");
      setTimeout(() => {
        layer.remove();
        payments?.postMessage("updated", "*");
      }, 700);
    });
    expect(
      await choose(
        page,
        `page.frameLocator('iframe[title="Payments"]').getByRole("button", { name: "Cash" })`,
        `{ overlays: page.locator("#updating") }`,
      ),
    ).toEqual({ chosen: true, pressed: true, label: "Cash", by: "aria-expanded" });
    expect(await presses(page, frame)).toBe(1);
    expect(await dropped(page, frame)).toBe(0);
  });

  test("answers a greyed-out cash row in the frame as unavailable, untouched", async ({ page }) => {
    const frame = await checkout(
      page,
      `<div class="methods">
<h3><button type="button" class="method" aria-expanded="false" disabled>Cash <span>Not available at the moment</span></button></h3>
<h3><button type="button" class="method" aria-expanded="true">UPI</button></h3>
</div>${counting(".method")}`,
    );
    expect(
      await choose(page, `page.frameLocator('iframe[title="Payments"]').getByRole("button", { name: /Cash/ })`),
    ).toEqual({ chosen: false, reason: "unavailable", label: "Cash Not available at the moment" });
    expect(await presses(page, frame)).toBe(0);
  });
});
