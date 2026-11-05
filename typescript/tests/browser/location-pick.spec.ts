import { expect, test } from "@playwright/test";
import { call, serve } from "./picker-fixture.js";

// Setting a delivery place as a person does, on a synthetic shop: open its location sheet, type
// the area into its search, which answers after a pause and always lists rows that would locate
// the device first (`locating`), pick the matching place, and read it back where the page shows
// it. The page counts any use of its locate rows in `#located`, in the DOM.
const sheet = (locating: readonly string[]) => `<header><button id="location" type="button">Deliver to <strong id="where">Select location</strong></button></header>
<div id="sheet" role="dialog" aria-label="Choose location" hidden>
  <input id="area" placeholder="Search for area, street name" autocomplete="off" role="combobox" aria-controls="places">
  <ul id="places" role="listbox"></ul>
</div>
<output id="located">0</output>
<script>
const sheet = document.getElementById("sheet"), area = document.getElementById("area"), places = document.getElementById("places");
document.getElementById("location").addEventListener("click", () => { sheet.hidden = false; area.focus(); });
let timer;
area.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const found = await (await fetch("/api/places?q=" + encodeURIComponent(area.value))).json();
    places.innerHTML = ${JSON.stringify(locating)}.map((name) => '<li role="option" class="detect">' + name + "</li>").join("") +
      found.map((name) => '<li role="option">' + name + "</li>").join("");
  }, 250);
});
places.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  if (option.classList.contains("detect")) {
    document.getElementById("located").textContent = "1";
    return;
  }
  document.getElementById("where").textContent = option.textContent;
  sheet.hidden = true;
});
</script>`;
const shop = sheet(["Use my current location"]);

const places = ["Lake Road, Sector 4", "Lakeview Colony, Sector 9", "Lake Gardens"];

test("sets the place by typing the area and picking its suggestion, read back in the header", async ({ page }) => {
  await serve(page, shop, (params) => ({
    body: places.filter((name) => name.toLowerCase().includes((params.get("q") ?? "").toLowerCase())),
    delayMs: 150,
  }));
  expect(
    await call(
      page,
      `await page.locator("#location").click({ timeout: 5000 });
return await pickValue(page.getByPlaceholder("Search for area, street name"), "Lake Road, Sector 4", {
  committed: page.locator("#where"),
});`,
    ),
  ).toMatchObject({ result: { picked: true, label: "Lake Road, Sector 4" } });
  await expect(page.locator("#where")).toHaveText("Lake Road, Sector 4");
  await expect(page.locator("#located")).toHaveText("0");
});

test("refuses a value only the row that locates the device would match, never pressing that row", async ({ page }) => {
  await serve(page, shop, (params) => ({
    body: places.filter((name) => name.toLowerCase().includes((params.get("q") ?? "").toLowerCase())),
  }));
  // The site lists no place for "Current location": only its "Use my current location" row holds
  // those words.
  expect(
    await call(
      page,
      `await page.locator("#location").click({ timeout: 5000 });
return await pickValue(page.getByPlaceholder("Search for area, street name"), "Current location", { committed: page.locator("#where") });`,
    ),
  ).toMatchObject({ result: { picked: false, reason: "option_missing" } });
  await expect(page.locator("#where")).toHaveText("Select location");
  await expect(page.locator("#located")).toHaveText("0");
});

test("refuses a value only rows that would turn on the device's location name, never pressing them", async ({
  page,
}) => {
  await serve(page, sheet(["My location", "Enable location", "Use GPS"]), (params) => ({
    body: places.filter((name) => name.toLowerCase().includes((params.get("q") ?? "").toLowerCase())),
  }));
  expect(
    await call(
      page,
      `await page.locator("#location").click({ timeout: 5000 });
return await pickValue(page.getByPlaceholder("Search for area, street name"), "My location", { committed: page.locator("#where") });`,
    ),
  ).toMatchObject({ result: { picked: false, reason: "option_missing" } });
  await expect(page.locator("#where")).toHaveText("Select location");
  await expect(page.locator("#located")).toHaveText("0");
});
