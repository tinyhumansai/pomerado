// Failure modes covered: a QR code read with the wrong block layout or error correction table for
// its version and level, so some versions never read; a payload in numeric, alphanumeric or byte
// segments, or UTF-8, read as other text; modules a screen capture got wrong left uncorrected;
// a code drawn light on dark, turned, scaled to a fraction of a pixel per module or smoothed at
// its edges, or captured with no quiet zone around it, not found; a picture that holds no code,
// or one too damaged to correct, read as text instead of none; a picture holding two codes, such
// as a payment code beside an app's download code, read as one of them; a byte segment in the
// charset an ECI names, or a character two byte segments split, read as other text, and an ECI
// with no known charset or one part of a structured append read as the whole text; and a small
// code with more errors than its misdecode protection leaves correctable read as a guess.
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

/** A code's modules, as qrcode-generator and `custom` give them. */
interface Modules {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

/** A code for `segments` at `version` (0 for the smallest that fits) and `level`. */
const make = (segments: readonly (readonly [string, Mode])[], level: Level = "M", version = 0) => {
  const code = qrcode(version as Parameters<typeof qrcode>[0], level);
  for (const [text, mode] of segments) code.addData(text, mode);
  code.make();
  return code;
};

/** The modules that carry codewords in a code of `version` 1 to 6, as [row, column] in reading order. */
const dataOrder = (version: number) => {
  const side = 17 + 4 * version;
  const fixed = new Set<number>();
  const region = (left: number, top: number, width: number, height: number) => {
    for (let row = top; row < top + height; row += 1)
      for (let column = left; column < left + width; column += 1) fixed.add(row * side + column);
  };
  region(0, 0, 9, 9);
  region(side - 8, 0, 8, 9);
  region(0, side - 8, 9, 8);
  region(6, 0, 1, side);
  region(0, 6, side, 1);
  if (version >= 2) region(side - 9, side - 9, 5, 5);
  const order: (readonly [number, number])[] = [];
  let upward = true;
  for (let column = side - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    for (let count = 0; count < side; count += 1) {
      const row = upward ? side - 1 - count : count;
      for (const x of [column, column - 1]) if (!fixed.has(row * side + x)) order.push([row, x]);
    }
    upward = !upward;
  }
  return order;
};

// GF(256) for the Reed-Solomon codewords of `custom`.
const exps: number[] = [];
const logs: number[] = new Array<number>(256).fill(0);
for (let power = 0, value = 1; power < 255; power += 1) {
  exps.push(value);
  logs[value] = power;
  value = value & 0x80 ? ((value << 1) ^ 0x11d) & 0xff : value << 1;
}
const times = (a: number, b: number) => (a === 0 || b === 0 ? 0 : (exps[((logs[a] ?? 0) + (logs[b] ?? 0)) % 255] ?? 0));

/** The `count` error correction codewords of `data`. */
const eccFor = (data: readonly number[], count: number) => {
  let generator = [1];
  for (let power = 0; power < count; power += 1) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((coefficient, term) => {
      next[term] = (next[term] ?? 0) ^ coefficient;
      next[term + 1] = (next[term + 1] ?? 0) ^ times(coefficient, exps[power] ?? 0);
    });
    generator = next;
  }
  const rest = [...data, ...new Array<number>(count).fill(0)];
  for (let place = 0; place < data.length; place += 1) {
    const factor = rest[place] ?? 0;
    if (factor !== 0)
      generator.forEach((coefficient, term) => {
        rest[place + term] = (rest[place + term] ?? 0) ^ times(coefficient, factor);
      });
  }
  return rest.slice(data.length);
};

