// Failure modes covered: an address counted as answered although the site redirected it, refused it
// or only let a preflight through; a page's address counted when its own document failed, or a route
// inside such a document; an address of no site at all; accessible names read wrongly when the
// snapshot quotes them; a page shown only inside one browser call that is never read; a read that
// repeats what it handed over or keeps what it was told to stop holding; a field read while a call
// may be typing in it; and a read that says it is whole when a page never answered, answered nonsense
// or didn't fit, or partial when a page only answered late.
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { accessibleNames, readFrameCode, watchPages } from "../../src/execution/pages-watch.js";

type Read = (code: string) => Promise<unknown>;

const walked =
  (lines: readonly string[], links: readonly string[] = [], cut = false): Read =>
  () =>
    Promise.resolve({ lines, links, cut });

const frame = (url: string, read: Read = walked([]), snapshot: () => Promise<string> = async () => "") => ({
  url: () => url,
  evaluate: read,
  locator: () => ({ ariaSnapshot: snapshot }),
});
type Frame = ReturnType<typeof frame>;

const page = (...frames: readonly Frame[]) =>
  Object.assign(new EventEmitter(), { frames: () => frames });
type Page = ReturnType<typeof page>;

const browserContext = (...pages: readonly Page[]) => {
  const contexts: unknown[] = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    browser: () => ({ contexts: () => contexts }),
  });
  contexts.push(context);
  return { context, contexts, watch: watchPages(context as never) };
};

const answer = (
  url: string,
  status: number,
  options: { readonly method?: string; readonly document?: Frame } = {},
) => ({
  url: () => url,
  status: () => status,
  request: () => ({
    method: () => options.method ?? "GET",
    isNavigationRequest: () => options.document !== undefined,
    frame: () => options.document,
  }),
});

const nothing = { answered: [], links: [], texts: [], partial: false };

it("holds each http address the site answered with success, and no other", async () => {
  const { context, watch } = browserContext();
  for (const [url, status] of [
    ["https://shop.test/ok", 200],
    ["https://shop.test/created", 201],
    ["https://shop.test/empty", 204],
    ["https://shop.test/unchanged", 304],
    ["https://shop.test/moved", 302],
    ["https://shop.test/refused", 403],
    ["https://shop.test/missing", 404],
    ["https://shop.test/broken", 500],
    ["data:text/plain,hi", 200],
    ["blob:https://shop.test/1", 200],
  ] as const)
    context.emit("response", answer(url, status));
  context.emit("response", answer("https://shop.test/asked", 204, { method: "OPTIONS" }));

  expect(await watch.read(false)).toEqual({
    ...nothing,
    answered: [
      "https://shop.test/ok",
      "https://shop.test/created",
      "https://shop.test/empty",
      "https://shop.test/unchanged",
    ],
  });
});

it("counts a page's address, and a route inside it, only when its document was answered with success", async () => {
  const main = frame("https://shop.test/");
  const tab = page(main);
  const { context, watch } = browserContext(tab);
  const moved = (url: string) => {
    main.url = () => url;
    tab.emit("framenavigated", main);
  };
  context.emit("response", answer("https://shop.test/orders/2", 404, { document: main }));
  moved("https://shop.test/orders/2");
  moved("https://shop.test/orders/2#/details");
  context.emit("response", answer("https://shop.test/home", 200, { document: main }));
  moved("https://shop.test/home");
  moved("https://shop.test/home#/cart");
  moved("https://shop.test/account");

  expect((await watch.read(false)).answered).toEqual([
    "https://shop.test/home",
    "https://shop.test/home#/cart",
    "https://shop.test/account",
  ]);
});

it("keeps a frame's document as it was when an answer never replaced it, as a download or a 204 leaves it", async () => {
  const main = frame("https://shop.test/");
  const tab = page(main);
  const { context, watch } = browserContext(tab);
  const moved = (url: string) => {
    main.url = () => url;
    tab.emit("framenavigated", main);
  };
  context.emit("response", answer("https://shop.test/orders/2", 404, { document: main }));
  moved("https://shop.test/orders/2");
  context.emit("response", answer("https://shop.test/report.pdf", 200, { document: main }));
  moved("https://shop.test/orders/2#/details");

  expect((await watch.read(false)).answered).toEqual(["https://shop.test/report.pdf"]);
});

