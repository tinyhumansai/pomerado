import { Schema } from "effect";
import { normalizeText } from "../runtime/text.js";

/** What showed an option's state, as `readChoices` reads it: never the caller's own sign. */
const PageSign = Schema.Literal(
  "checked",
  "aria-checked",
  "aria-selected",
  "aria-pressed",
  "aria-expanded",
  "aria-current",
  "data-state",
  "data-selected",
  "data-checked",
  "data-active",
  "class",
);

/**
 * What showed an option's state: a native radio or checkbox's `checked`, one of the ARIA states,
 * one of the data attributes component libraries set, a class only the chosen option among its
 * like options carries, or the caller's own `chosen` sign.
 */
export type ChosenSign = typeof PageSign.Type | "chosen";

/**
 * `chooseOne`'s answer: chosen, with whether it pressed the option, its text and what showed it
 * chosen; or, for an option the page offers greyed out or says is not available, `unavailable`
 * with its text. Decode a call's result with it.
 */
export const ChooseOutcome = Schema.Union(
  Schema.Struct({
    chosen: Schema.Literal(true),
    pressed: Schema.Boolean,
    label: Schema.String,
    by: Schema.Union(PageSign, Schema.Literal("chosen")),
  }),
  Schema.Struct({ chosen: Schema.Literal(false), reason: Schema.Literal("unavailable"), label: Schema.String }),
);
export type ChooseOutcome = typeof ChooseOutcome.Type;
export type Chosen = Extract<ChooseOutcome, { readonly chosen: true }>;
export type ChoiceUnavailable = Extract<ChooseOutcome, { readonly chosen: false }>;

/**
 * `readChoices`' answer: each visible option, its text, whether it is chosen and what showed it,
 * both null when the page shows no state, and whether the page offers it greyed out.
 */
export const ChoiceStates = Schema.Array(
  Schema.Struct({
    label: Schema.String,
    chosen: Schema.NullOr(Schema.Boolean),
    unavailable: Schema.Boolean,
    by: Schema.NullOr(PageSign),
  }),
);
export type ChoiceState = (typeof ChoiceStates.Type)[number];

