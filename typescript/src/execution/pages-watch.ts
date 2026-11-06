import { Schema } from "effect";
import type { BrowserContext, Frame, Page, Response } from "playwright";
import type { PagesSeen } from "../runtime/operation-hooks.js";

/**
 * How long a read waits for one frame, as the progress read does for one page. All are read at once,
 * so a read ends well below its browser call's 10 seconds, since a browser call that times out can
 * leave the browser unusable.
 */
const frameReadMs = 3_000;
/** The most characters of one frame's lines and links one read takes. */
const frameChars = 4_000_000;
/** The most characters held between two reads, so a run's pages can't fill the worker. */
const heldChars = 16_000_000;

/**
 * One frame's words and links, for what a build could have copied from it, shown or not: its
 * rendered text, whole, for its host to split once it's masked; each run of text inline elements
 * share, in hidden elements, open shadow roots and templates too; a data block's text, though no
 * script's or style's; what names an element in an attribute; a meta tag's content and every `data-`
 * attribute; and, with `values`, each field's value. A field that holds a password, a card or a
 * one-time code gives its names alone. What doesn't fit is left out whole and the read says so, so
 * nothing the masks read is ever cut through. It reads the page's nodes by their prototypes, since
 * a form's own fields can hide its properties.
 */
export const readFrameCode = (values: boolean) => String.raw`(() => {
  const inline = new Set(["A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DFN", "EM", "FONT",
    "I", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME",
    "U", "VAR", "WBR"]);
  const naming = new Set(["alt", "aria-description", "aria-label", "aria-placeholder",
    "aria-roledescription", "label", "placeholder", "title"]);
  const code = /^(?:|module|(?:text|application)\/(?:x-)?(?:ecma|j|java|live)script[\d.]*)$/iu;
  const reader = (prototype, name) => {
    const { get } = Object.getOwnPropertyDescriptor(prototype, name);
    return (node) => get.call(node);
  };
  const typeOf = reader(Node.prototype, "nodeType");
  const childrenOf = reader(Node.prototype, "childNodes");
  const baseOf = reader(Node.prototype, "baseURI");
  const tagOf = reader(Element.prototype, "tagName");
  const attributesOf = reader(Element.prototype, "attributes");
  const shadowOf = reader(Element.prototype, "shadowRoot");
  const rootOf = reader(Document.prototype, "documentElement");
  const bodyOf = reader(Document.prototype, "body");
  const renderedOf = reader(HTMLElement.prototype, "innerText");
  const attribute = (element, name) => Element.prototype.getAttribute.call(element, name);
  const lines = [];
  const links = [];
  let room = ${frameChars};
  let cut = false;
  let run = "";
  const fits = (text) => {
    if (text.length <= room) {
      room -= text.length;
      return true;
    }
    cut = true;
    return false;
  };
  const add = (text) => {
    const line = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
    if (line !== "" && fits(line)) lines.push(line);
  };
  const end = () => {
    add(run);
    run = "";
  };
  const link = (href) => {
    let url;
    try {
      url = new URL(href, baseOf(document));
    } catch {
      return;
    }
    if (/^https?:$/u.test(url.protocol) && fits(url.href)) links.push(url.href);
  };
  const holdsSecret = (element) =>
    /^(?:file|password)$/iu.test(attribute(element, "type") ?? "") ||
    /\b(?:cc-|current-password|new-password|one-time-code)/iu.test(
      attribute(element, "autocomplete") ?? "",
    );
  const attributes = (element, field, secret) => {
    for (const { name, value } of attributesOf(element))
      if (naming.has(name)) add(value);
      else if (secret) continue;
      else if (name === "aria-valuetext" || name === "content" || name.startsWith("data-")) add(value);
      else if (name === "value" && (${values} || !field)) add(value);
    if (${values} && field && !secret) add(element.value);
  };
  const walk = (node) => {
    const type = typeOf(node);
    if (type === Node.TEXT_NODE || type === Node.CDATA_SECTION_NODE) {
      run += node.data;
      return;
    }
    if (type === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of childrenOf(node)) visit(child);
      return;
    }
    if (type !== Node.ELEMENT_NODE) return;
    const tag = tagOf(node).toUpperCase();
    if (tag === "STYLE") return;
    if (tag === "SCRIPT") {
      if (!code.test((attribute(node, "type") ?? "").trim())) add(node.textContent);
      return;
    }
    const field = tag === "INPUT" || tag === "TEXTAREA";
    const secret = field && holdsSecret(node);
    attributes(node, field, secret);
    // A textarea's text is its field's value too, as a page's script may keep it.
    if (secret || (tag === "TEXTAREA" && !${values})) return;
    if ((tag === "A" || tag === "AREA") && attribute(node, "href") !== null)
      link(attribute(node, "href"));
    const breaks = !inline.has(tag);
    if (breaks) end();
    const shadow = shadowOf(node);
    if (shadow !== null) visit(shadow);
    for (const child of childrenOf(node)) visit(child);
    if (tag === "TEMPLATE") visit(node.content);
    if (breaks) end();
  };
  const visit = (node) => {
    try {
      walk(node);
    } catch {
      cut = true;
    }
  };
  // A document on its way in has no root yet: it's read once it loaded.
  const root = rootOf(document);
  if (root !== null) visit(root);
  end();
  // An element that isn't drawn gives its source for its rendered text, scripts and all.
  const body = bodyOf(document);
  const drawn = body !== null && Element.prototype.getClientRects.call(body).length > 0;
  const rendered = drawn ? renderedOf(body) : "";
  if (rendered.trim() !== "" && fits(rendered)) lines.push(rendered);
  return { lines, links, cut };
})()`;