it("counts no route of a frame whose document it never heard answered", async () => {
  const main = frame("https://shop.test/");
  const tab = page(main);
  const { watch } = browserContext(tab);
  main.url = () => "https://shop.test/route";
  tab.emit("framenavigated", main);

  expect((await watch.read(false)).answered).toEqual([]);
});

it("watches a page the context opens later", async () => {
  const { context, watch } = browserContext();
  const popup = frame("https://shop.test/popup", walked(["Popup words"]));
  const tab = page(popup);
  context.emit("page", tab);
  tab.emit("load");
  await Promise.resolve();
  popup.evaluate = walked([]);

  expect((await watch.read(false)).texts).toEqual(["Popup words"]);
});

it("reads the accessible names a snapshot quotes, however it escapes them", () => {
  expect(
    accessibleNames(
      [
        "- document:",
        '  - heading "Shop" [level=1]',
        '  - button "Add to cart"',
        `  - 'link "Delivery: today"':`,
        "    - /url: /delivery",
        `  - 'button "It''s \\"new\\""'`,
        '  - textbox "Search": typed words',
        "  - text: Plain words",
        "  - paragraph: Not a name",
        "  - list:",
      ].join("\n"),
    ),
  ).toEqual(["Shop", "Add to cart", "Delivery: today", `It's "new"`, "Search"]);
});

it("reads every frame of every page, with its links and accessible names, and hands each over once", async () => {
  const main = frame(
    "https://shop.test/",
    walked(["Main words"], ["https://shop.test/a"]),
    async () => '- button "Buy now"',
  );
  const inner = frame("https://shop.test/inner", walked(["Inner words"], ["https://shop.test/b"]));
  const other = frame("https://shop.test/other", walked(["Other words", "Main words"]));
  const { watch } = browserContext(page(main, inner), page(other));

  expect(await watch.read(false)).toEqual({
    ...nothing,
    links: ["https://shop.test/a", "https://shop.test/b"],
    texts: ["Main words", "Buy now", "Inner words", "Other words"],
  });
});

it("reads a page as its document ends and as it loads, so one a browser call only passes through still counts", async () => {
  let shown = "First page";
  const tab = page(frame("https://shop.test/", () => walked([shown])("")));
  const { watch } = browserContext(tab);
  tab.emit("domcontentloaded");
  await Promise.resolve();
  shown = "Loaded page";
  tab.emit("load");
  await Promise.resolve();
  shown = "Last page";

  expect((await watch.read(false)).texts).toEqual(["First page", "Loaded page", "Last page"]);
});

it("reads no field while a browser call may be typing in it: only between calls", async () => {
  const codes: string[] = [];
  const tab = page(
    frame("https://shop.test/", async (code) => {
      codes.push(code);
      return { lines: [], links: [], cut: false };
    }),
  );
  const { watch } = browserContext(tab);
  tab.emit("domcontentloaded");
  tab.emit("load");
  await watch.read(false);

  expect(codes).toEqual([readFrameCode(false), readFrameCode(false), readFrameCode(true)]);
});

