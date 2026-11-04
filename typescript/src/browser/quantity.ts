/** `setQuantity`'s answer once the line holds the quantity asked for. */
export interface QuantitySet {
  readonly set: true;
  readonly quantity: number;
  readonly presses: number;
}

/** `setQuantity`'s answer when the site takes no more: its `+` greyed out, or its limit sign shown. */
export interface QuantityLimited {
  readonly set: false;
  readonly reason: "limit";
  readonly quantity: number;
  readonly presses: number;
}

export type QuantityOutcome = QuantitySet | QuantityLimited;

/**
 * Page code for a Kernel call body, pasted after `waitCode` (./wait.ts), whose `waitForReady`,
 * `waitProgress`, `waitLimits`, `waitSleep` and `waitContextLost` it uses. It declares
 * `setQuantity`, which sets a line's quantity with the site's own stepper, as a person does: one
 * press at a time, each answered before the next. Many sites cover the stepper with a loader after
 * each press and drop a press made under it, or post each press as its own cart write, so pressing
 * several times at once loses presses or adds too many.
 *
 * `setQuantity({ count, increase, decrease, add }, quantity, { overlays, loading, dismiss, limit,
 * maxSteps, region, siteDomain, noProgressMs, holdMs, timeout, deadline }?)` takes Playwright
 * locators for the element showing the line's count (text holding the number, or an input), the
 * `+` and `−` controls, and, when the line has none yet, the control that adds the first one, such
 * as ADD. The count is the first whole number the element shows; a line with no count and the
 * `add` control showing holds none. Each step waits until its control is ready with `waitForReady`
 * (`overlays` and `dismiss` pass to it, so a loader over the stepper is waited out), reads the
 * count again, presses once, and waits until the count shows its next value and keeps it for
 * `holdMs` (the settle window, 0.5 s) with no `loading` sign showing (by default the `overlays`).
 * It returns `{ set: true, quantity, presses }`.
 *
 * The site's limit ends it with `{ set: false, reason: "limit", quantity, presses }`, `quantity`
 * being what the line holds: the control for the next step greyed out (disabled, `aria-disabled`)
 * and still so, with no loading sign, after `unchangedMs` (2 s), since many sites grey their steps
 * out for a moment while they save the last one; or the site's own `limit` sign showing after a
 * press that left the count as it was, at once when it is new and once the count has stayed put
 * for `unchangedMs` when it showed before the press. A press with no answer within `answerCap`
 * (30 s) of progress is never repeated, and each
 * step's wait for the count shares the page-progress budget the waits use (`noProgressMs`, default
 * 8 s, `region` and `siteDomain` as there).
 *
 * It throws an `Error` named `QuantityFailure` with a `reason` and the numbers, never page text:
 * `too_many_steps` before any press when the count is more than `maxSteps` (20) away from the
 * quantity asked for; `count_unknown` when it can't read a count and no `add` shows;
 * `count_ambiguous` when the count locator has several visible matches; `press_failed` when the
 * click failed; `not_changed` when a press left the count as it was, with no progress and no
 * `limit` sign, for `unchangedMs` (2 s); and `unexpected_count` when a press moved the count
 * anywhere but one step on (`quantity` read, `expected`). Each carries `quantity`, the line's count
 * at that point, and `presses`. A control that never gets ready fails as `waitForReady` fails.
 */