const masked = (mask: number, row: number, column: number) =>
  [
    (row + column) % 2 === 0,
    row % 2 === 0,
    column % 3 === 0,
    (row + column) % 3 === 0,
    (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
    (row * column) % 6 === 0,
    (row * column) % 6 < 3,
    (row + column + ((row * column) % 3)) % 2 === 0,
  ][mask] === true;

const binary = (value: number, length: number) => value.toString(2).padStart(length, "0");
const byteSegment = (bytes: readonly number[]) =>
  `0100${binary(bytes.length, 8)}${bytes.map((byte) => binary(byte, 8)).join("")}`;
const eciSegment = (value: number) =>
  `0111${value < 128 ? binary(value, 8) : value < 16384 ? `10${binary(value, 14)}` : `110${binary(value, 21)}`}`;
const structuredAppend = (position: number, total: number, parity: number) =>
  `0011${binary(position, 4)}${binary(total - 1, 4)}${binary(parity, 8)}`;

/**
 * A code whose data is exactly `bits`, written as "0" and "1", for segments qrcode-generator can't
 * write, such as an ECI or a structured append header: version 1 or 2, one block. It takes the
 * function patterns and format from a qrcode-generator code of the same version and level, and
 * writes its own codewords under that code's mask.
 */
const custom = (bits: string, version: 1 | 2 = 2, level: Level = "M"): Modules => {
  const total = version === 1 ? 26 : 44;
  const ecc = { L: [7, 10], M: [10, 16], Q: [13, 22], H: [17, 28] }[level][version - 1] ?? 0;
  const capacity = (total - ecc) * 8;
  if (bits.length > capacity) throw new Error("too many bits for the code");
  let stream = bits + "0000".slice(0, capacity - bits.length);
  stream = stream.padEnd(Math.ceil(stream.length / 8) * 8, "0");
  const data: number[] = [];
  for (let at = 0; at < stream.length; at += 8) data.push(parseInt(stream.slice(at, at + 8), 2));
  for (let pad = 0; data.length < total - ecc; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
  const codewords = [...data, ...eccFor(data, ecc)];
  const base = make([["0", "Numeric"]], level, version);
  const side = base.getModuleCount();
  let format = 0;
  const take = (row: number, column: number) => {
    format = (format << 1) | (base.isDark(row, column) ? 1 : 0);
  };
  for (let column = 0; column < 6; column += 1) take(8, column);
  take(8, 7);
  take(8, 8);
  take(7, 8);
  for (let row = 5; row >= 0; row -= 1) take(row, 8);
  const mask = ((format ^ 0x5412) >> 10) & 7;
  const dark = Array.from({ length: side }, (_, row) => Array.from({ length: side }, (_, column) => base.isDark(row, column)));
  dataOrder(version).forEach(([row, column], place) => {
    const bit = (((codewords[place >> 3] ?? 0) >> (7 - (place & 7))) & 1) === 1;
    const line = dark[row];
    if (line !== undefined) line[column] = bit !== masked(mask, row, column);
  });
  return { getModuleCount: () => side, isDark: (row, column) => dark[row]?.[column] === true };
};

/** Draws `code` as luminance, `cell` pixels per module (a fraction too), `margin` modules around. */
const draw = (
  code: Modules,
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

/** One picture `width` by `height` on a light ground, holding each image at its top-left corner. */
const compose = (width: number, height: number, pieces: readonly (readonly [Image, number, number])[]): Image => {
  const pixels = new Uint8Array(width * height).fill(235);
  for (const [image, left, top] of pieces)
    for (let y = 0; y < image.height; y += 1)
      for (let x = 0; x < image.width; x += 1) pixels[(top + y) * width + left + x] = image.pixels[y * image.width + x] ?? 235;
  return { pixels, width, height };
};

const read = ({ pixels, width, height }: Image) => decodeQr(pixels, width, height);

const payment = "upi://pay?pa=grocer@examplebank&pn=Corner%20Grocer&am=74.00&cu=INR&tn=Order 7 ₹74";
const download = "https://app.example.test/download?ref=checkout";

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

  it("answers null for a picture holding two codes with different texts, however they sit", () => {
    const pay = draw(make([[payment, "Byte"]], "M"));
    const app = draw(make([[download, "Byte"]], "M"));
    const small = draw(make([[download, "Byte"]], "L"), { cell: 3 });
    const wide = pay.width + app.width;
    const tall = pay.height + app.height;
    const layouts = {
      "side by side": compose(wide, pay.height, [[pay, 0, 0], [app, pay.width, 0]]),
      "side by side, swapped": compose(wide, pay.height, [[app, 0, 0], [pay, app.width, 0]]),
      "stacked": compose(pay.width, tall, [[pay, 0, 0], [app, 0, pay.height]]),
      "stacked, swapped": compose(pay.width, tall, [[app, 0, 0], [pay, 0, app.height]]),
      "diagonal": compose(wide, tall, [[pay, 0, 0], [app, pay.width, pay.height]]),
      "beside a smaller one": compose(pay.width + small.width, pay.height, [[pay, 0, 0], [small, pay.width, 40]]),
    };
    for (const [layout, picture] of Object.entries(layouts)) expect(read(picture), layout).toBeNull();
    // The same code twice is still its text.
    expect(read(compose(2 * pay.width, pay.height, [[pay, 0, 0], [pay, pay.width, 0]]))).toBe(payment);
  });

  it("reads a byte segment in the charset its ECI names, and answers null for one it can't name", () => {
    expect(read(draw(custom(eciSegment(28) + byteSegment([0xa4, 0xa4, 0xa4, 0xe5]))))).toBe("中文");
    expect(read(draw(custom(eciSegment(29) + byteSegment([0xd6, 0xd0, 0xce, 0xc4]))))).toBe("中文");
    expect(read(draw(custom(eciSegment(30) + byteSegment([0xc7, 0xd1, 0xb1, 0xb9]))))).toBe("한국");
    expect(read(draw(custom(eciSegment(25) + byteSegment([0x20, 0xb9, 0x00, 0x37, 0x00, 0x34]))))).toBe("₹74");
    expect(read(draw(custom(eciSegment(26) + byteSegment([0xe2, 0x82, 0xb9, 0x37, 0x34]))))).toBe("₹74");
    // UTF-32, binary data and an ECI never assigned have no charset to read them in.
    expect(read(draw(custom(eciSegment(34) + byteSegment([0, 0, 0, 0x41]))))).toBeNull();
    expect(read(draw(custom(eciSegment(899) + byteSegment([0x41]))))).toBeNull();
    expect(read(draw(custom(eciSegment(14) + byteSegment([0x41]))))).toBeNull();
  });

  it("joins a character that two byte segments split before reading it", () => {
    expect(read(draw(custom(byteSegment([0x41, 0xe2, 0x82]) + byteSegment([0xb9, 0x37, 0x34]))))).toBe("A₹74");
    expect(read(draw(custom(eciSegment(26) + byteSegment([0xe2]) + byteSegment([0x82, 0xb9]))))).toBe("₹");
  });

  it("answers null for one code of several that a structured append joins", () => {
    const part = [...new TextEncoder().encode("upi://pay?pa=")];
    expect(read(draw(custom(structuredAppend(0, 2, 0x5a) + byteSegment(part))))).toBeNull();
  });

  it("corrects a small code only as far as its misdecode protection allows", () => {
    // ISO 18004 keeps 3 of version 1-L's 7 error correction codewords, 2 of 1-M's 10 and 2 of
    // 2-L's 10 for detecting a misdecode, so they correct 2, 4 and 4 errors, not 3, 5 and 5.
    for (const [version, level, most] of [
      [1, "L", 2],
      [1, "M", 4],
      [2, "L", 4],
    ] as const) {
      const text = "Order 7";
      const code = make([[text, "Byte"]], level, version);
      const order = dataOrder(version);
      // One module in each of `errors` codewords, every third codeword.
      const broken = (errors: number) =>
        draw(code, { flip: Array.from({ length: errors }, (_, at) => order[at * 24] ?? [0, 0]) });
      expect(read(broken(most)), `${version}-${level} with ${most} errors`).toBe(text);
      expect(read(broken(most + 1)), `${version}-${level} with ${most + 1} errors`).toBeNull();
    }
  });
});
