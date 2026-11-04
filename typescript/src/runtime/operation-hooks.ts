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
}

/**
 * A host's hooks into one operation run. Each is optional, and a run without them runs as before.
 */
export interface OperationHooks {
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
   * The operation entered a commit step. Its next call that can reach the site, and every later
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