export const quantityCode = String.raw`
const quantityFailure = (reason, message, details = {}) =>
  Object.assign(new Error(reason + ": " + message), { name: "QuantityFailure", reason, ...details });
// Runs in the page: the count's one visible match as a number, or why there is none.
const quantityInPage = (elements) => {
  const shows = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0;
  const visible = elements.filter(shows);
  if (visible.length === 0) return { state: "absent" };
  if (visible.length > 1) return { state: "ambiguous", visible: visible.length };
  const element = visible[0];
  if (element.closest('[aria-busy="true"]') !== null) return { state: "loading" };
  const raw = ["input", "select", "textarea"].includes(element.localName) ? element.value : element.innerText;
  const number = /\d+/.exec(String(raw ?? ""));
  return number === null ? { state: "loading" } : { state: "shown", value: Number(number[0]) };
};
// Runs in the page: whether the control's one visible match is greyed out.
const quantityGreyedInPage = (elements) => {
  const shows = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0;
  const visible = elements.filter(shows);
  if (visible.length !== 1) return false;
  const element = visible[0];
  return element.matches(":disabled") || element.closest('[aria-disabled="true"], [inert]') !== null;
};
const quantityShows = async (locator) =>
  locator !== undefined && (await locator.filter({ visible: true }).count()) > 0;
const setQuantity = async (stepper, quantity, options = {}) => {
  for (const name of ["count", "increase", "decrease"])
    if (stepper?.[name] === undefined || typeof stepper[name].evaluateAll !== "function")
      throw new TypeError("setQuantity needs the stepper's " + name + " as a Playwright locator");
  if (stepper.add !== undefined && typeof stepper.add.evaluateAll !== "function")
    throw new TypeError("setQuantity needs the stepper's add as a Playwright locator");
  if (!Number.isInteger(quantity) || quantity < 0) throw new TypeError("setQuantity needs a whole quantity of 0 or more");
  const maxSteps = options.maxSteps ?? 20;
  const holdMs = options.holdMs ?? waitLimits.settle;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const unchangedMs = options.unchangedMs ?? waitLimits.unchanged;
  const stepTimeout = options.timeout ?? waitLimits.answerCap;
  const deadline = options.deadline ?? Infinity;
  const overlays = options.overlays === undefined ? [] : [options.overlays].flat();
  const loading = options.loading ??
    (overlays.length === 0 ? undefined : overlays.slice(1).reduce((all, overlay) => all.or(overlay), overlays[0]));
  const read = async () => {
    let count;
    try {
      count = await stepper.count.evaluateAll(quantityInPage);
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      return { loading: true };
    }
    if (count.state === "shown") return { quantity: count.value };
    if (count.state === "ambiguous")
      throw quantityFailure("count_ambiguous", count.visible + " visible elements match the count", {});
    if (count.state === "loading") return { loading: true };
    return (await quantityShows(stepper.add)) ? { quantity: 0 } : { missing: true };
  };
  // The line's count before the first step, once the page shows one.
  const start = Date.now();
  const startUntil = Math.min(start + noProgressMs, deadline);
  let current;
  while (current === undefined) {
    const seen = await read();
    current = seen.quantity;
    if (current !== undefined) break;
    if (Date.now() >= startUntil)
      throw quantityFailure("count_unknown", "no count and no add control show", { presses: 0 });
    await waitSleep(100);
  }
  if (Math.abs(quantity - current) > maxSteps)
    throw quantityFailure("too_many_steps", Math.abs(quantity - current) + " steps away, over maxSteps " + maxSteps,
      { quantity: current, presses: 0 });
  let presses = 0;
  const limited = () => ({ set: false, reason: "limit", quantity: current, presses });
  // After one press: the count's next value once it holds, or the press left it as it was. A
  // limit sign already showing before the press counts only once the count stays put.
  const settle = async (before, down, progress, until, limitBefore) => {
    let last = before;
    let since;
    while (true) {
      const seen = await read();
      // A line removed by its last − shows no count; with no add control named it holds none.
      const value = seen.quantity ?? (seen.missing && down && before === 1 && stepper.add === undefined ? 0 : undefined);
      await progress.sample(value !== undefined && value !== last ? ["count changed"] : []);
      if (value !== undefined && value !== last) since = undefined;
      if (value !== undefined) last = value;
      const now = Date.now();
      if (value !== undefined && value !== before) {
        since ??= now;
        if (now - since >= holdMs && !(await quantityShows(loading))) return { quantity: value };
      } else if (value === before) {
        const settled = progress.quietMs() >= unchangedMs && !progress.busy();
        if ((await quantityShows(options.limit)) && (!limitBefore || settled)) return { limit: true };
        if (settled) return { unchanged: true };
      }
      if (progress.quietMs() >= noProgressMs || now >= until) {
        if (value === before) return (await quantityShows(options.limit)) ? { limit: true } : { unchanged: true };
        if (value !== undefined) return { quantity: value };
        throw quantityFailure("count_unknown", "no count shows after the press", { quantity: current, presses });
      }
      await waitSleep(100);
    }
  };
  while (current !== quantity) {
    const down = quantity < current;
    const control = down ? stepper.decrease : current === 0 && stepper.add !== undefined ? stepper.add : stepper.increase;
    // A control the site greys out, still greyed with no loading sign once unchangedMs has passed,
    // is its limit; many sites grey their steps out for a moment while they save the last one.
    if (await control.evaluateAll(quantityGreyedInPage)) {
      const greyedUntil = Math.min(Date.now() + unchangedMs, deadline);
      let greyed = true;
      while (greyed && Date.now() < greyedUntil) {
        await waitSleep(100);
        greyed = await control.evaluateAll(quantityGreyedInPage);
      }
      if (greyed && !(await quantityShows(loading))) return limited();
    }
    const left = Math.max(1, Math.min(Date.now() + stepTimeout, deadline) - Date.now());
    await waitForReady(control, { overlays, dismiss: options.dismiss, watch: false, timeout: left, deadline });
    // The page may have moved while it got ready: never press on a count it no longer shows.
    const now = await read();
    if (now.quantity !== undefined && now.quantity !== current) {
      current = now.quantity;
      if (Math.abs(quantity - current) > maxSteps)
        throw quantityFailure("too_many_steps", Math.abs(quantity - current) + " steps away, over maxSteps " + maxSteps,
          { quantity: current, presses });
      continue;
    }
    const progress = waitProgress({ loading, region: options.region, siteDomain: options.siteDomain, noProgressMs, unchangedMs });
    let after;
    const limitBefore = await quantityShows(options.limit);
    try {
      await progress.baseline();
      try {
        await control.click({ timeout: Math.max(1, Math.min(waitLimits.action, deadline - Date.now())) });
      } catch (error) {
        throw quantityFailure("press_failed", "the click failed: " + String(error?.message ?? error).split("\n")[0],
          { quantity: current, presses });
      }
      presses += 1;
      progress.begin();
      after = await settle(current, down, progress, Math.min(Date.now() + stepTimeout, deadline), limitBefore);
    } finally {
      await progress.stop();
    }
    if (after.limit) return limited();
    if (after.unchanged)
      throw quantityFailure("not_changed", "a press left the count at " + current, { quantity: current, presses });
    const expected = current + (down ? -1 : 1);
    if (after.quantity !== expected)
      throw quantityFailure("unexpected_count", "a press moved the count from " + current + " to " + after.quantity +
        ", not " + expected, { quantity: after.quantity, expected, presses });
    current = after.quantity;
  }
  return { set: true, quantity: current, presses };
};
`;
