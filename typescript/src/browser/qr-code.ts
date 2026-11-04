import { decodeQr } from "../runtime/qr-decode.js";

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then read a QR code a page shows with `readQrCode(locator, { timeout }?)`. It returns
 * the text the code holds, such as a `upi://pay` link, so a tool returns the payment's data, never
 * a picture of the page.
 *
 * It takes a picture of the locator's one visible match alone, at the screen's own resolution with
 * animations stopped, turns it into luminance in the page, and decodes it with `decodeQr`
 * (../runtime/qr-decode.ts). The element can be an image, a canvas, an SVG or any box that draws
 * the code, in a frame from another origin too, upright or turned, dark on light or light on
 * dark. Name the element that holds the code alone, never a page section: the picture holds only
 * that element, so it never carries what is beside it, such as an address. Anything drawn over the
 * code is in the picture, so close an overlay first. It reads the page as it is now and never
 * waits: wait for the code to show first, for example with `waitForOutcome`, and press a control
 * that reveals the code as a person does, with a real click.
 *
 * It throws an `Error` named `QrCodeFailure` with a `reason`, and a message with counts, never
 * page text: `not_found` (nothing matches), `hidden_only` (no match is visible), `ambiguous`
 * (several visible matches), and `no_code` (the picture shows no code it can read and correct).
 */
export const qrCodeCode = String.raw`
const qrCodeFailure = (reason, message, details = {}) =>
  Object.assign(new Error(reason + ": " + message), { name: "QrCodeFailure", reason, ...details });
const decodeQr = ${String(decodeQr)};
// Runs in the page: the PNG's luminance, transparency as white, back as base64.
const qrCodePixelsInPage = async (png) => {
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const luminance = new Uint8Array(bitmap.width * bitmap.height);
  for (let index = 0; index < luminance.length; index += 1)
    luminance[index] = Math.round(0.299 * data[index * 4] + 0.587 * data[index * 4 + 1] + 0.114 * data[index * 4 + 2]);
  let text = "";
  for (let index = 0; index < luminance.length; index += 0x8000)
    text += String.fromCharCode(...luminance.subarray(index, index + 0x8000));
  return { width: bitmap.width, height: bitmap.height, pixels: btoa(text) };
};
const readQrCode = async (locator, options = {}) => {
  if (locator === null || typeof locator !== "object" || typeof locator.screenshot !== "function")
    throw new TypeError("readQrCode needs the code's Playwright locator");
  const timeout = options.timeout ?? 5000;
  const matched = await locator.count();
  const shown = locator.filter({ visible: true });
  const visible = await shown.count();
  const counts = { matched, visible };
  if (matched === 0) throw qrCodeFailure("not_found", "0 matched", counts);
  if (visible === 0) throw qrCodeFailure("hidden_only", matched + " matched, 0 visible", counts);
  if (visible > 1) throw qrCodeFailure("ambiguous", matched + " matched, " + visible + " visible", counts);
  const picture = await shown.screenshot({ timeout, animations: "disabled", caret: "hide", scale: "device" });
  const image = await page.evaluate(qrCodePixelsInPage, picture.toString("base64"));
  const binary = atob(image.pixels);
  const pixels = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) pixels[index] = binary.charCodeAt(index);
  const text = decodeQr(pixels, image.width, image.height);
  if (text === null)
    throw qrCodeFailure("no_code", "no code read in a " + image.width + "x" + image.height + " picture",
      { width: image.width, height: image.height });
  return text;
};
`;