/**
 * Page code for a Kernel call body, pasted after `waitCode` (./wait.ts), whose `waitForReady`,
 * `waitProgress`, `waitLimits`, `waitBounded`, `waitSleep` and `waitContextLost` it uses. It
 * declares `chooseOne` and `readChoices`, for one choice among several that a person makes by
 * pressing it: a native radio or its label, an ARIA radio, option or tab, a toggle button, a tile
 * or chip, or an accordion row whose open row is the choice. Pressing such an option again can
 * undo it, as an open accordion row closes, so they read the option's state before pressing and
 * never press an option that is already chosen.
 *
 * - `chooseOne(option, { chosen, unavailable, overlays, dismiss, timeout, deadline, holdMs,
 *   unchangedMs }?)` takes the Playwright locator of the one option to choose, the element a
 *   person presses, anywhere a locator reaches: a frame from another origin through
 *   `frameLocator`, or an open shadow root. It looks until one visible element matches, as for an
 *   option a frame still loading draws late. An option already chosen comes back as it is, `{
 *   chosen: true, pressed: false, label, by }`, even one the page greys out, such as the current
 *   tab. An option the page offers greyed out, disabled or saying it is not available comes back
 *   `{ chosen: false, reason: "unavailable", label }`, never pressed, once it has stayed so while
 *   the page showed no progress for `unchangedMs` (2 s) and nothing kept it busy, the `overlays`
 *   showing among them, since pages grey an option out for a moment while they recalculate:
 *   `label` holds the page's own words, such as "Cash Not available at the moment". Otherwise it
 *   waits until the option is ready with `waitForReady` (a loader or another layer over it, a busy
 *   sign), passing it `overlays` and `dismiss`, looks at it again, presses it once, and waits until
 *   the page shows it chosen and keeps it so for `holdMs` (the settle window, 0.5 s), then returns
 *   `{ chosen: true, pressed: true, label, by }`. It never presses twice.
 * - `readChoices(options)` reads every visible match of a locator, such as each way to pay, as
 *   `{ label, chosen, unavailable, by }` in page order, pressing nothing.
 *
 * An option's state is the first of these that shows: the option's own `checked` or ARIA state
 * (`aria-checked`, `aria-selected`, `aria-pressed`, `aria-expanded`, or `aria-current` unless it
 * names a date or a time, which mark today or now); the radio or checkbox it labels; the `checked`
 * or `aria-checked` of its own radio inside it, or else of its own checkbox or ARIA-checked
 * element, and never another state inside it, such as a toggle's `aria-expanded`; the nearest
 * element around it with an option's role or one of those states; a `data-state` of checked, on,
 * active, selected or chosen (or their opposites), or a `data-selected`, `data-checked` or
 * `data-active` attribute, on it or around it; a class that says chosen, on it or around it; and
 * last a `data-state` of open or closed on the option itself, unless it is one a person presses,
 * where that shows a tooltip or a hover card's trigger and says nothing. An `aria-expanded` says
 * whether a disclosure is open, not which option is chosen: when false, the option's own data
 * attribute or class says first, and when true beside a like option a class shows chosen, the state
 * is unknown. A control inside the option whose label or own text has words, none of them the
 * option's first text, such as a "Save card" checkbox in a chosen row's panel, belongs to the
 * option's content and is never its own, and so does one named only by an `aria-label` or a
 * `title`, unless that name is the option's first text or, on a radio, holds it as whole words, as
 * "Pay by UPI" does on the UPI row.
 *
 * An element around the option counts only below the first that holds another option: another of
 * the locator's visible matches, which `readChoices` reads as the other options; when the option is
 * one a person presses, or sits in one below that element, another element a person presses (a
 * button, a link, a label, a field, a disclosure's summary, an option or an element that takes
 * focus); another element like it (the same tag and the same classes but for the chosen ones and
 * those that only add to another of its classes, as way--upi adds to way, a class that starts with
 * a chosen word read as its rest, or the same option role); another element of the same tag, with
 * text or a name, beside the one on the way down to the option, as options side by side are
 * whatever their classes, such as the class CSS-in-JS generates for each, unless the element around
 * is a button, a link, a label or a summary, whose parts are its own; or, unless it is itself one a
 * person presses, such as a tile, whose controls are its own, anything at all when its first text
 * lies outside the way down to the option, as a step's heading above its one button gives it a
 * title of its own, and otherwise another element a person presses, unless the option is a child of
 * it and the options like it sit outside, as a row's own Edit button beside its header. Inside an
 * element with an option's own role, such as a radio, beyond the first two only another element
 * with an option's role is another option. It never counts past a group or a container (a dialog, a
 * tab or accordion panel, a section, a disclosure or a list), so none of these around several
 * options gives their state. `chooseOne` sees only its one match, so an element around it can still
 * give its state to plain options side by side that differ in tag or depth, or to a button beside a
 * plain option; `readChoices` sees all its matches. An element marked active around one button and
 * nothing else reads as chosen, since a step around its one button has the shape of a list item
 * around its link.
 *
 * A class says chosen when its whole name, or its last part after "--", "__", "-" or "_" or its
 * last capitalised word, is selected, active, checked, chosen or expanded with no negation just
 * before it, as in is-selected, tile--active or isSelected; when the local part of a name in the
 * CSS Modules shape (Name_local__hash) does, as in Tile_selected__x7f3a; or when its first part
 * before "-" or "_" is one of these words and its rest a class the option or the options like it
 * carry, as selected-slot beside slot; never a word inside a name, as in has-active-offer or
 * not-selected-slot, nor a name holding ":" or "[", as Tailwind variants such as hover:btn-active
 * do. It counts only when some of the options like it lack it, so a class every option carries,
 * such as selected-items-count, never does, and an option with none like it never has a class sign.
 * Neither has a slider's part (a class with the word swiper, slick, owl, carousel, splide, glide or
 * slider), whose active class marks the slide in view, and an element around the option says
 * expanded only when it holds more than the option. A class can't be told from a highlight, as on
 * the row under the pointer or the keyboard, by its words: a page that highlights by such a class
 * and shows nothing else reads the highlighted option as chosen. It is unknown when something says
 * otherwise, a like option carrying another chosen class or showing another sign of being chosen,
 * or when it runs over several options from the first, as a rating's filled stars do; an option
 * with no such class still reads unchosen. A page that shows none of these, as tiles before any is
 * chosen, leaves the state unknown: pass `chosen`, a locator that shows only once this option is
 * chosen (such as a summary naming it) or an async function returning whether it is, which then
 * decides alone.
 *
 * `unavailable` is a locator for the page's own sign that the option is not offered, beside the
 * option's own disabled state and its words "not available", "unavailable", "not serviceable" or
 * "not supported" on a line after its first, or in an element apart from its label, such as a note
 * beside it, never in the label itself, as in "Refund unavailable items". `timeout` (the answer
 * budget, 8 s) and `deadline`, a `Date.now()` time such as the call's own, bound the whole choice
 * up to the press, readiness included; the wait for the chosen state after the press gets at least
 * twice `holdMs` and a second, within the deadline, and one look even when the deadline has passed.
 *
 * They throw an `Error` named `ChooseFailure` with a `reason`, and a message with counts, never
 * page text: `ambiguous` when several visible elements match (`visible`); `not_found` when no
 * visible element matched by the deadline (`matched`, `visible`); `state_unknown` before any press
 * when the page shows no state for the option and no `chosen` is given; `timeout` before any press
 * when the deadline came first: a greyed-out option still waiting on the page, a look at the option
 * that never answered, no time left to press, or a click the deadline cut short; `press_failed`
 * when the click itself failed before the deadline; `not_chosen` when, after the press, the page
 * never showed it chosen; and `reverted` when it showed it chosen and then took it back. An option
 * that stays covered or busy fails as `waitForReady` fails (`ReadyWaitFailure`).
 */
