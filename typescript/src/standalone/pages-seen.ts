import { createHash } from "node:crypto";
import { Effect, Fiber, type Scope } from "effect";
import type { PlaywrightExecutor } from "../execution/playwright-execute.js";
import type { RunSecrets } from "../inputs/secrets.js";
import type { OperationHooks, PagesSeen } from "../runtime/operation-hooks.js";

const nothing: PagesSeen = { answered: [], links: [], texts: [], partial: false };
/** A report that says only that this one holds less than the browser saw. */
const unread: PagesSeen = { ...nothing, partial: true };

/**
 * Tells `hear` what the browser saw for as long as the scope lasts, and gives back the read to run
 * after each browser call. The host hears each address, link and line once, masked as a model's
 * text is, and every report goes out as soon as it's read: the fork keeps only a digest of each, to
 * tell what's new, and drops those with the scope. A value a page shows before the run learns it
 * goes out unmasked, as it does anywhere else, and so does one a page breaks over two lines or
 * elements, as a value any mask reads must stand whole.
 *
 * Neither a read that fails nor a hook that fails or dies changes the run. A failed read is reported
 * as `partial`. The scope closes with a last read, which then waits `lastHearingMs` at most for the
 * hook, and leaves one that takes longer to finish alone.
 */
export const watchingPages = (
  browser: Pick<PlaywrightExecutor, "watchPages" | "readPages">,
  secrets: Pick<RunSecrets, "redact">,
  hear: NonNullable<OperationHooks["seen"]>,
  lastHearingMs = 10_000,
): Effect.Effect<Effect.Effect<void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Apart, since a host tells an address a page links to from one the site answered.
    const reported = {
      answered: new Set<string>(),
      links: new Set<string>(),
      texts: new Set<string>(),
    };
    const fresh = (digests: Set<string>) => (value: string) => {
      const digest = createHash("sha256").update(value).digest("base64");
      if (digests.has(digest)) return false;
      digests.add(digest);
      return true;
    };
    // Masked as the page wrote it and again as spaced here, since a value matches only one of them.
    const masked = (text: string) =>
      secrets.redact(secrets.redact(text).replaceAll(/\s+/gu, " ").trim());
    const screened = (pages: PagesSeen): PagesSeen => ({
      answered: pages.answered.map(secrets.redact).filter(fresh(reported.answered)),
      links: pages.links.map(secrets.redact).filter(fresh(reported.links)),
      // A page's rendered text comes whole, so a value over two lines is masked before they part.
      texts: pages.texts
        .flatMap((text) => secrets.redact(text).split("\n"))
        .map(masked)
        .filter((text) => text !== "")
        .filter(fresh(reported.texts)),
      partial: pages.partial,
    });
    /**
     * Starts the hook on its own, so a report the worker handed over reaches the host even as the
     * run ends, and a hook that can't be stopped holds up nothing. Undefined with nothing to tell.
     */
    const telling = (pages: PagesSeen) =>
      pages.answered.length + pages.links.length + pages.texts.length === 0 && !pages.partial
        ? Effect.succeed(undefined)
        : Effect.forkDaemon(
            Effect.suspend(() => hear(pages)).pipe(
              // error-reporting-allow: typed-recovery a report is the host's own view of the pages; a hook that dies hears no more of this one and the run stands
              Effect.catchAllCause(() => Effect.void),
            ),
          );
    const report = (last: boolean) =>
      Effect.uninterruptibleMask((restore) =>
        browser.readPages(last).pipe(
          Effect.map(screened),
          // error-reporting-allow: typed-recovery a read that fails leaves the run as it was; the host hears only that this report holds less
          Effect.catchAllCause(() => Effect.succeed(unread)),
          Effect.flatMap(telling),
          Effect.flatMap((hearing) =>
            hearing === undefined
              ? Effect.void
              : last
                ? Effect.interruptible(Fiber.await(hearing)).pipe(
                    Effect.timeoutOption(lastHearingMs),
                    Effect.asVoid,
                  )
                : restore(Fiber.await(hearing)).pipe(Effect.asVoid),
          ),
        ),
      );
    const started = yield* Effect.acquireRelease(
      browser.watchPages.pipe(
        Effect.as(true),
        // error-reporting-allow: typed-recovery a watch that can't start leaves the run as it was; the host hears only that it saw nothing
        Effect.catchAllCause(() => telling(unread).pipe(Effect.as(false))),
      ),
      (watching) =>
        (watching ? report(true) : Effect.void).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const digests of Object.values(reported)) digests.clear();
            }),
          ),
        ),
    );
    return started ? report(false) : Effect.void;
  });
