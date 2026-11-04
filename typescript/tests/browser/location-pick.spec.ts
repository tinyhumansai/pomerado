import { expect, test } from "@playwright/test";
import { call, serve } from "./picker-fixture.js";

// Setting a delivery place as a person does, on a synthetic shop: open its location sheet, type
// the area into its search, which answers after a pause and always lists rows that would locate
// the device first, pick the matching place, and read it back where the page shows it. The page
// counts any use of its locate rows in `#located`, in the DOM.
const shop = `<header><button id="location" type="button">Deliver to <strong id="where">Select location</strong></button></header>
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
    places.innerHTML = '<li role="option" class="detect">Use my current location</li>' +
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

test("refuses a place the site does not list, never pressing a row that locates the device", async ({ page }) => {
  await serve(page, shop, (params) => ({
    body: places.filter((name) => name.toLowerCase().includes((params.get("q") ?? "").toLowerCase())),
  }));
  expect(
    await call(
      page,
      `await page.locator("#location").click({ timeout: 5000 });
return await pickValue(page.getByPlaceholder("Search for area, street name"), "Hill Top", { committed: page.locator("#where") });`,
    ),
  ).toMatchObject({ result: { picked: false, reason: "option_missing" } });
  await expect(page.locator("#where")).toHaveText("Select location");
  await expect(page.locator("#located")).toHaveText("0");
});