export const chooseCode = String.raw`
const chooseFailure = (reason, message, details = {}) =>
  Object.assign(new Error(reason + ": " + message), { name: "ChooseFailure", reason, ...details });
// How long the first look after the press may take, even past the deadline.
const chooseFirstLookMs = 1000;
// Runs in the page, or the frame the locator reaches: each match's visibility, text and state.
const chooseInPage = (elements) => {
  const normalize = ${String(normalizeText)};
  const shows = (element) =>
    (typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0) &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const rendered = (node) => typeof node.checkVisibility !== "function" || node.checkVisibility();
  const parentOf = (node) =>
    node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const group = '[role=radiogroup], [role=listbox], [role=tablist], [role=menu], [role=menubar], [role=tree], [role=grid], [role=group], fieldset, form';
  // Elements that hold a part of the page and never one option: a dialog, a tab or accordion
  // panel, a section, a disclosure or a list.
  const container = '[role=dialog], [role=alertdialog], [role=tabpanel], [role=region], [role=list], dialog, section, details, ul, ol';
  const optionRole = '[role=radio], [role=option], [role=tab], [role=treeitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=switch], [role=row]';
  // The option roles that never hold other options, as a row or a tree item can.
  const leafRole = '[role=radio], [role=option], [role=tab], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=switch]';
  // What a person presses: a button, a link, a label, a field, a disclosure's summary, an option or
  // an element that takes focus.
  const pressable = 'button, a[href], label, summary, input:not([type=hidden]), select, textarea, [role=button], [role=link], [tabindex]:not([tabindex^="-"]), ' + optionRole;
  // What a person presses as one, whose parts are all its own: a button, a link, a label or a
  // disclosure's summary.
  const onePress = 'button, a[href], label, summary, [role=button], [role=link]';
  const radios = 'input[type=radio], [role=radio], [role=menuitemradio]';
  const checkables = 'input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [role=switch], [role=menuitemradio], [role=menuitemcheckbox], [aria-checked]';
  const stateNames = ["aria-checked", "aria-selected", "aria-pressed", "aria-expanded"];
  // The option's own state, or null when it shows none.
  const strong = (node) => {
    if (node.localName === "input" && (node.type === "radio" || node.type === "checkbox"))
      return { by: "checked", on: node.checked };
    for (const name of stateNames) {
      const value = node.getAttribute(name);
      if (value === "true") return { by: name, on: true };
      if (value === "false" || value === "mixed") return { by: name, on: false };
    }
    // A current date or time marks today or now, whichever day or time is chosen.
    const current = node.getAttribute("aria-current");
    if (current !== null && current !== "" && current !== "date" && current !== "time")
      return { by: "aria-current", on: current !== "false" };
    return null;
  };
  // The checked state of a radio, checkbox or ARIA-checked element, and nothing else it shows.
  const checkedSign = (node) => {
    if (node.localName === "input" && (node.type === "radio" || node.type === "checkbox"))
      return { by: "checked", on: node.checked };
    const value = node.getAttribute("aria-checked");
    if (value === "true") return { by: "aria-checked", on: true };
    if (value === "false" || value === "mixed") return { by: "aria-checked", on: false };
    return null;
  };
  const dataSign = (node) => {
    const state = node.getAttribute("data-state")?.toLowerCase();
    if (state !== undefined) {
      if (["checked", "on", "active", "selected", "chosen"].includes(state)) return { by: "data-state", on: true };
      if (["unchecked", "off", "inactive", "unselected"].includes(state)) return { by: "data-state", on: false };
    }
    for (const name of ["data-selected", "data-checked", "data-active"]) {
      const value = node.getAttribute(name);
      if (value === "" || value === "true") return { by: name, on: true };
      if (value === "false") return { by: name, on: false };
    }
    return null;
  };
  // A data-state of open or closed, as a disclosure shows it: it says little about a choice, so it
  // counts only on the option itself, never on a panel around it, and only when no class says
  // otherwise. On what a person presses, whose own aria-expanded came first, it shows a tooltip or
  // a hover card's trigger, closed until the pointer comes, so it says nothing.
  const openSign = (node) => {
    if (node.matches(pressable)) return null;
    const state = node.getAttribute("data-state")?.toLowerCase();
    if (state === "open") return { by: "data-state", on: true };
    if (state === "closed") return { by: "data-state", on: false };
    return null;
  };
  // A class whose name says chosen: the whole name, or its last part after "--", "__", "-" or "_"
  // or its last capitalised word, is one of these words with no negation just before it, as in
  // is-selected, tile--active or isSelected; a name in the CSS Modules shape, Name_local__hash, as
  // Tile_selected__x7f3a, says it by its local part too, since its hash comes last; a name whose
  // first part is one of them says it only beside the class its rest names (chosenStart). Never a
  // word inside a name, as in has-active-offer, not-selected-slot or selectedTab, nor a name
  // holding ":" or "[", as Tailwind variants such as hover:btn-active do. On and open name much
  // besides a choice, as a menu that is open does, and current marks where a person is, as the
  // page they are on.
  const chosenWords = new Set(["selected", "active", "checked", "chosen", "expanded"]);
  const notWords = new Set(["not", "un", "non", "no", "in", "de"]);
  const wordsOf = (name) => name.split(/[-_]+/).filter(Boolean)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .map((word) => word.toLowerCase());
  const endsChosen = (name) => {
    const words = wordsOf(name);
    return words.length > 0 && chosenWords.has(words.at(-1)) && !notWords.has(words.at(-2) ?? "");
  };
  const saysChosen = (token) => {
    if (/[:[]/.test(token)) return false;
    const local = /^[A-Za-z][A-Za-z0-9-]*_([A-Za-z][\w-]*)__[\w-]{5,}$/.exec(token)?.[1];
    return endsChosen(token) || (local !== undefined && endsChosen(local));
  };
  // A class whose first part, before "-" or "_", is one of these words, as selected-slot: the rest
  // of its name, or null. It says chosen only when the option or the options like it carry a class
  // of that name, as slot, so selected-items-count, which names a count, never does.
  const chosenStart = (token) => {
    const parts = /^([A-Za-z]+)[-_]+([A-Za-z][\w-]*)$/.exec(token);
    return parts !== null && chosenWords.has(parts[1].toLowerCase()) ? parts[2] : null;
  };
  // The classes that name the node's kind: all but the chosen ones and those that only add to
  // another of its classes, as way--upi adds to way, with one that starts with a chosen word read
  // as its rest, as selected-slot as slot, so options alike but for a class of their own count as
  // alike.
  const plainClasses = (node) => {
    const tokens = [...new Set([...node.classList].filter((token) => !saysChosen(token)).map((token) => chosenStart(token) ?? token))];
    return tokens.filter((token) => !tokens.some((base) => token.startsWith(base + "-") || token.startsWith(base + "_")))
      .sort().join(" ");
  };
  // The elements in root, and its open shadow root, like the node: the same tag and the same plain
  // classes, or the same option role.
  const likeIn = (root, node) => {
    const own = plainClasses(node);
    const role = node.matches(optionRole) ? node.getAttribute("role") : null;
    const tag = /^[a-z][a-z0-9-]*$/.test(node.localName) ? node.localName : "*";
    const selector = role === null ? tag : tag + ', [role="' + role + '"]';
    const found = [];
    for (const scope of root.shadowRoot ? [root, root.shadowRoot] : [root])
      for (const other of scope.querySelectorAll(selector))
        if (other !== node && !other.contains(node) && !node.contains(other) &&
            ((other.localName === node.localName && plainClasses(other) === own) ||
              (role !== null && other.getAttribute("role") === role)))
          found.push(other);
    return found;
  };
  // The options like the node: those in the nearest element around it that holds any, up to 5
  // levels up and up to a group, which may hold them.
  const peersOf = (node) => {
    for (let root = parentOf(node), depth = 0; root !== null && depth < 5; root = parentOf(root), depth += 1) {
      if (root === document.documentElement) break;
      const likes = likeIn(root, node);
      if (likes.length > 0) return likes;
      if (root === document.body || root.matches(group)) break;
    }
    return [];
  };
  // Whether node sits inside root, through open shadow roots too.
  const inside = (root, node) => {
    for (let at = parentOf(node); at !== null; at = parentOf(at)) if (at === root) return true;
    return false;
  };
  // Whether another element of the child's tag sits beside it and shows text or a name, as options
  // side by side do whatever their classes, such as the class CSS-in-JS generates for each; an icon
  // hidden from assistive technology, such as an icon font's ligature, shows neither.
  const repeats = (child) =>
    [...(child.parentNode?.children ?? [])].some((other) => other !== child && other.localName === child.localName &&
      other.getAttribute("aria-hidden") !== "true" && (other.textContent.trim() !== "" || nameOf(other) !== ""));
  // Whether root holds another option besides the element, reached through child, root's child on
  // the way down to it. Anywhere it is another of matches, the locator's other visible matches,
  // which readChoices reads as the options, or, when the element is one a person presses or sits in
  // one below root (not plain), another element a person presses. Inside an element with an
  // option's own role, one option whose parts may look alike, it is otherwise only another element
  // with an option's role. Elsewhere it is another element like the element; another element of
  // child's tag beside child, unless root is pressed as one (onePress), whose parts are its own; or,
  // unless root is itself one a person presses, such as a tile, whose controls are its own: anything
  // when root's first text lies outside child, as a step's heading shows it has a title of its own;
  // and otherwise another element a person presses, unless root is the element's parent and options
  // like it sit outside root, as a row's own Edit button sits beside its header.
  const holdsOther = (root, element, child, matches, plain, likeOutside) => {
    const scopes = root.shadowRoot ? [root, root.shadowRoot] : [root];
    const apart = (other) => other !== element && !other.contains(element) && !element.contains(other);
    const another = (selector) => scopes.some((scope) => [...scope.querySelectorAll(selector)].some(apart));
    if (matches.some((other) => apart(other) && inside(root, other)) || (!plain && another(pressable))) return true;
    if (root.matches(leafRole)) return another(optionRole);
    if (likeIn(root, element).length > 0) return true;
    if (root.matches(onePress)) return false;
    if (repeats(child)) return true;
    if (root.matches(pressable)) return false;
    const first = firstText(root);
    if (first !== null && !child.contains(first)) return true;
    if (child === element && likeOutside()) return false;
    return another(pressable);
  };
  // The elements around the option that are its own, nearest first: up to levels of them, below
  // the first that holds another option, and never a group, a container or the body.
  const ownAround = (element, levels, matches) => {
    const nodes = [];
    let plain = !element.matches(pressable);
    let liked;
    const likeOutside = () => (liked ??= peersOf(element).length > 0);
    for (let child = element, node = parentOf(element), depth = 0; node !== null && depth < levels; child = node, node = parentOf(node), depth += 1) {
      if (node === document.body || node === document.documentElement || node.matches(group) || node.matches(container)) break;
      if (holdsOther(node, element, child, matches, plain, likeOutside)) break;
      nodes.push(node);
      plain &&= !node.matches(pressable);
    }
    return nodes;
  };
  // The words of a slider's parts, whose active class marks the slide in view, never a choice.
  const sliderWords = new Set(["swiper", "slick", "owl", "carousel", "splide", "glide", "slider"]);
  // Whether the node holds nothing beside one element, as a row that takes the width by a class
  // saying expanded does, where an expanded disclosure's row also holds its panel.
  const holdsOne = (node) => node.children.length < 2 &&
    ![...node.childNodes].some((inner) => inner.nodeType === Node.TEXT_NODE && inner.data.trim() !== "");
  // A chosen class only some of the node's like options carry: one that says chosen, or one that
  // starts with a chosen word whose rest is a class the node or its like options carry. A node with
  // none like it has no class sign, so a lone option's own class never counts, and neither has a
  // slider's part. A highlight, as on the row under the pointer or the keyboard, reads as one of
  // these, and only another sign tells them apart: a class read as chosen is unknown when a like
  // option carries another chosen class or shows another sign of being chosen, as one of them is a
  // highlight and the words don't say which, or when it runs from the first like option over
  // several, as a rating's filled stars do. A node with no such class is still not the chosen one.
  const classSign = (node, element) => {
    const peers = peersOf(node);
    if (peers.length === 0 || [...node.classList].some((token) => wordsOf(token).some((word) => sliderWords.has(word)))) return null;
    const all = [node, ...peers];
    const carried = new Set(all.flatMap((one) => [...one.classList]));
    const marksOf = (one) => [...one.classList].filter((token) => (saysChosen(token) || carried.has(chosenStart(token))) &&
      !(node !== element && token.toLowerCase().includes("expanded") && holdsOne(one)));
    const own = marksOf(node).filter((token) => peers.some((peer) => !peer.classList.contains(token)));
    const lacks = peers.flatMap(marksOf).some((token) => !node.classList.contains(token));
    if (own.length === 0) return lacks ? { by: "class", on: false } : null;
    const ordered = all.sort((one, other) => (one.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const runs = (token) => {
      const count = ordered.findIndex((one) => !one.classList.contains(token));
      return count > 1 && ordered.slice(count).every((one) => !one.classList.contains(token));
    };
    if (lacks || peers.some((peer) => strong(peer)?.on === true || dataSign(peer)?.on === true) || own.every(runs))
      return { by: null, on: null };
    return { by: "class", on: true };
  };
  const around = (element, levels) => {
    const nodes = [];
    for (let node = parentOf(element), depth = 0; node !== null && depth < levels; node = parentOf(node), depth += 1) {
      if (node === document.body || node === document.documentElement || node.matches(group)) break;
      nodes.push(node);
    }
    return nodes;
  };
  const nameWords = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // The option's own radio inside it, or else its own checkbox or ARIA-checked element. A control
  // whose label or own text has words, none of them the option's first text, such as a "Save card"
  // checkbox in a chosen row's panel, belongs to the option's content, never to its state. So does
  // one named only by an aria-label or a title, unless that name is the option's first text or, on
  // a radio, holds it as whole words, as "Pay by UPI" does on the UPI row; words that only overlap,
  // as "Save card" on the Card row, are the control's own.
  const ownCheckable = (element) => {
    const start = firstText(element);
    const first = start === null ? "" : nameWords(start.data);
    for (const selector of [radios, checkables])
      for (const control of element.querySelectorAll(selector)) {
        const ids = (control.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
        const names = [...(control.labels ?? []), ...ids.map((id) => control.getRootNode().getElementById?.(id)), control]
          .filter((name) => name && name.textContent.trim() !== "");
        const said = nameWords(control.getAttribute("aria-label") ?? control.getAttribute("title") ?? "");
        const namedOwn = said === "" || said === first || (control.matches(radios) && (" " + said + " ").includes(" " + first + " "));
        if (start === null || (names.length === 0 && namedOwn) || names.some((name) => name.contains(start))) return control;
      }
    return null;
  };
  const stateOf = (element, matches) => {
    const sign = strong(element) ?? (element.localName === "label" && element.control ? strong(element.control) : null);
    if (sign !== null && sign.by !== "aria-expanded") return sign;
    // An aria-expanded says whether a disclosure is open, not which option is chosen: the option's
    // own data attribute or class says first when closed, and unknown when open beside a like option
    // a class shows chosen.
    if (sign !== null) {
      const said = dataSign(element) ?? classSign(element, element);
      if (sign.on) return said?.on === false ? { by: null, on: null } : sign;
      return said ?? sign;
    }
    const checkable = ownCheckable(element);
    const checked = checkable === null ? null : checkedSign(checkable);
    if (checked !== null) return checked;
    const own = ownAround(element, 4, matches);
    const owner = own.find((node) => node.matches(optionRole) || strong(node) !== null);
    const owned = owner === undefined ? null : strong(owner);
    if (owned !== null) return owned;
    const near = [element, ...own.slice(0, 2)];
    for (const read of [dataSign, classSign])
      for (const node of near) {
        const found = read(node, element);
        if (found !== null) return found;
      }
    return openSign(element) ?? { by: null, on: null };
  };
  const unavailableWords = /\b(?:not|isn['’]t)\s+(?:currently\s+)?available\b|\bunavailable\b|\bnot serviceable\b|\bnot supported\b/i;
  // The option's first shown text, where its label starts; an icon font's ligature hidden from
  // assistive technology is none.
  const firstText = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.data.trim() !== "") return child;
      if (child.nodeType === Node.ELEMENT_NODE && rendered(child) && child.getAttribute("aria-hidden") !== "true") {
        const found = firstText(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  // Words saying the option is not offered count on a line after its first, or in an element
  // apart from its label, such as a note beside it; never in the label, as in "Refund unavailable
  // items".
  const saysUnavailable = (element) => {
    const lines = normalize(String(element.innerText ?? ""), { lines: true }).split("\n");
    if (lines.slice(1).some((line) => unavailableWords.test(line))) return true;
    const label = firstText(element);
    if (label === null) return false;
    for (const node of element.querySelectorAll("*"))
      if (!node.contains(label) && rendered(node) && unavailableWords.test(normalize(String(node.innerText ?? ""))))
        return true;
    return false;
  };
  const unavailableOf = (element) => {
    for (const node of [element, ...around(element, 3)])
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true" || node.hasAttribute("inert")) return true;
    const control = element.localName === "label" ? element.control : element.querySelector("input[type=radio], input[type=checkbox]");
    // A disabled fieldset disables the radio without marking its own attribute.
    if (control?.matches(":disabled") === true) return true;
    if (getComputedStyle(element).pointerEvents === "none") return true;
    return saysUnavailable(element);
  };
  const nameOf = (element) =>
    normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.querySelector("img[alt]")?.getAttribute("alt") ?? "");
  // The visible matches: readChoices reads each as an option, and the others as its other options.
  const options = elements.filter(shows);
  return elements.map((element) => {
    if (!options.includes(element)) return { visible: false };
    const text = normalize(String(element.innerText ?? element.textContent ?? ""));
    const sign = stateOf(element, options);
    return {
      visible: true,
      label: (text === "" ? nameOf(element) : text).slice(0, 200),
      on: sign.on,
      by: sign.by,
      unavailable: unavailableOf(element),
      busy: element.closest('[aria-busy="true"]') !== null,
    };
  });
};
// One look at the option: its one visible match's state, or how many matched and showed, and
// late when the look had no answer in time.
const chooseLook = async (option, ms) => {
  try {
    const reading = option.evaluateAll(chooseInPage);
    reading.catch(() => undefined);
    const states = Number.isFinite(ms) ? await waitBounded(reading, Math.max(1, ms)) : await reading;
    if (states === undefined) return { matched: 0, visible: 0, late: true };
    const visible = states.filter((state) => state.visible);
    return { matched: states.length, visible: visible.length, state: visible.length === 1 ? visible[0] : undefined };
  } catch (error) {
    if (!waitContextLost(error)) throw error;
    return { matched: 0, visible: 0 };
  }
};
const chooseOne = async (option, options = {}) => {
  if (option === null || typeof option !== "object" || typeof option.evaluateAll !== "function")
    throw new TypeError("chooseOne needs the option's Playwright locator");
  const timeout = options.timeout ?? waitLimits.answer;
  const holdMs = options.holdMs ?? waitLimits.settle;
  const unchangedMs = options.unchangedMs ?? waitLimits.unchanged;
  const begun = Date.now();
  const until = Math.min(begun + timeout, options.deadline ?? Infinity);
  const left = () => Math.max(1, until - Date.now());
  const overlays = options.overlays === undefined ? [] : [options.overlays].flat();
  const loading = overlays.length === 0 ? undefined : overlays.slice(1).reduce((all, overlay) => all.or(overlay), overlays[0]);
  const sign = options.chosen;
  // The caller's own sign of the choice: a locator that shows, or a function's answer.
  const signShows = async () => {
    if (typeof sign === "function") return Boolean(await sign());
    return (await sign.filter({ visible: true }).count()) > 0;
  };
  const offered = async (state) =>
    !state.unavailable && (options.unavailable === undefined || (await options.unavailable.filter({ visible: true }).count()) === 0);
  const chosenNow = async (state) => (sign === undefined ? state.on : (await signShows()) ? true : null);
  const byOf = (state) => (sign === undefined ? state.by : "chosen");
  // Looks until one visible element matches, as for an option a frame still loading draws late.
  const lookOne = async () => {
    while (true) {
      const look = await chooseLook(option, left());
      if (look.visible > 1) throw chooseFailure("ambiguous", look.visible + " visible elements match", { visible: look.visible });
      if (look.state !== undefined) return look;
      if (Date.now() >= until) {
        if (look.late) throw chooseFailure("timeout", "no look at the option answered within " + (Date.now() - begun) + " ms", {});
        throw chooseFailure("not_found", look.matched + " matched, " + look.visible + " visible", { matched: look.matched, visible: look.visible });
      }
      await waitSleep(100);
    }
  };
  // A greyed-out option is the page's answer once it stays so while the page shows no progress for
  // unchangedMs and nothing keeps it busy, the named overlays among them: pages grey an option out
  // for a moment while they recalculate. It ends with the last look, unavailable or offered again.
  const greyedWait = async (look) => {
    const progress = waitProgress({ loading, unchangedMs });
    const started = Date.now();
    try {
      progress.begin();
      while (true) {
        const sampling = progress.sample([]);
        sampling.catch(() => undefined);
        await (Number.isFinite(until) ? waitBounded(sampling, left()) : sampling);
        const seen = await chooseLook(option, left());
        if (seen.visible > 1) throw chooseFailure("ambiguous", seen.visible + " visible elements match", { visible: seen.visible });
        if (seen.state !== undefined) {
          look = seen;
          if ((await chosenNow(seen.state)) === true || (await offered(seen.state))) return { look };
          if (!seen.state.busy && progress.quietMs() >= unchangedMs && !progress.busy()) return { look, unavailable: true };
        }
        if (Date.now() >= until)
          throw chooseFailure("timeout", "the option was still greyed out after " + (Date.now() - started) +
            " ms, with the page busy or not yet quiet for " + unchangedMs + " ms", {});
        await waitSleep(100);
      }
    } finally {
      await progress.stop();
    }
  };
  let look = await lookOne();
  let ready = false;
  while (true) {
    // Chosen comes first: an option the page greys out once chosen, such as the current tab, is chosen.
    if ((await chosenNow(look.state)) === true)
      return { chosen: true, pressed: false, label: look.state.label, by: byOf(look.state) };
    if (!(await offered(look.state))) {
      const greyed = await greyedWait(look);
      look = greyed.look;
      if (greyed.unavailable) return { chosen: false, reason: "unavailable", label: look.state.label };
      ready = false;
      continue;
    }
    if (sign === undefined && look.state.on === null)
      throw chooseFailure("state_unknown", "the page shows no state for the option; pass chosen", {});
    if (ready) break;
    await waitForReady(option, { overlays: options.overlays, dismiss: options.dismiss, watch: false, timeout: left(), deadline: until });
    ready = true;
    // Readiness may have waited out a change: look again before pressing, never pressing blind.
    look = await lookOne();
  }
  if (Date.now() >= until)
    throw chooseFailure("timeout", "no time was left to press the option after " + (Date.now() - begun) + " ms", {});
  try {
    await option.click({ timeout: Math.min(waitLimits.action, left()) });
  } catch (error) {
    // A click the deadline cut short fails as the deadline's, not the click's.
    if (Date.now() >= until)
      throw chooseFailure("timeout", "the deadline came before the click on the option was done, after " + (Date.now() - begun) + " ms", {});
    throw chooseFailure("press_failed", "the click failed: " + String(error?.message ?? error).split("\n")[0], {});
  }
  const pressedAt = Date.now();
  const confirmUntil = Math.min(options.deadline ?? Infinity, Math.max(until, pressedAt + 2 * holdMs + 1000));
  let shownSince;
  let lostSince;
  let shown = false;
  let label = look.state.label;
  for (let looks = 0; ; looks += 1) {
    const ms = confirmUntil - Date.now();
    const seen = await chooseLook(option, looks === 0 ? Math.max(chooseFirstLookMs, ms) : ms);
    const state = seen.state;
    let on = null;
    if (state !== undefined) {
      label = state.label;
      on = await chosenNow(state);
      if (on === true) {
        shownSince ??= Date.now();
        lostSince = undefined;
        shown = true;
        if (Date.now() - shownSince >= holdMs) return { chosen: true, pressed: true, label, by: byOf(state) };
      } else if (shown) {
        // A sign that comes back must hold for holdMs again.
        shownSince = undefined;
        lostSince ??= Date.now();
        if (Date.now() - lostSince >= holdMs)
          throw chooseFailure("reverted", "the page showed the option chosen, then took it back", {});
      }
    }
    if (Date.now() >= confirmUntil) {
      if (on === true) return { chosen: true, pressed: true, label, by: byOf(state) };
      if (shown) throw chooseFailure("reverted", "the page showed the option chosen, then took it back", {});
      throw chooseFailure("not_chosen", "the page never showed the option chosen after one press", {});
    }
    await waitSleep(50);
  }
};
const readChoices = async (locator) => {
  if (locator === null || typeof locator !== "object" || typeof locator.evaluateAll !== "function")
    throw new TypeError("readChoices needs the options' Playwright locator");
  const states = await locator.evaluateAll(chooseInPage);
  return states.filter((state) => state.visible)
    .map((state) => ({ label: state.label, chosen: state.on, unavailable: state.unavailable, by: state.by }));
};
`;