it("stops on its last read, and holds nothing a page answers after it", async () => {
  let finish: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const main = frame("https://shop.test/", async () => {
    await slow;
    return { lines: ["Late words"], links: [], cut: false };
  });
  const tab = page(main);
  vi.useFakeTimers();
  try {
    const { context, watch } = browserContext(tab);
    const read = watch.read(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toEqual({ ...nothing, partial: true });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    context.emit("response", answer("https://shop.test/late", 200));
    tab.emit("load");
    expect(context.listenerCount("response")).toBe(0);
    expect(context.listenerCount("page")).toBe(0);
    expect(tab.listenerCount("load")).toBe(0);
    expect(tab.listenerCount("domcontentloaded")).toBe(0);
    expect(tab.listenerCount("framenavigated")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("reads the pages that answer, and says it's partial at the end when one never did", async () => {
  vi.useFakeTimers();
  try {
    const { watch } = browserContext(
      page(frame("https://shop.test/stuck", () => new Promise(() => undefined))),
      page(frame("https://shop.test/", walked(["Words"]))),
    );
    const read = watch.read(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toEqual({ ...nothing, texts: ["Words"] });
    const last = watch.read(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await last).toEqual({ ...nothing, texts: ["Words"], partial: true });
  } finally {
    vi.useRealTimers();
  }
});

it("spends no more time on a frame that didn't answer until it does, as behind a pop-up, and counts what it says then", async () => {
  vi.useFakeTimers();
  try {
    let answer: (value: unknown) => void = () => undefined;
    let reads = 0;
    const { watch } = browserContext(
      page(
        frame("https://shop.test/stuck", () => {
          reads += 1;
          return new Promise((resolve) => {
            answer = resolve;
          });
        }),
      ),
    );
    const first = watch.read(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toEqual(nothing);

    // No timer moves: this read doesn't wait for the frame.
    expect(await watch.read(false)).toEqual(nothing);
    expect(reads).toBe(1);

    answer({ lines: ["Late words"], links: [], cut: false });
    await vi.advanceTimersByTimeAsync(0);
    const third = watch.read(true);
    await vi.advanceTimersByTimeAsync(0);
    answer({ lines: ["Fresh words"], links: [], cut: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await third).toEqual({ ...nothing, texts: ["Late words", "Fresh words"] });
    expect(reads).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("gives a frame that's late one more chance on its last read", async () => {
  vi.useFakeTimers();
  try {
    let answer: (value: unknown) => void = () => undefined;
    let shown = "Early words";
    const { watch } = browserContext(
      page(
        frame("https://shop.test/late", () =>
          shown === "Early words"
            ? new Promise((resolve) => {
                answer = resolve;
              })
            : walked([shown])(""),
        ),
      ),
    );
    const first = watch.read(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toEqual(nothing);

    const last = watch.read(true);
    shown = "Last words";
    answer({ lines: ["Early words"], links: [], cut: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await last).toEqual({ ...nothing, texts: ["Early words", "Last words"] });
  } finally {
    vi.useRealTimers();
  }
});

it("takes a frame gone mid-read as gone, and any other failed read as partial", async () => {
  const gone = () => Promise.reject(new Error("Execution context was destroyed"));
  const { watch } = browserContext(page(frame("https://shop.test/", gone, gone)));
  expect(await watch.read(false)).toEqual(nothing);

  const broken = () => Promise.reject(new Error("Maximum call stack size exceeded"));
  const second = browserContext(page(frame("https://shop.test/", broken)));
  expect(await second.watch.read(false)).toEqual({ ...nothing, partial: true });
});

it("says a read is partial when code opened a context of its own, whose pages it doesn't hear", async () => {
  const { contexts, watch } = browserContext();
  expect(await watch.read(false)).toEqual(nothing);

  contexts.push({});
  expect(await watch.read(false)).toEqual({ ...nothing, partial: true });
});

it("says a read is partial when a page's answer doesn't read or its own read was cut", async () => {
  const nonsense = browserContext(page(frame("https://shop.test/", async () => ({ lines: 1 }))));
  expect(await nonsense.watch.read(false)).toEqual({ ...nothing, partial: true });

  const cut = browserContext(page(frame("https://shop.test/", walked(["Words"], [], true))));
  expect(await cut.watch.read(false)).toEqual({ ...nothing, texts: ["Words"], partial: true });
});

it("drops what doesn't fit, says so once, and starts afresh after handing it over", async () => {
  const huge = "x".repeat(17_000_000);
  let lines = ["Small words", huge];
  const { watch } = browserContext(page(frame("https://shop.test/", () => walked(lines)(""))));

  expect(await watch.read(false)).toEqual({ ...nothing, texts: ["Small words"], partial: true });
  lines = ["Next words"];
  expect(await watch.read(false)).toEqual({ ...nothing, texts: ["Next words"] });
});
