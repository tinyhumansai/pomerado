import { normalizeText } from "../runtime/text.js";

/**
 * What showed an option's state: a native radio or checkbox's `checked`, one of the ARIA states,
 * one of the data attributes component libraries set, a class only the chosen option among its
 * like siblings carries, or the caller's own `chosen` sign.
 */
export type ChosenSign =
  | "checked"
  | "aria-checked"
  | "aria-selected"
  | "aria-pressed"
  | "aria-expanded"
  | "aria-current"
  | "data-state"
  | "data-selected"
  | "data-checked"
  | "data-active"
  | "class"
  | "chosen";

/** `chooseOne`'s answer when the option is chosen: whether it pressed it, its text and the sign. */
export interface Chosen {
  readonly chosen: true;
  readonly pressed: boolean;
  readonly label: string;
  readonly by: ChosenSign;
}

/** `chooseOne`'s answer for an option the page offers greyed out or says is not available. */
export interface ChoiceUnavailable {
  readonly chosen: false;
  readonly reason: "unavailable";
  readonly label: string;
}

export type ChooseOutcome = Chosen | ChoiceUnavailable;

/** One visible option as `readChoices` reads it; `chosen` and `by` are null when nothing shows. */
export interface ChoiceState {
  readonly label: string;
  readonly chosen: boolean | null;
  readonly unavailable: boolean;
  readonly by: Exclude<ChosenSign, "chosen"> | null;
}

/**
 * Page code for a Kernel call body, pasted after `waitCode` (./wait.ts), whose `waitForReady`,
 * `waitLimits`, `waitBounded`, `waitSleep` and `waitContextLost` it uses. It declares `chooseOne`
 * and `readChoices`, for one choice among several that a person makes by pressing it: a native
 * radio or its label, an ARIA radio, option or tab, a toggle button, a tile or chip, or an
 * accordion row whose open row is the choice. Pressing such an option again can undo it, as an
 * open accordion row closes, so they read the option's state before pressing and never press an
 * option that is already chosen.
 *
 * - `chooseOne(option, { chosen, unavailable, overlays, dismiss, timeout, deadline, holdMs }?)`
 *   takes the Playwright locator of the one option to choose, the element a person presses,
 *   anywhere a locator reaches: a frame from another origin through `frameLocator`, or an open
 *   shadow root. An option already chosen comes back as it is, `{ chosen: true, pressed: false,
 *   label, by }`. An option the page offers greyed out, disabled or saying it is not available,
 *   on two looks, comes back `{ chosen: false, reason: "unavailable", label }`, never pressed:
 *   `label` holds the page's own words, such as "Cash Not available at the moment". Otherwise
 *   it waits until the option is ready with `waitForReady` (a loader or another layer over it,
 *   a busy sign), passing it `overlays` and `dismiss`, presses it once, and waits until the page
 *   shows it chosen and keeps it so for `holdMs` (the settle window, 0.5 s), then returns
 *   `{ chosen: true, pressed: true, label, by }`. It never presses twice.
 * - `readChoices(options)` reads every visible match of a locator, such as each way to pay, as
 *   `{ label, chosen, unavailable, by }` in page order, pressing nothing.
 *
 * An option's state is the first of these that shows: the option's own `checked` or ARIA state
 * (`aria-checked`, `aria-selected`, `aria-pressed`, `aria-expanded`, `aria-current`); the radio
 * or checkbox it labels; the first radio, checkbox or ARIA-checked element inside it; the nearest
 * element around it, within its group, with an option's role or one of those states; another
 * ARIA state inside it; a `data-state`, `data-selected`, `data-checked` or `data-active`
 * attribute on it or around it; and last a class whose words say chosen (selected, active,
 * checked, chosen, current, open, expanded, on), on the option or on an element around it, that
 * only some of its like siblings carry, so a class every option carries counts for none. A page
 * that shows none of these, as tiles before any is chosen, leaves the state unknown: pass
 * `chosen`, a locator that shows only once this option is chosen (such as a summary naming it)
 * or an async function returning whether it is, which then decides alone.
 *
 * `unavailable` is a locator for the page's own sign that the option is not offered, beside the
 * option's own disabled state and its words "not available", "unavailable", "not serviceable" or
 * "not supported". `timeout` (the answer budget, 8 s) and `deadline`, a `Date.now()` time such as
 * the call's own, bound the whole choice, readiness included; the wait for the chosen state after
 * the press gets at least twice `holdMs` and a second, within the deadline.
 *
 * They throw an `Error` named `ChooseFailure` with a `reason`, and a message with counts, never
 * page text: `ambiguous` when several visible elements match (`visible`); `state_unknown` before
 * any press when the page shows no state for the option and no `chosen` is given; `press_failed`
 * when the click itself failed; `not_chosen` when, after the press, the page never showed it
 * chosen; and `reverted` when it showed it chosen and then took it back. A missing, hidden or
 * covered option fails as `waitForReady` fails (`ReadyWaitFailure`).
 */
