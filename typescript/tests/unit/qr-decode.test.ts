// Failure modes covered: a QR code read with the wrong block layout or error correction table for
// its version and level, so some versions never read; a payload in numeric, alphanumeric or byte
// segments, or UTF-8, read as other text; modules a screen capture got wrong left uncorrected;
// a code drawn light on dark, turned, scaled to a fraction of a pixel per module or smoothed at
// its edges, or captured with no quiet zone around it, not found; and a picture that holds no
// code, or one too damaged to correct, read as text instead of none.
import qrcode from "qrcode-generator";
import { describe, expect, it } from "vitest";
import { decodeQr } from "../../src/runtime/qr-decode.js";

type Level = "L" | "M" | "Q" | "H";
type Mode = "Numeric" | "Alphanumeric" | "Byte";

// Byte segments as UTF-8, as payment apps write them.
qrcode.stringToBytes = (text: string) => [...new TextEncoder().encode(text)];

interface Image {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A code for `segments` at `version` (0 for the smallest that fits) and `level`. */
const make = (segments: readonly (readonly [string, Mode])[], level: Level = "M", version = 0) => {
  const code = qrcode(version as Parameters<typeof qrcode>[0], level);
  for (const [text, mode] of segments) code.addData(text, mode);
  code.make();
  return code;
};

/** Draws `code` as luminance, `cell` pixels per module (a fraction too), `margin` modules around. */
const draw = (
  code: ReturnType<typeof make>,
  { cell = 4, margin = 4, invert = false, flip = [] as readonly (readonly [number, number])[] } = {},
): Image => {
  const count = code.getModuleCount();
  const flipped = new Set(flip.map(([row, col]) => row * count + col));
  const size = Math.round((count + margin * 2) * cell);
  const pixels = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const row = Math.floor(y / cell) - margin;
      const col = Math.floor(x / cell) - margin;
      const inside = row >= 0 && col >= 0 && row < count && col < count;
      const dark = inside && code.isDark(row, col) !== flipped.has(row * count + col);
      pixels[y * size + x] = dark !== invert ? 20 : 235;
    }
  return { pixels, width: size, height: size };
};

/** Shrinks an image by `factor`, averaging each block, as a smoothed screen capture does. */
const shrink = ({ pixels, width, height }: Image, factor: number): Image => {
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const out = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y += 1)
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1)
        for (let dx = 0; dx < factor; dx += 1) sum += pixels[(y * factor + dy) * width + x * factor + dx] ?? 0;
      out[y * outWidth + x] = Math.round(sum / (factor * factor));
    }
  return { pixels: out, width: outWidth, height: outHeight };
};

/** Turns an image a quarter turn clockwise `turns` times. */
const turn = (image: Image, turns: number): Image => {
  let { pixels, width, height } = image;
  for (let step = 0; step < turns; step += 1) {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) out[x * height + (height - 1 - y)] = pixels[y * width + x] ?? 0;
    pixels = out;
    [width, height] = [height, width];
  }
  return { pixels, width, height };
};

const read = ({ pixels, width, height }: Image) => decodeQr(pixels, width, height);

const payment = "upi://pay?pa=grocer@examplebank&pn=Corner%20Grocer&am=74.00&cu=INR&tn=Order 7 ₹74";

describe("decodeQr", () => {
  for (const level of ["L", "M", "Q", "H"] as const)
    it(`reads every version from 1 to 40 at level ${level}`, () => {
      for (let version = 1; version <= 40; version += 1) {
        const text = `v${version}${level}`;
        expect(read(draw(make([[text, "Byte"]], level, version), { cell: 3 })), `version ${version}`).toBe(text);
      }
    });

  // Three alignment patterns at a right angle once outranked the finders, so these codes read at
  // one scale and not at another.
  it("never takes three alignment patterns for the code's finders, at any scale", () => {
    for (const version of [14, 21, 28, 35])
      for (const cell of [3, 5]) {
        const text = `v${version}Q`;
        expect(read(draw(make([[text, "Byte"]], "Q", version), { cell })), `version ${version} at ${cell}`).toBe(text);
      }
  });

  it("reads a payment link in UTF-8, and numeric, alphanumeric and byte segments together", () => {
    expect(read(draw(make([[payment, "Byte"]], "M")))).toBe(payment);
    expect(read(draw(make([["ORDER ", "Alphanumeric"], ["0042", "Numeric"], [" café", "Byte"]], "Q")))).toBe(
      "ORDER 0042 café",
    );
    expect(read(draw(make([["31415926535897932384626433", "Numeric"]], "L")))).toBe("31415926535897932384626433");
  });

  it("corrects modules a capture got wrong, within what the level can correct", () => {
    const code = make([[payment, "Byte"]], "H");
    const count = code.getModuleCount();
    const flip: [number, number][] = [];
    for (let at = 0; at < 12; at += 1) flip.push([9 + ((at * 7) % (count - 18)), 9 + ((at * 11) % (count - 18))]);
    expect(read(draw(code, { flip }))).toBe(payment);
  });

  it("finds a code drawn light on dark, turned, without a quiet zone, or at a fraction of a pixel", () => {
    const code = make([[payment, "Byte"]], "M");
    expect(read(draw(code, { invert: true }))).toBe(payment);
    expect(read(turn(draw(code), 1))).toBe(payment);
    expect(read(turn(draw(code), 2))).toBe(payment);
    expect(read(draw(code, { margin: 0 }))).toBe(payment);
    expect(read(draw(code, { cell: 2.6 }))).toBe(payment);
    expect(read(shrink(draw(code, { cell: 8 }), 3))).toBe(payment);
  });

  it("answers null for a picture with no code, or a code too damaged to correct", () => {
    const blank = new Uint8Array(200 * 200).fill(240);
    expect(decodeQr(blank, 200, 200)).toBeNull();
    let seed = 7;
    const noise = blank.map(() => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 2 === 0 ? 20 : 235;
    });
    expect(decodeQr(noise, 200, 200)).toBeNull();
    const code = make([[payment, "Byte"]], "L");
    const count = code.getModuleCount();
    const flip: [number, number][] = [];
    for (let row = 9; row < count - 9; row += 1)
      for (let col = 9; col < count - 9; col += 2) flip.push([row, col]);
    expect(read(draw(code, { flip }))).toBeNull();
  });
});
