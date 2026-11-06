// Failure modes covered: a value the run holds reaching the host's report in an address, a link or a
// line, spaced as a page spaces it; the same line reported again on every browser call; a host left
// thinking a report is whole when the read failed; a hook that fails, throws, dies or never ends
// changing the run; an address reported as a link and so lost when the site answers it; a value over
// two lines split before it was masked; and a report lost because the watch couldn't start or the
// run ended first.
import { Effect, Exit, Fiber, Scope } from "effect";
import { expect, it } from "vitest";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { PagesSeen } from "../../src/runtime/operation-hooks.js";
import { watchingPages } from "../../src/standalone/pages-seen.js";

const nothing: PagesSeen = { answered: [], links: [], texts: [], partial: false };

/** A browser whose reads answer `reads` in turn, recording each read's `last`. */
const browser = (
  reads: readonly (PagesSeen | Error)[],
  watch: Effect.Effect<void, Error> = Effect.void,
) => {
  const lasts: boolean[] = [];
  return {
    lasts,
    watchPages: watch,
    readPages: (last: boolean) =>
      Effect.suspend(() => {
        const read = reads[lasts.length] ?? nothing;
        lasts.push(last);
        return read instanceof Error ? Effect.fail(read) : Effect.succeed(read);
      }),
  };
};

/** Watches on its own scope, reports `times` browser calls, and closes the scope. */
const watched = (
  site: ReturnType<typeof browser>,
  hear: (pages: PagesSeen) => Effect.Effect<void>,
  times = 1,
  secrets: Parameters<typeof watchingPages>[1] = makeRunSecrets(),
  lastHearingMs?: number,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const report = yield* watchingPages(site, secrets, hear, lastHearingMs).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      for (let call = 0; call < times; call++) yield* report;
      yield* Scope.close(scope, Exit.void);
    }),
  );

it("masks every address, link and line by the run's secrets, however a page spaces them", async () => {
  const secrets = makeRunSecrets();
  secrets.register("Secret Word");
  secrets.register("+919876543210", "phone");
  const heard: PagesSeen[] = [];
  await watched(
    browser([
      {
        answered: ["https://shop.test/verify?to=9876543210"],
        links: ["https://shop.test/users/Secret%20Word"],
        texts: ["  Hello   Secret   Word  ", "Sent to 98765 43210", "Ordinary   words"],
        partial: false,
      },
    ]),
    (pages) => Effect.sync(() => heard.push(pages)),
    1,
    secrets,
  );

  expect(heard).toEqual([
    {
      answered: ["https://shop.test/verify?to=[private]"],
      links: ["https://shop.test/users/[private]"],
      texts: ["Hello [private]", "Sent to [private]", "Ordinary words"],
      partial: false,
    },
  ]);
});

it("masks a value over two lines before it splits a page's text into its lines", async () => {
  const secrets = makeRunSecrets();
  secrets.register("12 Park Lane\nBhopal");
  const heard: PagesSeen[] = [];
  await watched(
    browser([{ ...nothing, texts: ["Deliver to\n12 Park Lane\nBhopal\nby Friday"] }]),
    (pages) => Effect.sync(() => heard.push(pages)),
    1,
    secrets,
  );

  expect(heard).toEqual([{ ...nothing, texts: ["Deliver to", "[private]", "by Friday"] }]);
});

it("reports each address, link and line once a run, and stays quiet when nothing is new", async () => {
  const first = { answered: ["https://a.test/"], links: ["https://a.test/b"], texts: ["Words"] };
  const heard: PagesSeen[] = [];
  await watched(
    browser([
      { ...first, partial: false },
      { ...first, partial: false },
      { ...first, texts: ["Words", "New  words", "New words"], partial: false },
    ]),
    (pages) => Effect.sync(() => heard.push(pages)),
    2,
  );

  expect(heard).toEqual([
    { ...first, partial: false },
    { ...nothing, texts: ["New words"] },
  ]);
});

it("reports an address in each list it comes to, as a link first and as answered later", async () => {
  const address = "https://a.test/cart";
  const heard: PagesSeen[] = [];
  await watched(
    browser([
      { ...nothing, links: [address] },
      { ...nothing, answered: [address], texts: [address] },
    ]),
    (pages) => Effect.sync(() => heard.push(pages)),
    2,
  );

  expect(heard).toEqual([
    { ...nothing, links: [address] },
    { ...nothing, answered: [address], texts: [address] },
  ]);
});

it("drops empty lines", async () => {
  const heard: PagesSeen[] = [];
  await watched(browser([{ ...nothing, texts: ["  ", "\n"] }]), (pages) =>
    Effect.sync(() => heard.push(pages)),
  );

  expect(heard).toEqual([]);
});

it("tells the host a report is partial when the page read says so, or when the read fails", async () => {
  const heard: PagesSeen[] = [];
  await watched(
    browser([{ ...nothing, partial: true }, new Error("The browser stopped")]),
    (pages) => Effect.sync(() => heard.push(pages)),
  );

  expect(heard).toEqual([
    { ...nothing, partial: true },
    { ...nothing, partial: true },
  ]);
});