export const chooseCode = String.raw`
const chooseFailure = (reason, message, details = {}) =>
  Object.assign(new Error(reason + ": " + message), { name: "ChooseFailure", reason, ...details });
// Runs in the page, or the frame the locator reaches: each match's visibility, text and state.
const chooseInPage = (elements) => {
  const normalize = ${String(normalizeText)};
  const shows = (element) =>
    (typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0) &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const parentOf = (node) =>
    node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const group = '[role=radiogroup], [role=listbox], [role=tablist], [role=menu], [role=menubar], [role=tree], [role=grid], [role=group], fieldset, form';
  const optionRole = '[role=radio], [role=option], [role=tab], [role=treeitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=switch], [role=row]';
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
    const current = node.getAttribute("aria-current");
    if (current !== null && current !== "") return { by: "aria-current", on: current !== "false" };
    return null;
  };
  const dataSign = (node) => {
    const state = node.getAttribute("data-state")?.toLowerCase();
    if (state !== undefined) {
      if (["checked", "on", "active", "selected", "open", "chosen"].includes(state)) return { by: "data-state", on: true };
      if (["unchecked", "off", "inactive", "unselected", "closed"].includes(state)) return { by: "data-state", on: false };
    }
    for (const name of ["data-selected", "data-checked", "data-active"]) {
      const value = node.getAttribute(name);
      if (value === "" || value === "true") return { by: name, on: true };
      if (value === "false") return { by: name, on: false };
    }
    return null;
  };
  // A class whose words say chosen: is-selected, tile--active, selectedTab; never unselected,
  // inactive or not-selected.
  const chosenWords = new Set(["selected", "active", "checked", "chosen", "current", "open", "expanded", "on"]);
  const notWords = new Set(["not", "un", "non", "no", "in", "de"]);
  const saysChosen = (token) => {
    const words = token.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return words.some((word) => chosenWords.has(word)) && !words.some((word) => notWords.has(word));
  };
  const plainClasses = (node) => [...node.classList].filter((token) => !saysChosen(token)).sort().join(" ");
  // Siblings of the same kind: the same tag and the same classes but for the chosen ones.
  const peersOf = (node) => {
    const parent = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode : null);
    if (parent === null) return [];
    const own = plainClasses(node);
    return [...parent.children].filter((other) => other !== node && other.localName === node.localName && plainClasses(other) === own);
  };
  // A chosen class only some like siblings carry. Alone, an option's own chosen class counts.
  const classSign = (node, needsPeers) => {
    const own = [...node.classList].filter(saysChosen);
    const peers = peersOf(node);
    if (peers.length === 0) return !needsPeers && own.length > 0 ? { by: "class", on: true } : null;
    if (own.some((token) => peers.some((peer) => !peer.classList.contains(token)))) return { by: "class", on: true };
    const marked = peers.flatMap((peer) => [...peer.classList].filter(saysChosen));
    return marked.some((token) => !node.classList.contains(token)) ? { by: "class", on: false } : null;
  };
  const around = (element, levels) => {
    const nodes = [];
    for (let node = parentOf(element), depth = 0; node !== null && depth < levels; node = parentOf(node), depth += 1) {
      if (node === document.body || node === document.documentElement || node.matches(group)) break;
      nodes.push(node);
    }
    return nodes;
  };
  const stateOf = (element) => {
    const sources = [element];
    if (element.localName === "label" && element.control) sources.push(element.control);
    const checkable = element.querySelector('input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [role=switch], [role=menuitemradio], [role=menuitemcheckbox], [aria-checked]');
    if (checkable !== null) sources.push(checkable);
    const owner = around(element, 4).find((node) => node.matches(optionRole) || stateNames.some((name) => node.hasAttribute(name)));
    if (owner !== undefined) sources.push(owner);
    const inner = element.querySelector("[aria-selected], [aria-pressed], [aria-expanded], [aria-current]");
    if (inner !== null) sources.push(inner);
    for (const source of sources) {
      const sign = strong(source);
      if (sign !== null) return sign;
    }
    for (const source of [element, ...around(element, 2)]) {
      const sign = dataSign(source);
      if (sign !== null) return sign;
    }
    const classed = classSign(element, false) ?? around(element, 2).map((node) => classSign(node, true)).find((sign) => sign !== null);
    return classed ?? { by: null, on: null };
  };
  const unavailableWords = /\b(?:not|isn['’]t)\s+(?:currently\s+)?available\b|\bunavailable\b|\bnot serviceable\b|\bnot supported\b/i;
  const unavailableOf = (element, text) => {
    for (const node of [element, ...around(element, 3)])
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true" || node.hasAttribute("inert")) return true;
    const control = element.localName === "label" ? element.control : element.querySelector("input[type=radio], input[type=checkbox]");
    // A disabled fieldset disables the radio without marking its own attribute.
    if (control?.matches(":disabled") === true) return true;
    if (getComputedStyle(element).pointerEvents === "none") return true;
    return unavailableWords.test(text);
  };
  const nameOf = (element) =>
    normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.querySelector("img[alt]")?.getAttribute("alt") ?? "");
  return elements.map((element) => {
    if (!shows(element)) return { visible: false };
    const text = normalize(String(element.innerText ?? element.textContent ?? ""));
    const sign = stateOf(element);
    return {
      visible: true,
      label: (text === "" ? nameOf(element) : text).slice(0, 200),
      on: sign.on,
      by: sign.by,
      unavailable: unavailableOf(element, text),
      busy: element.closest('[aria-busy="true"]') !== null,
    };
  });
};
// One look at the option: its one visible match's state, or how many matched and showed.
const chooseLook = async (option, ms) => {
  try {
    const reading = option.evaluateAll(chooseInPage);
    reading.catch(() => undefined);
    const states = await waitBounded(reading, Math.max(1, ms));
    if (states === undefined) return { matched: 0, visible: 0 };
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
  const begun = Date.now();
  const until = Math.min(begun + timeout, options.deadline ?? Infinity);
  const left = () => Math.max(1, until - Date.now());
  const sign = options.chosen;
  // The caller's own sign of the choice: a locator that shows, or a function's answer.
  const signShows = async () => {
    if (typeof sign === "function") return Boolean(await sign());
    return (await sign.filter({ visible: true }).count()) > 0;
  };
  const offered = async (state) =>
    !state.unavailable && (options.unavailable === undefined || (await options.unavailable.filter({ visible: true }).count()) === 0);
  let look = await chooseLook(option, left());
  if (look.visible > 1) throw chooseFailure("ambiguous", look.visible + " visible elements match", { visible: look.visible });
  if (look.state === undefined) {
    // Not there yet: wait for it as for any control, then look again.
    await waitForReady(option, { overlays: options.overlays, dismiss: options.dismiss, watch: false, timeout: left(), deadline: until });
    look = await chooseLook(option, left());
    if (look.visible > 1) throw chooseFailure("ambiguous", look.visible + " visible elements match", { visible: look.visible });
    if (look.state === undefined) throw chooseFailure("not_found", look.matched + " matched, " + look.visible + " visible", { matched: look.matched });
  }
  // A greyed-out option, on two looks with nothing busy, is the page's answer: never pressed.
  while (!(await offered(look.state))) {
    await waitSleep(300);
    const again = await chooseLook(option, left());
    if (again.state !== undefined && !again.state.busy && !(await offered(again.state)))
      return { chosen: false, reason: "unavailable", label: again.state.label };
    if (again.state !== undefined) look = again;
    if (Date.now() >= until) return { chosen: false, reason: "unavailable", label: look.state.label };
  }
  const chosenNow = async (state) => (sign === undefined ? state.on : (await signShows()) ? true : null);
  const already = await chosenNow(look.state);
  if (already === true) return { chosen: true, pressed: false, label: look.state.label, by: sign === undefined ? look.state.by : "chosen" };
  if (already === null && sign === undefined)
    throw chooseFailure("state_unknown", "the page shows no state for the option; pass chosen", {});
  await waitForReady(option, { overlays: options.overlays, dismiss: options.dismiss, watch: false, timeout: left(), deadline: until });
  // Readiness may have waited out a change: look once more before pressing.
  const ready = await chooseLook(option, left());
  if (ready.state !== undefined) {
    if ((await chosenNow(ready.state)) === true)
      return { chosen: true, pressed: false, label: ready.state.label, by: sign === undefined ? ready.state.by : "chosen" };
    if (!(await offered(ready.state))) return { chosen: false, reason: "unavailable", label: ready.state.label };
  }
  try {
    await option.click({ timeout: Math.min(waitLimits.action, left()) });
  } catch (error) {
    throw chooseFailure("press_failed", "the click failed: " + String(error?.message ?? error).split("\n")[0], {});
  }
  const pressedAt = Date.now();
  const confirmUntil = Math.min(options.deadline ?? Infinity, Math.max(until, pressedAt + 2 * holdMs + 1000));
  let shownSince;
  let lostSince;
  let label = (ready.state ?? look.state).label;
  while (true) {
    const now = Date.now();
    const seen = await chooseLook(option, Math.max(1, confirmUntil - now));
    const state = seen.state;
    let on = null;
    if (state !== undefined) {
      label = state.label;
      on = await chosenNow(state);
      if (on === true) {
        shownSince ??= Date.now();
        lostSince = undefined;
        if (Date.now() - shownSince >= holdMs)
          return { chosen: true, pressed: true, label, by: sign === undefined ? state.by : "chosen" };
      } else if (shownSince !== undefined) {
        lostSince ??= Date.now();
        if (Date.now() - lostSince >= holdMs)
          throw chooseFailure("reverted", "the page showed the option chosen, then took it back", {});
      }
    }
    if (Date.now() >= confirmUntil) {
      if (on === true) return { chosen: true, pressed: true, label, by: sign === undefined ? state.by : "chosen" };
      if (shownSince !== undefined) throw chooseFailure("reverted", "the page showed the option chosen, then took it back", {});
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
