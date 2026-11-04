import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import qrcode from "qrcode-generator";
import { qrCodeCode } from "../../src/browser/qr-code.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `readQrCode`, run as a Kernel call body runs it (`page` in scope) on synthetic checkouts that show
// a payment QR code the ways pages draw one: an image, a canvas at a fraction of a pixel per
// module, a scaled SVG, light on dark, and inside a payment frame from another origin.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 20,
    code: `${qrCodeCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

/** Reads the code `locator` (code) shows, or returns its failure's name and reason. */
const read = async (page: Page, locator: string) => {
  const answer = await call(
    page,
    `try {
      return { text: await readQrCode(${locator}) };
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { name: error.name, reason: error.reason };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result;
};

qrcode.stringToBytes = (text: string) => [...new TextEncoder().encode(text)];

const payment = "upi://pay?pa=grocer@examplebank&pn=Corner%20Grocer&am=74.00&cu=INR&tn=Order%207";
const code = qrcode(0, "M");
code.addData(payment);
code.make();
const count = code.getModuleCount();
const modules = Array.from({ length: count }, (_, row) =>
  Array.from({ length: count }, (_, column) => (code.isDark(row, column) ? 1 : 0)),
);

/** A canvas drawing the code at `cell` pixels a module, which may be a fraction. */
const canvas = (cell: number) => `<canvas id="qr" width="${Math.ceil((count + 8) * cell)}" height="${Math.ceil((count + 8) * cell)}"></canvas>
<script>
const modules = ${JSON.stringify(modules)};
const context = document.getElementById("qr").getContext("2d");
context.fillStyle = "#fff";
context.fillRect(0, 0, context.canvas.width, context.canvas.height);
context.fillStyle = "#111";
modules.forEach((row, y) => row.forEach((dark, x) => {
  if (dark) context.fillRect((x + 4) * ${cell}, (y + 4) * ${cell}, ${cell}, ${cell});
}));
</script>`;

const checkout = (qr: string) => `<main>
<h1>Scan to pay ₹74</h1>
<p>Approve payment within 04m:58s</p>
<div class="qr-box">${qr}</div>
<p id="note">Deliver to: 12 Lake Road</p>
</main>`;

test("reads the code an image shows", async ({ page }) => {
  await page.setContent(checkout(`<img id="qr" alt="Payment QR" src="${code.createDataURL(4, 4)}">`));
  expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
});

test("reads a code drawn on a canvas at a fraction of a pixel per module", async ({ page }) => {
  await page.setContent(checkout(canvas(2.7)));
  expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
});

test("reads a code drawn as an SVG and scaled by the page", async ({ page }) => {
  await page.setContent(
    checkout(`<div id="qr" style="width: 230px">${code.createSvgTag({ cellSize: 2, margin: 4, scalable: true })}</div>`),
  );
  expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
});

test("reads a code drawn light on dark", async ({ page }) => {
  await page.setContent(
    checkout(`<img id="qr" alt="Payment QR" style="filter: invert(1)" src="${code.createDataURL(4, 4)}">`),
  );
  expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
});

test("reads a code inside a payment frame from another origin", async ({ page }) => {
  const shop = "https://shop.example.test";
  const gateway = "https://pay.example.test";
  await page.context().route(`${shop}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: checkout(`<iframe title="Payment" src="${gateway}/qr" style="width: 320px; height: 320px; border: 0"></iframe>`),
    }),
  );
  await page.context().route(`${gateway}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<img id="qr" alt="Scan" src="${code.createDataURL(4, 2)}">` }),
  );
  await page.goto(`${shop}/pay`);
  await page.frameLocator('iframe[title="Payment"]').locator("#qr").waitFor();
  expect(await read(page, `page.frameLocator('iframe[title="Payment"]').locator("#qr")`)).toEqual({ text: payment });
});

test("fails as no_code for an element that shows no code, and names no page text", async ({ page }) => {
  await page.setContent(checkout(`<img id="qr" alt="Payment QR" src="${code.createDataURL(4, 4)}">`));
  expect(await read(page, `page.locator("#note")`)).toEqual({ name: "QrCodeFailure", reason: "no_code" });
});

test("fails for a missing, hidden or ambiguous element before taking any picture", async ({ page }) => {
  await page.setContent(
    checkout(`<img class="qr" alt="Payment QR" src="${code.createDataURL(4, 4)}">
<img class="qr" alt="Payment QR" src="${code.createDataURL(4, 4)}">
<img id="old" alt="Expired QR" hidden src="${code.createDataURL(4, 4)}">`),
  );
  expect(await read(page, `page.locator("#absent")`)).toEqual({ name: "QrCodeFailure", reason: "not_found" });
  expect(await read(page, `page.locator("#old")`)).toEqual({ name: "QrCodeFailure", reason: "hidden_only" });
  expect(await read(page, `page.locator(".qr")`)).toEqual({ name: "QrCodeFailure", reason: "ambiguous" });
});

test.describe("on a screen with two device pixels per CSS pixel", () => {
  test.use({ deviceScaleFactor: 2 });

  test("reads the code at the screen's own resolution", async ({ page }) => {
    await page.setContent(checkout(canvas(2)));
    expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
  });
});