it("tells the host when the watch never started, and reads nothing", async () => {
  const site = browser([], Effect.fail(new Error("The browser stopped")));
  const heard: PagesSeen[] = [];
  await watched(site, (pages) => Effect.sync(() => heard.push(pages)));

  expect(heard).toEqual([{ ...nothing, partial: true }]);
  expect(site.lasts).toEqual([]);
});

it("reads after each browser call, and once more as its scope closes", async () => {
  const site = browser([]);
  await watched(site, () => Effect.void, 2);

  expect(site.lasts).toEqual([false, false, true]);
});

it("leaves the run as it was when the host's hook fails or dies", async () => {
  await expect(
    watched(browser([{ ...nothing, texts: ["Words"] }]), () => Effect.die(new Error("It broke"))),
  ).resolves.toBeUndefined();
});

it("leaves the run as it was when the host's hook throws, as it reports, ends or can't start", async () => {
  const thrown = () => {
    throw new Error("It threw");
  };
  await expect(
    watched(browser([{ ...nothing, texts: ["Words"] }, { ...nothing, texts: ["More"] }]), thrown),
  ).resolves.toBeUndefined();
  await expect(
    watched(browser([], Effect.fail(new Error("The browser stopped"))), thrown),
  ).resolves.toBeUndefined();
});

it("reads once more when the run is interrupted, and tells the host", async () => {
  const site = browser([nothing, { ...nothing, texts: ["Last words"] }]);
  const heard: PagesSeen[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.scoped(
          watchingPages(site, makeRunSecrets(), (pages) =>
            Effect.sync(() => heard.push(pages)),
          ).pipe(Effect.flatMap((report) => report.pipe(Effect.zipRight(Effect.never)))),
        ),
      );
      yield* Effect.sleep(50);
      yield* Fiber.interrupt(fiber);
    }),
  );

  expect(site.lasts).toEqual([false, true]);
  expect(heard).toEqual([{ ...nothing, texts: ["Last words"] }]);
});

it("lets a run stop while the host's hook can't be stopped", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const report = yield* watchingPages(
        browser([{ ...nothing, texts: ["Words"] }]),
        makeRunSecrets(),
        () => Effect.uninterruptible(Effect.never),
        50,
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const fiber = yield* Effect.fork(report);
      yield* Effect.sleep(50);
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(scope, Exit.void);
    }),
  );
}, 3_000);

it("hears a report the worker handed over even when the run ends as it does", async () => {
  const heard: PagesSeen[] = [];
  const site = {
    watchPages: Effect.void,
    readPages: (last: boolean) =>
      Effect.uninterruptible(Effect.sleep(50)).pipe(
        Effect.as(last ? nothing : { ...nothing, answered: ["https://a.test/"] }),
      ),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const report = yield* watchingPages(site, makeRunSecrets(), (pages) =>
        Effect.sync(() => heard.push(pages)),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const fiber = yield* Effect.fork(Effect.uninterruptible(Effect.sleep(0)).pipe(Effect.zipRight(report)));
      yield* Effect.sleep(20);
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  expect(heard).toEqual([{ ...nothing, answered: ["https://a.test/"] }]);
});

it("closes the watch of a run interrupted just as it started", async () => {
  const lasts: boolean[] = [];
  const site = {
    watchPages: Effect.uninterruptible(Effect.sleep(50)),
    readPages: (last: boolean) =>
      Effect.sync(() => {
        lasts.push(last);
        return nothing;
      }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.scoped(watchingPages(site, makeRunSecrets(), () => Effect.void)),
      );
      yield* Effect.sleep(20);
      yield* Fiber.interrupt(fiber);
    }),
  );

  expect(lasts).toEqual([true]);
});

it("gives a last report its time after the read, and lets one it outlasts finish alone", async () => {
  const heard: string[] = [];
  const slowRead = {
    watchPages: Effect.void,
    readPages: () => Effect.sleep(80).pipe(Effect.as({ ...nothing, texts: ["Words"] })),
  };
  await watched(
    slowRead as never,
    () => Effect.sync(() => heard.push("read counted apart")),
    0,
    makeRunSecrets(),
    50,
  );
  expect(heard).toEqual(["read counted apart"]);

  await watched(
    browser([{ ...nothing, texts: ["Words"] }]),
    () => Effect.sleep(80).pipe(Effect.tap(() => Effect.sync(() => heard.push("went on")))),
    0,
    makeRunSecrets(),
    10,
  );
  expect(heard).toEqual(["read counted apart"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(heard).toEqual(["read counted apart", "went on"]);
});

it("stops waiting for a last report the host never finishes", async () => {
  const started = Date.now();
  await watched(
    browser([nothing, { ...nothing, texts: ["Words"] }]),
    () => Effect.never,
    1,
    makeRunSecrets(),
    50,
  );

  expect(Date.now() - started).toBeLessThan(5_000);
});
