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
// choice only by a class, a greyed-out row, a list of ways to pay in a frame from another origin,
// and options inside a shadow root. Each page counts the presses it gets in `#presses`, in the
// DOM, so an isolated world reads it too.
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

  test("waits for a loader covering the option to clear, then presses it once", async ({ page }) => {
    await page.setContent(`${radios}
<div id="loader" style="position: fixed; inset: 0; background: rgba(255, 255, 255, 0.8)">Updating</div>
<script>setTimeout(() => document.getElementById("loader").remove(), 700);</script>`);
    expect(await choose(page, `page.locator("label", { hasText: "Morning" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Morning",
      by: "checked",
    });
    expect(await presses(page)).toBe(1);
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
    const frame = await checkout(page, accordion("UPI"));
    await page.evaluate(() => {
      const layer = document.createElement("div");
      layer.id = "updating";
      layer.style.cssText = "position: fixed; inset: 0; background: rgba(255, 255, 255, 0.6)";
      layer.addEventListener("pointerdown", () => layer.setAttribute("data-pressed", "yes"));
      document.body.append(layer);
      setTimeout(() => layer.remove(), 700);
    });
    expect(await choose(page, `page.frameLocator('iframe[title="Payments"]').getByRole("button", { name: "Cash" })`)).toEqual({
      chosen: true,
      pressed: true,
      label: "Cash",
      by: "aria-expanded",
    });
    expect(await presses(page, frame)).toBe(1);
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
