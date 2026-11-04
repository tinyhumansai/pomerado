/**
 * The text the QR code in a picture holds, or null when the picture shows none it can read.
 * `pixels` is the picture's luminance, 0 (black) to 255 (white), row by row, `width` by `height`.
 *
 * It reads a code as a screen shows one: drawn upright or turned, dark on light or light on dark,
 * at any scale down to about two pixels a module, smoothed at its edges, with or without a quiet
 * zone, but not seen at an angle. It splits the picture into dark and light at Otsu's threshold,
 * finds the three finder patterns, reads every module at its centre, takes the format and version
 * from their own error-corrected copies, corrects each block with its Reed-Solomon codewords, and
 * decodes numeric, alphanumeric, byte (UTF-8, else Latin-1, or as an ECI names), and kanji
 * segments. A code it can't correct is null, never a guess.
 *
 * It is pure and self-contained: the page code of `qrCodeCode` embeds this same function.
 */
export const decodeQr = (pixels: ArrayLike<number>, width: number, height: number): string | null => {
  const at = (list: ArrayLike<number>, index: number) => list[index] ?? 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21) return null;
  if (pixels.length < width * height) return null;

  // GF(256) over x^8 + x^4 + x^3 + x^2 + 1, the field of QR's Reed-Solomon codes.
  const exps = new Uint8Array(512);
  const logs = new Uint8Array(256);
  for (let power = 0, value = 1; power < 255; power += 1) {
    exps[power] = value;
    logs[value] = power;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power += 1) exps[power] = at(exps, power - 255);
  const times = (a: number, b: number) => (a === 0 || b === 0 ? 0 : at(exps, at(logs, a) + at(logs, b)));
  const over = (a: number, b: number) => (a === 0 ? 0 : at(exps, (at(logs, a) + 255 - at(logs, b)) % 255));
  const alpha = (power: number) => at(exps, ((power % 255) + 255) % 255);

  // Dark and light at Otsu's threshold, in a picture padded with light so a code drawn to the
  // edge keeps its quiet zone.
  const histogram = new Array<number>(256).fill(0);
  let darkest = 255;
  let lightest = 0;
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.max(0, Math.min(255, Math.round(at(pixels, index))));
    histogram[value] = (histogram[value] ?? 0) + 1;
    darkest = Math.min(darkest, value);
    lightest = Math.max(lightest, value);
  }
  if (lightest - darkest < 32) return null;
  const total = width * height;
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * (histogram[value] ?? 0);
  let below = 0;
  let belowSum = 0;
  let best = -1;
  let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    below += histogram[value] ?? 0;
    if (below === 0) continue;
    const above = total - below;
    if (above === 0) break;
    belowSum += value * (histogram[value] ?? 0);
    const spread = below * above * (belowSum / below - (sum - belowSum) / above) ** 2;
    if (spread > best) {
      best = spread;
      threshold = value;
    }
  }
  const pad = Math.max(8, Math.round(Math.min(width, height) / 8));
  const wide = width + 2 * pad;
  const tall = height + 2 * pad;

  interface Point {
    readonly x: number;
    readonly y: number;
  }
  interface Finder extends Point {
    size: number;
    count: number;
  }

  // Finder patterns: dark, light, dark, light, dark runs in the ratio 1:1:3:1:1, across and down.
  const finders = (bits: Uint8Array): Finder[] => {
    const dark = (x: number, y: number) => at(bits, y * wide + x) === 1;
    const fits = (runs: readonly number[]) => {
      const length = runs.reduce((all, run) => all + run, 0);
      if (length < 7) return false;
      const module = length / 7;
      // Half a module each way, so an alignment pattern's 1:1:1:1:1 never passes.
      const slack = module / 2;
      return runs.every((run, place) => Math.abs((place === 2 ? 3 : 1) * module - run) < (place === 2 ? 3 : 1) * slack);
    };
    // The pattern's runs through (x, y) along one axis, and its centre on that axis.
    const cross = (x: number, y: number, down: boolean, most: number) => {
      const get = (step: number) => (down ? dark(x, step) : dark(step, y));
      const end = down ? tall : wide;
      const start = down ? y : x;
      if (!get(start)) return undefined;
      let middle = 0;
      let innerBefore = 0;
      let outerBefore = 0;
      let innerAfter = 0;
      let outerAfter = 0;
      let step = start;
      while (step >= 0 && get(step)) {
        middle += 1;
        step -= 1;
      }
      while (step >= 0 && !get(step) && innerBefore <= most) {
        innerBefore += 1;
        step -= 1;
      }
      if (step < 0 || innerBefore > most) return undefined;
      while (step >= 0 && get(step) && outerBefore <= most) {
        outerBefore += 1;
        step -= 1;
      }
      step = start + 1;
      while (step < end && get(step)) {
        middle += 1;
        step += 1;
      }
      while (step < end && !get(step) && innerAfter <= most) {
        innerAfter += 1;
        step += 1;
      }
      if (step >= end || innerAfter > most) return undefined;
      while (step < end && get(step) && outerAfter <= most) {
        outerAfter += 1;
        step += 1;
      }
      const runs = [outerBefore, innerBefore, middle, innerAfter, outerAfter];
      if (!fits(runs)) return undefined;
      return { centre: step - outerAfter - innerAfter - middle / 2, length: runs.reduce((all, run) => all + run, 0) };
    };
    const found: Finder[] = [];
    for (let y = 0; y < tall; y += 1) {
      const lengths: number[] = [];
      const starts: number[] = [];
      const colours: boolean[] = [];
      for (let x = 0; x < wide; x += 1) {
        const colour = dark(x, y);
        if (colours.length > 0 && colours[colours.length - 1] === colour) lengths[lengths.length - 1] = (lengths.at(-1) ?? 0) + 1;
        else {
          lengths.push(1);
          starts.push(x);
          colours.push(colour);
        }
      }
      for (let run = 0; run + 4 < lengths.length; run += 1) {
        if (colours[run] !== true) continue;
        const runs = lengths.slice(run, run + 5);
        if (!fits(runs)) continue;
        const length = runs.reduce((all, each) => all + each, 0);
        const across = at(starts, run + 2) + at(lengths, run + 2) / 2;
        const vertical = cross(Math.floor(across), y, true, length);
        if (vertical === undefined || Math.abs(vertical.length - length) * 5 > 2 * length) continue;
        const horizontal = cross(Math.floor(across), Math.floor(vertical.centre), false, length);
        if (horizontal === undefined || Math.abs(horizontal.length - length) * 5 > 2 * length) continue;
        const size = (length + vertical.length + horizontal.length) / 21;
        const point = { x: horizontal.centre, y: vertical.centre };
        const near = found.find(
          (finder) =>
            Math.abs(finder.x - point.x) <= Math.max(1, finder.size) &&
            Math.abs(finder.y - point.y) <= Math.max(1, finder.size) &&
            Math.abs(finder.size - size) <= Math.max(1, finder.size * 0.4),
        );
        if (near === undefined) found.push({ ...point, size, count: 1 });
        else {
          const count = near.count + 1;
          Object.assign(near, {
            x: (near.x * near.count + point.x) / count,
            y: (near.y * near.count + point.y) / count,
            size: (near.size * near.count + size) / count,
            count,
          });
        }
      }
    }
    return found;
  };

  // Trios of finders that can make the corners of one code: like sizes, two equal sides at a right
  // angle. The corner is the top left; the others are top right and bottom left, read clockwise.
  // Real finders are crossed by three times as many rows as anything else that fits, such as an
  // alignment pattern, so trios whose least-seen finder was seen most come first.
  const corners = (found: readonly Finder[]) => {
    const pool = found.filter((finder) => finder.count >= 2).sort((a, b) => b.count - a.count).slice(0, 12);
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const trios: { left: Finder; right: Finder; bottom: Finder; score: number; seen: number }[] = [];
    for (let first = 0; first < pool.length; first += 1)
      for (let second = first + 1; second < pool.length; second += 1)
        for (let third = second + 1; third < pool.length; third += 1) {
          const trio = [pool[first], pool[second], pool[third]].filter((finder) => finder !== undefined);
          if (trio.length !== 3) continue;
          const sizes = trio.map((finder) => finder.size);
          if (Math.max(...sizes) > Math.min(...sizes) * 1.5) continue;
          const [a, b, c] = trio as [Finder, Finder, Finder];
          const sides = [
            { corner: a, ends: [b, c] as const, opposite: distance(b, c) },
            { corner: b, ends: [a, c] as const, opposite: distance(a, c) },
            { corner: c, ends: [a, b] as const, opposite: distance(a, b) },
          ].sort((one, two) => two.opposite - one.opposite);
          const longest = sides[0];
          if (longest === undefined) continue;
          const [one, two] = longest.ends;
          const legOne = distance(longest.corner, one);
          const legTwo = distance(longest.corner, two);
          const module = (a.size + b.size + c.size) / 3;
          if (Math.min(legOne, legTwo) < 12 * module) continue;
          const uneven = Math.abs(legOne - legTwo) / Math.max(legOne, legTwo);
          const square = Math.abs(longest.opposite ** 2 - legOne ** 2 - legTwo ** 2) / longest.opposite ** 2;
          if (uneven > 0.2 || square > 0.2) continue;
          const score = uneven + square;
          const seen = Math.min(a.count, b.count, c.count);
          const turn = (one.x - longest.corner.x) * (two.y - longest.corner.y) - (one.y - longest.corner.y) * (two.x - longest.corner.x);
          trios.push(
            turn > 0
              ? { left: longest.corner, right: one, bottom: two, score, seen }
              : { left: longest.corner, right: two, bottom: one, score, seen },
          );
        }
    return trios.sort((one, two) => two.seen - one.seen || one.score - two.score).slice(0, 6);
  };

  const bitCount = (value: number) => {
    let count = 0;
    for (let rest = value; rest !== 0; rest &= rest - 1) count += 1;
    return count;
  };
  const degree = (value: number) => 31 - Math.clz32(value);
  const remainder = (value: number, generator: number) => {
    let rest = value;
    while (rest !== 0 && degree(rest) >= degree(generator)) rest ^= generator << (degree(rest) - degree(generator));
    return rest;
  };
  // The closest valid code word to any of `reads`, within three bits, as its data.
  const closest = (reads: readonly number[], codes: readonly (readonly [number, number])[]) => {
    let found: number | undefined;
    let fewest = 4;
    for (const [data, code] of codes)
      for (const read of reads) {
        const differ = bitCount(read ^ code);
        if (differ < fewest) {
          fewest = differ;
          found = data;
        }
      }
    return found;
  };
  const formats = Array.from({ length: 32 }, (_, data) => [data, ((data << 10) | remainder(data << 10, 0x537)) ^ 0x5412] as const);
  const versions = Array.from({ length: 34 }, (_, offset) => {
    const version = offset + 7;
    return [version, (version << 12) | remainder(version << 12, 0x1f25)] as const;
  });

  // Error correction codewords per block and blocks, by level (L, M, Q, H) and version.
  const eccPerBlock = [
    [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const blockCounts = [
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  const alignments = (version: number) => {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const centres = [6];
    for (let place = version * 4 + 10; centres.length < count; place -= step) centres.splice(1, 0, place);
    return centres;
  };
  const dataModules = (version: number) => {
    let modules = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const count = Math.floor(version / 7) + 2;
      modules -= (25 * count - 10) * count - 55;
      if (version >= 7) modules -= 36;
    }
    return modules;
  };

  // One block corrected with its error correction codewords (Berlekamp-Massey, Chien, Forney).
  const corrected = (block: readonly number[], ecc: number) => {
    const syndromeAt = (values: readonly number[], power: number) =>
      values.reduce((value, codeword) => times(value, alpha(power)) ^ codeword, 0);
    const syndromes = Array.from({ length: ecc }, (_, power) => syndromeAt(block, power));
    if (syndromes.every((syndrome) => syndrome === 0)) return [...block];
    let locator = [1];
    let previous = [1];
    let errors = 0;
    let shift = 1;
    let last = 1;
    for (let step = 0; step < ecc; step += 1) {
      let delta = at(syndromes, step);
      for (let term = 1; term <= errors; term += 1) delta ^= times(at(locator, term), at(syndromes, step - term));
      if (delta === 0) {
        shift += 1;
        continue;
      }
      const scale = over(delta, last);
      const next = [...locator];
      previous.forEach((coefficient, term) => {
        next[term + shift] = (next[term + shift] ?? 0) ^ times(scale, coefficient);
      });
      if (2 * errors <= step) {
        previous = locator;
        errors = step + 1 - errors;
        last = delta;
        shift = 1;
      } else shift += 1;
      locator = next;
    }
    if (errors * 2 > ecc) return undefined;
    const evaluate = (values: readonly number[], x: number) =>
      values.reduceRight((value, coefficient) => times(value, x) ^ coefficient, 0);
    const places: number[] = [];
    for (let place = 0; place < block.length; place += 1) if (evaluate(locator, alpha(-place)) === 0) places.push(place);
    if (places.length !== errors) return undefined;
    const evaluator = Array.from({ length: ecc }, (_, term) => {
      let value = 0;
      for (let part = 0; part <= term && part < locator.length; part += 1) value ^= times(at(locator, part), at(syndromes, term - part));
      return value;
    });
    const fixed = [...block];
    for (const place of places) {
      let slope = 0;
      for (let term = 1; term < locator.length; term += 2) slope ^= times(at(locator, term), alpha(-place * (term - 1)));
      if (slope === 0) return undefined;
      const index = block.length - 1 - place;
      fixed[index] = at(fixed, index) ^ times(alpha(place), over(evaluate(evaluator, alpha(-place)), slope));
    }
    return Array.from({ length: ecc }, (_, power) => syndromeAt(fixed, power)).every((syndrome) => syndrome === 0)
      ? fixed
      : undefined;
  };

  // The text of a code's data codewords, segment by segment.
  const text = (data: readonly number[], version: number) => {
    let cursor = 0;
    const read = (count: number) => {
      if (cursor + count > data.length * 8) return -1;
      let value = 0;
      for (let step = 0; step < count; step += 1) {
        const bit = (at(data, (cursor + step) >> 3) >> (7 - ((cursor + step) & 7))) & 1;
        value = value * 2 + bit;
      }
      cursor += count;
      return value;
    };
    const lengthBits = (mode: number) => {
      const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
      const table: Record<number, readonly number[]> = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16], 8: [8, 10, 12] };
      return table[mode]?.[band] ?? 0;
    };
    const characters = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    const charsets: Record<number, string> = { 1: "latin1", 3: "latin1", 4: "iso-8859-2", 20: "shift_jis", 22: "windows-1251", 26: "utf-8" };
    let charset: string | undefined;
    const bytesText = (bytes: readonly number[]) => {
      const view = Uint8Array.from(bytes);
      if (charset !== undefined) return new TextDecoder(charset).decode(view);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(view);
      } catch {
        return new TextDecoder("latin1").decode(view);
      }
    };
    let out = "";
    while (data.length * 8 - cursor >= 4) {
      const mode = read(4);
      if (mode === 0) break;
      if (mode === 1) {
        let count = read(lengthBits(1));
        if (count < 0) return undefined;
        for (; count >= 3; count -= 3) {
          const value = read(10);
          if (value < 0 || value > 999) return undefined;
          out += String(value).padStart(3, "0");
        }
        if (count > 0) {
          const value = read(count === 2 ? 7 : 4);
          if (value < 0 || value >= 10 ** count) return undefined;
          out += String(value).padStart(count, "0");
        }
      } else if (mode === 2) {
        let count = read(lengthBits(2));
        if (count < 0) return undefined;
        for (; count >= 2; count -= 2) {
          const value = read(11);
          if (value < 0 || value >= 45 * 45) return undefined;
          out += characters.charAt(Math.floor(value / 45)) + characters.charAt(value % 45);
        }
        if (count === 1) {
          const value = read(6);
          if (value < 0 || value >= 45) return undefined;
          out += characters.charAt(value);
        }
      } else if (mode === 4) {
        const count = read(lengthBits(4));
        if (count < 0) return undefined;
        const bytes: number[] = [];
        for (let step = 0; step < count; step += 1) {
          const value = read(8);
          if (value < 0) return undefined;
          bytes.push(value);
        }
        out += bytesText(bytes);
      } else if (mode === 7) {
        const first = read(8);
        let value = -1;
        if (first >= 0 && (first & 0x80) === 0) value = first & 0x7f;
        else if (first >= 0 && (first & 0xc0) === 0x80) value = ((first & 0x3f) << 8) | read(8);
        else if (first >= 0 && (first & 0xe0) === 0xc0) value = ((first & 0x1f) << 16) | read(16);
        if (value < 0) return undefined;
        charset = charsets[value];
      } else if (mode === 8) {
        const count = read(lengthBits(8));
        if (count < 0) return undefined;
        const bytes: number[] = [];
        for (let step = 0; step < count; step += 1) {
          const value = read(13);
          if (value < 0) return undefined;
          let joined = (Math.floor(value / 0xc0) << 8) | (value % 0xc0);
          joined += joined < 0x1f00 ? 0x8140 : 0xc140;
          bytes.push(joined >> 8, joined & 0xff);
        }
        out += new TextDecoder("shift_jis").decode(Uint8Array.from(bytes));
      } else if (mode === 3) {
        if (read(16) < 0) return undefined;
      } else if (mode === 9) {
        if (read(8) < 0) return undefined;
      } else if (mode !== 5) return undefined;
    }
    return out;
  };

  // The code whose finders are `ends`, read as a code `side` modules square.
  const decode = (bits: Uint8Array, ends: { left: Point; right: Point; bottom: Point }, module: number, side: number) => {
    const span = side - 7;
    const across = { x: (ends.right.x - ends.left.x) / span, y: (ends.right.y - ends.left.y) / span };
    const down = { x: (ends.bottom.x - ends.left.x) / span, y: (ends.bottom.y - ends.left.y) / span };
    const reach = Math.max(0, Math.floor(module / 4));
    const grid = new Uint8Array(side * side);
    for (let row = 0; row < side; row += 1)
      for (let column = 0; column < side; column += 1) {
        const x = ends.left.x + (column - 3) * across.x + (row - 3) * down.x;
        const y = ends.left.y + (column - 3) * across.y + (row - 3) * down.y;
        let darkCount = 0;
        let seen = 0;
        for (let dy = -reach; dy <= reach; dy += 1)
          for (let dx = -reach; dx <= reach; dx += 1) {
            const px = Math.floor(x) + dx;
            const py = Math.floor(y) + dy;
            if (px < 0 || py < 0 || px >= wide || py >= tall) continue;
            seen += 1;
            darkCount += at(bits, py * wide + px);
          }
        grid[row * side + column] = seen > 0 && darkCount * 2 > seen ? 1 : 0;
      }
    const cell = (column: number, row: number) => at(grid, row * side + column);
    const take = (column: number, row: number, value: number) => (value << 1) | cell(column, row);
    let first = 0;
    for (let column = 0; column < 6; column += 1) first = take(column, 8, first);
    first = take(7, 8, first);
    first = take(8, 8, first);
    first = take(8, 7, first);
    for (let row = 5; row >= 0; row -= 1) first = take(8, row, first);
    let second = 0;
    for (let row = side - 1; row >= side - 7; row -= 1) second = take(8, row, second);
    for (let column = side - 8; column < side; column += 1) second = take(column, 8, second);
    const format = closest([first, second], formats);
    if (format === undefined) return undefined;
    const level = [1, 0, 3, 2][format >> 3] ?? 0;
    const mask = format & 7;
    let version = (side - 17) / 4;
    if (version >= 7) {
      let topRight = 0;
      for (let row = 5; row >= 0; row -= 1) for (let column = side - 9; column >= side - 11; column -= 1) topRight = take(column, row, topRight);
      let bottomLeft = 0;
      for (let column = 5; column >= 0; column -= 1) for (let row = side - 9; row >= side - 11; row -= 1) bottomLeft = take(column, row, bottomLeft);
      const read = closest([topRight, bottomLeft], versions);
      if (read === undefined || read !== version) return undefined;
    }
    if (!Number.isInteger(version) || version < 1 || version > 40) return undefined;
    // Modules the function patterns hold, which carry no data.
    const fixed = new Uint8Array(side * side);
    const region = (left: number, top: number, regionWidth: number, regionHeight: number) => {
      for (let row = top; row < top + regionHeight; row += 1)
        for (let column = left; column < left + regionWidth; column += 1) fixed[row * side + column] = 1;
    };
    region(0, 0, 9, 9);
    region(side - 8, 0, 8, 9);
    region(0, side - 8, 9, 8);
    const centres = alignments(version);
    centres.forEach((columnCentre, x) =>
      centres.forEach((rowCentre, y) => {
        const last = centres.length - 1;
        if ((x === 0 && (y === 0 || y === last)) || (x === last && y === 0)) return;
        region(columnCentre - 2, rowCentre - 2, 5, 5);
      }),
    );
    region(6, 9, 1, side - 17);
    region(9, 6, side - 17, 1);
    if (version >= 7) {
      region(side - 11, 0, 3, 6);
      region(0, side - 11, 6, 3);
    }
    const masked = (row: number, column: number) => {
      switch (mask) {
        case 0: return (row + column) % 2 === 0;
        case 1: return row % 2 === 0;
        case 2: return column % 3 === 0;
        case 3: return (row + column) % 3 === 0;
        case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
        case 5: return (row * column) % 6 === 0;
        case 6: return (row * column) % 6 < 3;
        default: return (row + column + ((row * column) % 3)) % 2 === 0;
      }
    };
    const codewords: number[] = [];
    let current = 0;
    let bitsRead = 0;
    let upward = true;
    for (let column = side - 1; column > 0; column -= 2) {
      if (column === 6) column -= 1;
      for (let count = 0; count < side; count += 1) {
        const row = upward ? side - 1 - count : count;
        for (let pair = 0; pair < 2; pair += 1) {
          const x = column - pair;
          if (at(fixed, row * side + x) === 1) continue;
          current = (current << 1) | (cell(x, row) ^ (masked(row, x) ? 1 : 0));
          bitsRead += 1;
          if (bitsRead === 8) {
            codewords.push(current);
            current = 0;
            bitsRead = 0;
          }
        }
      }
      upward = !upward;
    }
    const raw = Math.floor(dataModules(version) / 8);
    const ecc = eccPerBlock[level]?.[version] ?? 0;
    const blocks = blockCounts[level]?.[version] ?? 0;
    if (codewords.length < raw || ecc === 0 || blocks === 0) return undefined;
    const short = blocks - (raw % blocks);
    const shortLength = Math.floor(raw / blocks);
    const parts = Array.from({ length: blocks }, () => new Array<number>(shortLength + 1).fill(0));
    let next = 0;
    for (let place = 0; place <= shortLength; place += 1)
      parts.forEach((part, index) => {
        if (place === shortLength - ecc && index < short) return;
        part[place] = at(codewords, next);
        next += 1;
      });
    const data: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (index < short) part.splice(shortLength - ecc, 1);
      const fixedPart = corrected(part, ecc);
      if (fixedPart === undefined) return undefined;
      data.push(...fixedPart.slice(0, fixedPart.length - ecc));
    }
    return text(data, version);
  };

  for (const inverted of [false, true]) {
    const bits = new Uint8Array(wide * tall);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const isDark = at(pixels, y * width + x) <= threshold;
        bits[(y + pad) * wide + x + pad] = isDark !== inverted ? 1 : 0;
      }
    for (const ends of corners(finders(bits))) {
      const module = (ends.left.size + ends.right.size + ends.bottom.size) / 3;
      const measured =
        (Math.hypot(ends.right.x - ends.left.x, ends.right.y - ends.left.y) +
          Math.hypot(ends.bottom.x - ends.left.x, ends.bottom.y - ends.left.y)) /
          2 /
          module +
        7;
      // The nearest sides a code can have (17 + 4 × version), nearest first.
      const sides = [0, 4, -4, 8, -8]
        .map((offset) => Math.round((measured - 17) / 4) * 4 + 17 + offset)
        .filter((side) => side >= 21 && side <= 177);
      for (const side of sides) {
        const read = decode(bits, ends, module, side);
        if (read !== undefined) return read;
      }
    }
  }
  return null;
};