const FrameRead = Schema.Struct({
  lines: Schema.Array(Schema.String),
  links: Schema.Array(Schema.String),
  cut: Schema.Boolean,
});

/**
 * The accessible names in a Playwright aria snapshot, the names `getByRole` finds things by. The
 * snapshot writes a name as JSON, in a YAML key that it quotes in turn when the name needs it.
 */
export const accessibleNames = (snapshot: string) =>
  [...snapshot.matchAll(/^\s*- ('?)[\w-]+ "((?:[^"\\]|\\.)*)"/gmu)].flatMap(([, quoted, name]) => {
    try {
      const written = quoted === "'" ? (name ?? "").replaceAll("''", "'") : (name ?? "");
      return [JSON.parse(`"${written}"`) as string];
    } catch {
      return [];
    }
  });

/** Whether the site answered with success: a 304 says the address still has what it had. */
const answeredWithSuccess = (response: Response) => {
  const status = response.status();
  return ((status >= 200 && status < 300) || status === 304) &&
    // A preflight's yes says nothing of what the address answers.
    response.request().method() !== "OPTIONS";
};

/** The frame a navigation loads, unless Playwright can't tell yet, as for a new tab's first load. */
const loadingFrame = (response: Response) => {
  try {
    return response.request().isNavigationRequest() ? response.request().frame() : undefined;
  } catch {
    return undefined;
  }
};

const isPageAddress = (url: string) => /^https?:/iu.test(url);
const withoutFragment = (url: string) => url.split("#", 1)[0];
/** Why a read failed when the frame just went away, as a navigation takes one. */
const goneAway = /been closed|context was destroyed|detached|Target closed/iu;

/** Waits for `work`, or `ms` at most, and says whether it ended. */
const within = async (work: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return ended;
};

/**
 * Starts holding what `context`'s pages show and its site answers. It runs in the browser's worker
 * so that it hears every response, and page code never reaches what it holds. What it holds goes to
 * the host at the next read and no further. Each read runs between browser calls and reads every
 * page, and each page is also read as it loads, its fields aside, so one a browser call passes
 * through counts too, if it stays long enough to answer. What a page shows only between two of
 * those isn't read.
 */
export const watchPages = (context: BrowserContext) => {
  const held = {
    answered: new Set<string>(),
    links: new Set<string>(),
    texts: new Set<string>(),
  };
  let room = heldChars;
  let partial = false;
  let stopped = false;
  /** Whether each frame's document was answered with success, which its routes rest on. */
  const documents = new WeakMap<Frame, boolean>();
  /** Each frame's latest load, until it arrives: a download or a 204 never does. */
  const loading = new WeakMap<Frame, { readonly url: string; readonly answered: boolean }>();
  const reading = new Set<Promise<void>>();
  /**
   * Frames that outlasted their time, as a page behind a dialog does, each with its read. They're
   * read again once they answer, so no read but the last waits for them twice, and only one still
   * here at the end leaves the reports short.
   */
  const stuck = new Map<Frame, Promise<void>>();
  const hold = (into: Set<string>, value: string) => {
    if (stopped || into.has(value)) return;
    if (value.length > room) {
      partial = true;
      return;
    }
    room -= value.length;
    into.add(value);
  };
  const failed = (cause: unknown) => {
    if (!(cause instanceof Error && goneAway.test(cause.message))) partial = true;
  };
  const readFrame = async (frame: Frame, values: boolean) => {
    const [walked, snapshot] = await Promise.allSettled([
      frame.evaluate(readFrameCode(values)),
      // No time limit of its own: `stuck` tells a frame that's slow from one that never answers.
      frame.locator(":root").ariaSnapshot({ timeout: 0 }),
    ]);
    if (walked.status === "rejected") failed(walked.reason);
    else {
      const read = Schema.decodeUnknownOption(FrameRead)(walked.value);
      if (read._tag === "None" || read.value.cut) partial = true;
      if (read._tag === "Some") {
        for (const line of read.value.lines) hold(held.texts, line);
        for (const link of read.value.links) hold(held.links, link);
      }
    }
    if (snapshot.status === "rejected") failed(snapshot.reason);
    else for (const name of accessibleNames(snapshot.value)) hold(held.texts, name);
  };
  /** Reads `page`'s frames, each within its time. A frame that runs late still counts if it ends. */
  const readPage = (page: Page, values: boolean) => {
    const frames = page.frames().map(async (frame) => {
      if (stuck.has(frame)) return;
      let ended = false;
      const work = readFrame(frame, values).finally(() => {
        ended = true;
        stuck.delete(frame);
      });
      if (!(await within(work, frameReadMs)) && !ended) stuck.set(frame, work);
    });
    const read: Promise<void> = Promise.all(frames).then(
      () => {
        reading.delete(read);
      },
      () => {
        reading.delete(read);
      },
    );
    reading.add(read);
    return read;
  };
  const responded = (response: Response) => {
    const answered = answeredWithSuccess(response);
    const frame = loadingFrame(response);
    if (frame !== undefined) loading.set(frame, { url: response.url(), answered });
    if (answered && isPageAddress(response.url())) hold(held.answered, response.url());
  };
  // A route a page moves to itself has no response of its own: its document's answer stands.
  const navigated = (frame: Frame) => {
    const arrived = loading.get(frame);
    if (arrived !== undefined && withoutFragment(arrived.url) === withoutFragment(frame.url())) {
      documents.set(frame, arrived.answered);
      loading.delete(frame);
    }
    if (documents.get(frame) === true && isPageAddress(frame.url()))
      hold(held.answered, frame.url());
  };
  const watched = new Map<Page, () => void>();
  const watchPage = (page: Page) => {
    // A call may be typing as a page loads, and a field then holds part of a value no mask knows.
    const loaded = () => void readPage(page, false);
    page.on("framenavigated", navigated);
    // Twice, as a call that moves on at once can leave before a read begun at `load` ends.
    page.on("domcontentloaded", loaded);
    page.on("load", loaded);
    watched.set(page, () => {
      page.off("framenavigated", navigated);
      page.off("domcontentloaded", loaded);
      page.off("load", loaded);
    });
  };
  context.on("response", responded);
  context.on("page", watchPage);
  for (const page of context.pages()) watchPage(page);
  const stop = () => {
    stopped = true;
    context.off("response", responded);
    context.off("page", watchPage);
    for (const unwatch of watched.values()) unwatch();
    watched.clear();
    stuck.clear();
  };
  /** Reads every page, hands over all it holds, and with `last` stops watching. */
  const read = async (last: boolean): Promise<PagesSeen> => {
    if (last) await within(Promise.all(stuck.values()), frameReadMs);
    await Promise.all([...reading, ...context.pages().map((page) => readPage(page, true))]);
    // Page code can open a context of its own, whose pages this never hears.
    if ((context.browser()?.contexts().length ?? 1) > 1) partial = true;
    const seen = {
      answered: [...held.answered],
      links: [...held.links],
      texts: [...held.texts],
      partial: partial || (last && stuck.size > 0),
    };
    for (const values of Object.values(held)) values.clear();
    room = heldChars;
    partial = false;
    if (last) stop();
    return seen;
  };
  return { read, stop };
};
