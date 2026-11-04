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
  /** Once, just before the operation's own code starts. */
  readonly started?: () => Effect.Effect<void>;
  /**
   * After each browser call the operation's code makes, a fingerprint of the browser's pages: the
   * same pages showing the same text give the same fingerprint, so a host can tell a run that stays
   * on one page. The script's next call waits for it. A page that can't be read reports nothing.
   */
  readonly progress?: (fingerprint: string) => Effect.Effect<void>;
  /**
   * The operation entered a commit step. Its next call that can reach the site waits until this
   * succeeds. A failure refuses that call and every later one, and fails the run with the step
   * unsent, unless an earlier click already sent it. The wait counts against the run's time.
   */
  readonly commit?: (entered: EnteredCommit) => Effect.Effect<void, unknown>;
}

export { commitReportLimitBytes } from "./commit-report.js";

/** How long the progress read waits for one page before it reads it as unanswered. */
const pageReadMs = 3_000;

/**
 * One browser call that reads each page of the context: its address, and its title with the size
 * and a digest of its visible text, or null for a page that didn't answer in time. The digest is
 * taken in the page, so no text leaves it.
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
  return [tab.url(), shown];
};
const pages = [];
for (const tab of context.pages()) pages.push(await read(tab));
return pages;`;

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
