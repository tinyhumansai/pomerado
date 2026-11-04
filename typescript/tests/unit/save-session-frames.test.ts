// Failure modes covered: a save whose frame never answers, as one behind an open dialog doesn't,
// holding its browser call until the call times out, which stops the browser; a page of many such
// frames doing the same one frame at a time; a slow storage state, such as one with a large
// IndexedDB, using up the frames' time, so their session storage comes back empty with no error;
// and frames that answer read otherwise than before: each same-site origin once, its entries as
// the page holds them, and nothing from another site.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveSessionCode } from "../../src/runtime/start-state.js";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/**
 * A frame of the modeled tab: its address and the session storage its document holds, answered
 * at once or after `answersAfterMs`. A frame without storage never answers.
 */
interface ModeledFrame {
  readonly url: string;
  readonly storage?: readonly (readonly [string, string])[];
  readonly answersAfterMs?: number;
}

const state = { cookies: [], origins: [] };

/**
 * Runs the save's browser call on one tab of `frames`. Each frame's read runs as a page runs it:
 * from its source, with the frame's own session storage and location. The storage state answers
 * at once or after `stateAfterMs`. `saved` is what the call returned, undefined until it did,
 * `read` lists the frames it read, in order, and `stateAskedAt` is when it asked the state.
 */
const save = (frames: readonly ModeledFrame[], stateAfterMs = 0) => {
  const read: string[] = [];
  let stateAskedAt: number | undefined;
  const tab = {
    frames: () =>
      frames.map((frame) => ({
        url: () => frame.url,
        evaluate: (inPage: () => unknown) => {
          read.push(frame.url);
          const stored = frame.storage;
          if (stored === undefined) return new Promise(() => undefined);
          const sessionStorage = {
            length: stored.length,
            key: (index: number) => stored[index]?.[0] ?? null,
            getItem: (key: string) => stored.find(([name]) => name === key)?.[1] ?? null,
          };
          const answer: unknown = new Function(
            "sessionStorage",
            "location",
            `return (${inPage.toString()})();`,
          )(sessionStorage, { origin: new URL(frame.url).origin });
          return new Promise((resolve) => {
            if (frame.answersAfterMs === undefined) resolve(answer);
            else setTimeout(() => resolve(answer), frame.answersAfterMs);
          });
        },
      })),
  };
  const context = {
    pages: () => [tab],
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "primary" } }),
      detach: async () => undefined,
    }),
    storageState: () => {
      stateAskedAt = Date.now();
      return new Promise((resolve) => {
        if (stateAfterMs === 0) resolve(state);
        else setTimeout(() => resolve(state), stateAfterMs);
      });
    },
  };
  const call = new AsyncFunction(
    "page",
    "context",
    "browser",
    saveSessionCode("primary", "https://shop.example"),
  );
  let saved: unknown;
  void call(tab, context, undefined).then((value) => {
    saved = value;
  });
  return { saved: () => saved, read, stateAskedAt: () => stateAskedAt };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("reads each same-site origin's session storage once, and nothing of another site", async () => {
  const browser = save([
    { url: "https://shop.example/cart", storage: [["cart", "c-1"], ["step", "2"]] },
    { url: "https://shop.example/frame", storage: [["cart", "c-1"]] },
    { url: "https://id.shop.example/frame", storage: [["token", "t-1"]] },
    { url: "https://pay.shop.example/frame", storage: [] },
    { url: "https://ads.example.net/frame", storage: [["ad", "a-1"]] },
    { url: "about:blank", storage: [] },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(browser.saved()).toEqual({
    state,
    sessionStorage: [
      { origin: "https://shop.example", entries: [["cart", "c-1"], ["step", "2"]] },
      { origin: "https://id.shop.example", entries: [["token", "t-1"]] },
    ],
  });
  expect(browser.read).toEqual([
    "https://shop.example/cart",
    "https://id.shop.example/frame",
    "https://pay.shop.example/frame",
  ]);
});

it("skips a frame that doesn't answer within seconds, and reads the frames after it", async () => {
  const browser = save([
    { url: "https://shop.example/cart", storage: [["cart", "c-1"]] },
    { url: "https://pay.shop.example/frame" },
    { url: "https://id.shop.example/frame", storage: [["token", "t-1"]], answersAfterMs: 2_500 },
    { url: "https://help.shop.example/frame", storage: [["chat", "h-1"]], answersAfterMs: 3_500 },
    { url: "https://account.shop.example/frame", storage: [["name", "a-1"]] },
  ]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(browser.saved()).toEqual({
    state,
    sessionStorage: [
      { origin: "https://shop.example", entries: [["cart", "c-1"]] },
      { origin: "https://id.shop.example", entries: [["token", "t-1"]] },
      { origin: "https://account.shop.example", entries: [["name", "a-1"]] },
    ],
  });
});

it("reads the frames before a slow storage state, which leaves their session storage", async () => {
  const browser = save([{ url: "https://shop.example/cart", storage: [["cart", "c-1"]] }], 45_000);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(browser.saved()).toEqual({
    state,
    sessionStorage: [{ origin: "https://shop.example", entries: [["cart", "c-1"]] }],
  });
});

it("reads no frame past 20 s in, leaving the storage state the rest of the call", async () => {
  const started = Date.now();
  const browser = save(
    Array.from({ length: 40 }, (_, index) => ({ url: `https://s${index}.shop.example/` })),
    30_000,
  );
  await vi.advanceTimersByTimeAsync(50_000);
  // The storage state was asked by 20 s into the call, so the call ends well inside its 60 s.
  expect(browser.saved()).toEqual({ state, sessionStorage: [] });
  expect((browser.stateAskedAt() ?? Number.POSITIVE_INFINITY) - started).toBeLessThanOrEqual(
    20_000,
  );
});
