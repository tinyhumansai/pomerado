import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import qrcode from "qrcode-generator";
import { qrCodeCode } from "../../src/browser/qr-code.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `readQrCode`, run as a Kernel call body runs it (`page` in scope) on synthetic checkouts that show
// a payment QR code the ways pages draw one: an image, a canvas at a fraction of a pixel per
// module, a scaled SVG, light on dark, inside a payment frame from another origin, beside a
// countdown the read must leave running, and under one CSS pixel a module on a screen with two
// device pixels per CSS pixel.
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

test("leaves the page's animations running, such as a countdown beside the code", async ({ page }) => {
  await page.setContent(`<style>
@keyframes countdown { from { width: 300px; } to { width: 0; } }
#left { height: 4px; background: #111; animation: countdown 300s linear forwards; }
</style>
<main>
<h1>Scan to pay ₹74</h1>
<p id="timer">Approve payment within 05m:00s</p>
<div id="left"></div>
<div class="qr-box"><img id="qr" alt="Payment QR" src="${code.createDataURL(4, 4)}"></div>
</main>
<script>
document.getElementById("left").addEventListener("animationend", () => {
  document.getElementById("timer").textContent = "Payment expired";
});
</script>`);
  const answer = await call(
    page,
    `const text = await readQrCode(page.locator("#qr"));
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    return {
      text,
      animations: await page.evaluate(() => document.getAnimations().map((animation) => animation.playState)),
      timer: await page.locator("#timer").innerText(),
    };`,
  );
  expect(answer).toEqual({
    result: { text: payment, animations: ["running"], timer: "Approve payment within 05m:00s" },
  });
});

test.describe("on a screen with two device pixels per CSS pixel", () => {
  test.use({ deviceScaleFactor: 2 });

  test("reads the code at the screen's own resolution", async ({ page }) => {
    await page.setContent(checkout(canvas(2)));
    expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
  });
});

// An SVG the page draws at 0.8 CSS pixels a module: 2.4 device pixels a module in a picture at the
// screen's own resolution, and 0.8, which no decoder resolves, in one at CSS pixels. Under two
// device pixels per CSS pixel it would be under the two pixels a module `decodeQr` needs either way.
test.describe("on a screen with three device pixels per CSS pixel", () => {
  test.use({ deviceScaleFactor: 3 });

  test("reads a code drawn under one CSS pixel a module", async ({ page }) => {
    const svg = code.createSvgTag({ cellSize: 2, margin: 4, scalable: true });
    await page.setContent(checkout(`<div id="qr" style="width: ${(count + 4) * 0.8}px">${svg}</div>`));
    expect(await read(page, `page.locator("#qr")`)).toEqual({ text: payment });
  });
});
