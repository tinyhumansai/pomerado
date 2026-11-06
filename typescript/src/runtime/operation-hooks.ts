import { createHash } from "node:crypto";
import { Schema, type Effect } from "effect";

/** A commit step the operation's script entered, as its host's commit hook hears it. */
export interface EnteredCommit {
  /** The step's name, one of the write's `write.commits`. */
  readonly name: string;
  /**
   * What the script passed with the step, read from the page just before its click, such as the
   * button's text and the total. Absent when it passed nothing.
   */
  readonly report?: unknown;
  /**
   * A call that can reach the site was already out as the script entered the step: the host still
   * held or ran it, or the script still awaited its answer. No refusal takes back one that went
   * through, such as a click the script didn't wait for, so a host that refuses the step can stop
   * the run at once and still know that the site may see it. False when every earlier call was
   * answered, so the site sees nothing past the step until the host accepts it.
   */
  readonly callOut: boolean;
}

/**
 * What the browser saw since the last report, for a host that compares accounts: only what the
 * site answered and its pages showed, so a value that shows on one account alone stands out. Each
 * address, link and line comes once a run, masked by the session's secrets. The fork keeps none of
 * it: a host that wants the whole of what a run saw puts the reports together itself.
 */
export interface PagesSeen {
  /**
   * The http and https addresses the site answered with success, whole: every page and every
   * request of a page, whatever its host, and each route a page moved to in a document that was
   * answered with success. An address that redirected, failed or was refused isn't one.
   */
  readonly answered: readonly string[];
  /** The http and https addresses the pages' links point to, each resolved, shown or not. */
  readonly links: readonly string[];
  /**
   * The pages' words, a line each: their text, hidden and inline data included but no script or
   * style, what names an element, each field's value but a password's, a card's or a one-time
   * code's, and each accessible name.
   */
  readonly texts: readonly string[];
  /**
   * What the reports hold is less than the browser showed: a read failed, there was too much to
   * hold, page code opened a context of its own or, on the last report, a frame never answered. A
   * page that answers late isn't: what it says comes in a later report. A host that needs all of
   * it treats the run as unread.
   */
  readonly partial: boolean;
}

/** A host's hooks into one mint. Each is optional, and a mint without them runs as before. */
export interface MintHooks {
  /**
   * What the browser saw (`PagesSeen`), from before the first page until the call ends: after each
   * browser call the operation's code makes, when that shows anything new, and once more before
   * the call returns or fails, a failed one included, so nothing comes after it. A page that loads
   * inside a browser call counts too, but for its fields' values, which only a read between calls
   * takes, as a call may be typing; one that changes without loading shows as the next read finds
   * it. A hook that fails, throws or dies hears no more of that report, and the run goes on. A
   * last report the hook doesn't finish within seconds goes on alone, after the call returned. The
   * script's next call waits for this as it does for `progress`, so a host keeps it short.
   */
  readonly seen?: (pages: PagesSeen) => Effect.Effect<void>;
}

/**
 * A host's hooks into one operation run. Each is optional, and a run without them runs as before.
 */
export interface OperationHooks extends MintHooks {
  /**
   * Once, before the child starts the operation's script, so before the runtime's first sign-in
   * check. It counts against the run's time: a run whose deadline passes first fails without
   * starting the script.
   */
  readonly started?: () => Effect.Effect<void>;
  /**
   * After each browser call the operation's code makes, a fingerprint of the browser's pages: the
   * same pages showing the same text give the same fingerprint, so a host can tell a run that stays
   * on one page. The script's next call waits for it. A page that can't be read reports nothing,
   * and neither does a hook that fails or dies: the call stands.
   */
  readonly progress?: (fingerprint: string) => Effect.Effect<void>;
  /**
   * The operation entered a commit step, with whether a call that can reach the site was already
   * out then (`EnteredCommit.callOut`). Its next call that can reach the site, and every later
   * one, waits until this succeeds, and the wait counts against the run's time. A failure, a
   * defect, a throw or an interruption refuses the step: no held call goes through from then on,
   * even one waiting on an earlier step's answer, and the run fails `CommitRefused` without
   * waiting for answers still to come, even when its script already returned. Its journal is the
   * one from just before the first step the host had not accepted, since every call after it was
   * held; when a call that can reach the site was already out as the script entered that step,
   * it is the one that entered it, with the step sent. Once the run ends otherwise, at its
   * deadline, by the child's error or exit, or by its caller's interruption, no held call goes
   * through either, and while a step's answer was pending the run reports that step's journal
   * the same way.
   */
  readonly commit?: (entered: EnteredCommit) => Effect.Effect<void, unknown>;
}

export { commitReportDepthLimit, commitReportLimitBytes } from "./commit-report.js";

/** How long the progress read waits for one page before it reads it as unanswered. */
const pageReadMs = 3_000;
/**
 * How long the progress read waits for all pages: well below its browser call's 10 seconds, since
 * a browser call that times out can leave the browser unusable.
 */
const progressReadMs = 4_000;

/**
 * One browser call that reads all pages of the context at once: each page's address, and its
 * title with the size and a digest of its visible text, or null for a page that didn't answer in
 * time. The digest is taken in the page, so no text leaves it.
 */
export const pageProgressCode = `const read = async (tab) => {
  let timer;
  const shown = await Promise.race([
    tab
      .evaluate(() => {
        const text = document.body ? document.body.innerText : "";
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index++) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        return [document.title, text.length, hash >>> 0];
      })
      .catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ${pageReadMs});
    }),
  ]);
  clearTimeout(timer);
  return shown;
};
const tabs = context.pages();
const shown = tabs.map(() => null);
let timer;
await Promise.race([
  Promise.all(
    tabs.map(async (tab, index) => {
      shown[index] = await read(tab);
    }),
  ),
  new Promise((resolve) => {
    timer = setTimeout(resolve, ${progressReadMs});
  }),
]);
clearTimeout(timer);
return tabs.map((tab, index) => [tab.url(), shown[index]]);`;

const PageReads = Schema.Array(
  Schema.Tuple(
    Schema.String,
    Schema.NullOr(Schema.Tuple(Schema.String, Schema.Number, Schema.Number)),
  ),
);

/** The fingerprint of what `pageProgressCode` read, or undefined when it read nothing usable. */
export const pageFingerprint = (result: unknown): string | undefined => {
  const pages = Schema.decodeUnknownOption(PageReads)(result);
  if (pages._tag === "None" || pages.value.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(pages.value)).digest("hex").slice(0, 32);
};
