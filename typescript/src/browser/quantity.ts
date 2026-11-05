/** `setQuantity`'s answer once the line holds the quantity asked for. */
export interface QuantitySet {
  readonly set: true;
  readonly quantity: number;
  readonly presses: number;
}

/**
 * `setQuantity`'s answer when the site takes no more, or no fewer: its next control greyed out,
 * its limit sign shown, or a step it showed and then took back.
 */
export interface QuantityLimited {
  readonly set: false;
  readonly reason: "limit";
  readonly quantity: number;
  readonly presses: number;
}

export type QuantityOutcome = QuantitySet | QuantityLimited;

/**
 * Page code for a Kernel call body, pasted after `waitCode` (./wait.ts), whose `waitForReady`,
 * `waitProgress`, `waitLimits`, `waitSleep`, `waitBounded`, `waitContextLost`, `waitSiteDomain` and
 * `waitInflightMs` it uses. It declares `setQuantity`, which sets a line's quantity with the site's
 * own stepper, as a person does: one press at a time, each answered before the next. Many sites
 * cover the stepper with a loader after each press and drop a press made under it, or post each
 * press as its own cart write, so pressing several times at once loses presses or adds too many.
 *
 * `setQuantity({ count, increase, decrease, add }, quantity, { overlays, loading, dismiss, limit,
 * maxSteps, region, siteDomain, noProgressMs, unchangedMs, holdMs, timeout, deadline }?)` takes
 * Playwright locators for the element showing the line's count (text holding the number, or an
 * input), the `+` and `−` controls, and, when the line has none yet, the control that adds the
 * first one, such as ADD. The count is the first whole number the element shows; a line with no
 * count and the `add` control showing holds none, and so does a line its last `−` took off the
 * page, as a cart page does. At 0 it presses `add` while that shows, and `+` otherwise. Each step
 * waits until its control is ready with `waitForReady` (`overlays` and `dismiss` pass to it, so a
 * loader over the stepper is waited out), reads the count again, presses once, and waits for the
 * site's answer: the count's next value, kept for `holdMs` (the settle window, 0.5 s) once none of
 * the requests the press started is still in flight and no `loading` sign (by default the
 * `overlays`) shows. A count that changes between steps counts only once it has held for `holdMs`
 * too, so a stale count a page draws for a moment decides nothing. It returns `{ set: true,
 * quantity, presses }`.
 *
 * The site's limit ends it with `{ set: false, reason: "limit", quantity, presses }`, `quantity`
 * being what the line holds: the control for the next step greyed out (disabled, `aria-disabled`)
 * and still so once the page has shown no progress for `unchangedMs` (2 s) and nothing keeps it
 * busy, since many sites grey their steps out while they save the last one; the site's own `limit`
 * sign showing after an answered press that left the count as it was, once the count has held for
 * `holdMs` when the sign is new, and once the page has shown no progress for `unchangedMs` when it
 * showed before the press; or the count falling back to where a step began after the site showed
 * it moved, as an optimistic stepper does when the site takes the step back, during the step or
 * after it. A count that falls back is the site's answer and is never pressed again.
 *
 * After a press, either answer waits for the page to show no progress for `unchangedMs` since the
 * last press: no `loading` sign, and none of the site's own requests (as the waits count them) in
 * flight, an earlier press's included, the last of them ended `unchangedMs` ago. A request other
 * than a GET or HEAD, as a save is, counts until it ends, and a GET or HEAD for its first 10 s, as
 * the waits count one, so a long-poll holds up no answer, though one over POST ends the call as
 * `unanswered`. A site that gathers presses into one save it sends a while after the last (within
 * that window: raise `unchangedMs` for a slower one), and then caps or reverts the count, has
 * answered by then. A page not yet quiet at the step's `timeout` or the deadline may still send or
 * answer a save, so the call ends as `unanswered`, whatever the count shows: leave room for the
 * wait. Only a page that never goes quiet, as one firing requests of its own does, gets another
 * way out. After `waitLimits.lateFillCap` (15 s) of this wait, with the `timeout` and the deadline
 * still ahead, it lets only the requests in flight at that point end, and then gives the site
 * `unchangedMs` more to draw their answer, so a long save is waited for and short requests are not.
 * Either way the count it ends on must have held for `holdMs`, with no `loading` sign: still the
 * value the presses reached, the answer stands; back toward the count the presses started from,
 * that count included, it is the site's limit at that count, however many presses the site took
 * back; past either, `unexpected_count`. A count that keeps moving or no longer shows, or a request
 * still in flight at the `timeout` or the deadline, leaves the write's outcome unknown, and is
 * `unanswered`. This wait comes once, after the last press, never after each press.
 *
 * Presses never outrun the steps the count was away at the first press, plus up to 2 for steps the
 * page moved the count by itself since. Each step's waits share the page-progress budget the waits
 * use (`noProgressMs`, default 8 s, `region` and `siteDomain` as there); a step's `timeout` (the
 * answer cap, 30 s) and `deadline`, a `Date.now()` time such as the call's own, bound its waits,
 * the wait after the last press included, and both bound every read and every press.
 *
 * It throws an `Error` named `QuantityFailure` with a `reason` and the numbers, never page text:
 * `too_many_steps` when the count is more than `maxSteps` (20) away from the quantity asked for;
 * `count_unknown` when it can't read a count and no `add` shows, before the first press or after a
 * press not yet answered; `count_ambiguous` when the count locator has several visible matches;
 * `press_failed` when the click failed before the deadline and the step's `timeout`; `not_changed`
 * when an answered press left the count as it was, with no progress and no `limit` sign, for
 * `unchangedMs`; `unexpected_count` when a press moved the count anywhere but one step on, the
 * count fell back past where the step began between steps, or after the last press it moved past
 * the count the presses started from or the one they reached (`quantity` read, `expected`);
 * `too_many_presses` when presses reached that cap; and `unanswered` when the deadline or a step's
 * `timeout` came before the page answered: no first count read, a press whose count had not
 * settled, steps still greyed out while the page showed progress, a count that changed between
 * steps and had not held, a page not yet quiet, a request still in flight or a count that kept
 * moving or no longer showed after the last press, no time left for the next press, or either
 * passing during a press, which may still reach the page and is not counted. Each carries
 * `presses`, and `quantity`, the line's count at that point, once one was read. A control that
 * never gets ready fails as `waitForReady` fails.
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
  const tracking = { loading, region: options.region, siteDomain: options.siteDomain, noProgressMs, unchangedMs };
  let current;
  let presses = 0;
  // When the running wait ends, at its step's timeout or the deadline: every read is bounded by it.
  let readsUntil;
  const stepEnds = () => (readsUntil = Math.min(Date.now() + stepTimeout, deadline));
  // A read of the page, bounded by the running wait: undefined when it had no answer by then.
  const bounded = (reading) => {
    reading.catch(() => undefined);
    const left = readsUntil - Date.now();
    return Number.isFinite(left) ? waitBounded(reading, Math.max(1, left)) : reading;
  };
  // Whether a locator has a visible match; undefined when the read was lost or had no answer in time.
  const shows = async (locator) => {
    if (locator === undefined) return false;
    try {
      const count = await bounded(locator.filter({ visible: true }).count());
      return count === undefined ? undefined : count > 0;
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      return undefined;
    }
  };
  // Whether the control's one visible match is greyed out; undefined as for shows.
  const greyed = async (control) => {
    try {
      return await bounded(control.evaluateAll(quantityGreyedInPage));
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      return undefined;
    }
  };
  // One look at the count: its number, loading while it shows none yet (or the read had no answer
  // in time), or missing when neither a count nor the add control shows.
  const read = async () => {
    let count;
    try {
      count = await bounded(stepper.count.evaluateAll(quantityInPage));
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      return { loading: true };
    }
    if (count === undefined || count.state === "loading") return { loading: true };
    if (count.state === "shown") return { quantity: count.value };
    if (count.state === "ambiguous")
      throw quantityFailure("count_ambiguous", count.visible + " visible elements match the count", { quantity: current, presses });
    const add = await shows(stepper.add);
    return add === true ? { quantity: 0 } : add === false ? { missing: true } : { loading: true };
  };
  // One look at the page's progress, bounded as a read is.
  const sample = (progress, changes) => bounded(progress.sample(changes));
  const tooFar = () => {
    if (Math.abs(quantity - current) > maxSteps)
      throw quantityFailure("too_many_steps", Math.abs(quantity - current) + " steps away, over maxSteps " + maxSteps,
        { quantity: current, presses });
  };
  // The line's count before the first step, once the page shows one. A read the deadline or the
  // step's timeout cut short says nothing of the page, so that ending is theirs.
  const startEnds = stepEnds();
  const startUntil = Math.min(Date.now() + noProgressMs, startEnds);
  while (current === undefined) {
    const start = await read();
    current = start.quantity;
    if (current !== undefined) break;
    if (Date.now() >= startUntil) {
      if (start.missing !== true && Date.now() >= startEnds)
        throw quantityFailure("unanswered", "no count read by the deadline or the step's timeout", { presses: 0 });
      throw quantityFailure("count_unknown", "no count and no add control show", { presses: 0 });
    }
    await waitSleep(100);
  }
  tooFar();
  // The count the presses start from: the first one read, or one the page moved it to before the
  // first press, as a cart still loading does.
  let first = current;
  // Steps the page moved the count by itself since the first press.
  let moved = 0;
  // The last step the site answered, from one count to the next, until the page moves the count.
  let step;
  const limited = () => ({ set: false, reason: "limit", quantity: current, presses });
  // The count read again between steps. A new count counts only once it has held for holdMs, as
  // after a press: a re-render from a stale store can draw an old count for a moment. One that
  // falls back from the step the site answered is the site's answer, never a reason to press
  // again: its limit when back where the step began, and a failure past it. Any other new count is
  // the page's own move, and the steps start again from it.
  const recheck = async () => {
    const until = stepEnds();
    let value = (await read()).quantity;
    if (value === undefined || value === current) return "same";
    const begun = Date.now();
    let since = begun;
    while (since === undefined || Date.now() - since < holdMs) {
      if (Date.now() >= until)
        throw quantityFailure("unanswered", "the count did not hold within " + (Date.now() - begun) + " ms; it shows " + value,
          { quantity: value, presses });
      await waitSleep(100);
      const seen = (await read()).quantity;
      if (seen === undefined) since = undefined;
      else if (seen !== value || since === undefined) {
        value = seen;
        since = Date.now();
      }
    }
    if (value === current) return "same";
    if (step !== undefined && Math.sign(value - step.to) === Math.sign(step.from - step.to)) {
      if (value !== step.from)
        throw quantityFailure("unexpected_count", "the count fell back from " + current + " to " + value +
          " after the site answered", { quantity: value, expected: current, presses });
      current = value;
      return "limit";
    }
    if (presses === 0) first = value;
    else moved += Math.abs(value - current);
    current = value;
    step = undefined;
    tooFar();
    return "moved";
  };
  // A greyed-out control is the site's limit once it stays greyed while the page shows no progress
  // for unchangedMs and nothing keeps it busy: many sites grey their steps out while they save the
  // last one. A count that moves meanwhile starts the step again.
  const greyedWait = async (control) => {
    const progress = waitProgress(tracking);
    const begun = Date.now();
    const until = stepEnds();
    try {
      progress.begin();
      while (true) {
        const value = (await read()).quantity;
        const changed = value !== undefined && value !== current;
        await sample(progress, changed ? ["count changed"] : []);
        if (changed) return "moved";
        const still = await greyed(control);
        if (still === false) return "ready";
        if (still === true && progress.quietMs() >= unchangedMs && !progress.busy()) return "limit";
        if (Date.now() >= until)
          throw quantityFailure("unanswered", "the next step stayed greyed out for " + (Date.now() - begun) +
            " ms while the page showed progress", { quantity: current, presses });
        await waitSleep(100);
      }
    } finally {
      await progress.stop();
    }
  };
  // After one press, the site's answer. The press is answered once none of the requests it started
  // is still in flight, and a count counts only once it has held for holdMs since then with no
  // loading sign showing. A count that moved is the answer; one back where it was after the site
  // showed it moved is the site taking the step back, its limit. A count that never moved is the
  // limit when the limit sign is new, or showed before the press and the page has gone quiet for
  // unchangedMs; otherwise it is unchanged once the page has gone quiet.
  const settle = async (before, down, progress, until, limitBefore) => {
    const begun = Date.now();
    let last = before;
    let since;
    let movedOff = false;
    while (true) {
      const seen = await read();
      // A line its last − took off the page, as a cart page does, shows no count and holds none.
      const value = seen.quantity ?? (seen.missing && down && before === 1 ? 0 : undefined);
      const changed = value !== undefined && value !== last;
      await sample(progress, changed ? ["count changed"] : []);
      if (value !== undefined) last = value;
      if (value !== undefined && value !== before) movedOff = true;
      const now = Date.now();
      const answered = !progress.causedInflight();
      const loadingShows = await shows(loading);
      if (value === undefined || !answered || loadingShows !== false) since = undefined;
      else if (changed || since === undefined) since = now;
      const held = since !== undefined && now - since >= holdMs;
      if (held && value !== before) return { quantity: value };
      if (held && movedOff) return { limit: true };
      if (answered && value === before) {
        const quiet = progress.quietMs() >= unchangedMs && !progress.busy();
        if ((await shows(options.limit)) === true && (limitBefore ? quiet : held)) return { limit: true };
        if (quiet) return { unchanged: true };
      }
      if (value === undefined && progress.quietMs() >= noProgressMs)
        throw quantityFailure("count_unknown", "no count shows after the press", { quantity: current, presses });
      if (Date.now() >= until)
        throw quantityFailure("unanswered", "no answer to the press held within " + (Date.now() - begun) +
          " ms; the count shows " + last, { quantity: last, presses });
      await waitSleep(100);
    }
  };
  // The last press's progress, open until the call ends, so the wait before the answer sees every
  // request that press started and every one started since.
  let pressed;
  // The site's own requests (a document, xhr or fetch on its domain, as the waits count them) that
  // started since the call began and are still in flight, an earlier press's included, and when
  // the last of them ended: a save among them may still change the count.
  const flying = new Map();
  let flyingEnded = -Infinity;
  const flyingStarts = (request) => {
    if (!["document", "xhr", "fetch"].includes(request.resourceType())) return;
    try {
      const host = new URL(request.url()).hostname;
      const domain = options.siteDomain ?? waitSiteDomain(new URL(page.url()).hostname);
      if (domain !== "" && (host === domain || host.endsWith("." + domain))) flying.set(request, Date.now());
    } catch {
      // A request whose address can't be read is none of the site's.
    }
  };
  const flyingEnds = (request) => {
    if (flying.delete(request)) flyingEnded = Date.now();
  };
  // Those that count: a write until it ends, however long a save takes, and any other for its first
  // 10 s, as the waits count a request the press didn't start, since a long-poll stays open.
  const inFlight = () => {
    const now = Date.now();
    return [...flying]
      .filter(([request, at]) => !["GET", "HEAD"].includes(request.method()) || now - at < waitInflightMs)
      .map(([request]) => request);
  };
  // Before the answer, after the last press: a site that gathers presses sends one save a while
  // after the last, and may then cap or revert the count. The wait lasts until the page has shown
  // no progress for unchangedMs, with none of the site's requests in flight, the last ended that
  // long ago, and no loading sign. A page not yet quiet at the step timeout or the deadline may
  // still send or answer a save, so that ending is unanswered, whatever the count shows. Only a
  // page that never goes quiet, as one firing requests of its own does, is let off, at lateFillCap
  // with the step timeout and the deadline still ahead: then only the requests in flight at that
  // point must end, and the site gets unchangedMs more to draw their answer, so a long save is
  // waited for and short requests are not. The count it ends on must have held for holdMs: the
  // value the presses reached is the answer; one back toward the count they started from, that
  // count included, is the site's limit, however many presses it took back; any other is
  // unexpected. A count that keeps moving or no longer shows is unanswered too.
  const lastAnswer = async () => {
    const begun = Date.now();
    const until = stepEnds();
    // The count the page shows and since when it has held, the value the last step settled on
    // having held already; the requests in flight at the cap, and when they had all ended.
    let last = current;
    let since = -Infinity;
    let awaited;
    let answered;
    const judged = () => {
      if (last === current) return "same";
      if (quantity < first ? last > current && last <= first : last < current && last >= first) {
        current = last;
        return "limit";
      }
      throw quantityFailure("unexpected_count", "the count moved from " + current + " to " + last +
        " after the last press", { quantity: last, expected: current, presses });
    };
    while (true) {
      const seen = await read();
      // A line its last − took off the page, as a cart page does, holds none.
      const value = seen.quantity ?? (seen.missing && current === 0 ? 0 : undefined);
      const changed = value !== undefined && value !== last;
      await sample(pressed, changed ? ["count changed"] : []);
      const loadingShows = await shows(loading);
      const now = Date.now();
      const counted = inFlight();
      if (awaited === undefined && now - begun >= waitLimits.lateFillCap) {
        awaited = counted;
        if (awaited.length === 0) answered = -Infinity;
      }
      const waiting = awaited !== undefined && awaited.some((request) => counted.includes(request));
      if (awaited !== undefined && !waiting) answered ??= now;
      if (value === undefined || waiting || loadingShows !== false) since = undefined;
      else if (changed || since === undefined) since = now;
      if (value !== undefined) last = value;
      const held = since !== undefined && now - since >= holdMs;
      const quiet = counted.length === 0 && now - flyingEnded >= unchangedMs &&
        pressed.quietMs() >= unchangedMs && !pressed.busy();
      if (held && (quiet || (answered !== undefined && now - answered >= unchangedMs))) return judged();
      if (value === undefined && pressed.quietMs() >= noProgressMs)
        throw quantityFailure("unanswered", "no count shows " + (now - begun) +
          " ms after the last press was answered; it last showed " + last, { quantity: last, presses });
      if (now >= until)
        throw quantityFailure("unanswered", (counted.length > 0 ? counted.length + " of the site's requests were still in flight"
          : quiet ? "the count did not hold" : "the page had not gone quiet") + " " + (now - begun) +
          " ms after the last press was answered, so the write's outcome is unknown; the count shows " + last,
          { quantity: last, presses });
      await waitSleep(100);
    }
  };
  // The site's limit, once seen: the call answers it, as it answers a quantity set, after the
  // wait that follows its last press.
  let atLimit = false;
  page.on("request", flyingStarts);
  page.on("requestfinished", flyingEnds);
  page.on("requestfailed", flyingEnds);
  try {
    while (true) {
      if (atLimit || current === quantity) {
        if (presses > 0 && (await lastAnswer()) === "limit") atLimit = true;
        return atLimit ? limited() : { set: true, quantity: current, presses };
      }
      // The count may have moved since the last step was answered.
      const change = await recheck();
      if (change === "limit") {
        atLimit = true;
        continue;
      }
      if (change === "moved") {
        await waitSleep(50);
        continue;
      }
      const down = quantity < current;
      const control = down ? stepper.decrease
        : current === 0 && (await shows(stepper.add)) === true ? stepper.add : stepper.increase;
      if ((await greyed(control)) === true) {
        const greyedOut = await greyedWait(control);
        if (greyedOut === "limit") {
          atLimit = true;
          continue;
        }
        if (greyedOut === "moved") continue;
      }
      const left = Math.max(1, Math.min(Date.now() + stepTimeout, deadline) - Date.now());
      await waitForReady(control, { overlays, dismiss: options.dismiss, watch: false, timeout: left, deadline });
      // The page may have moved while it got ready: never press on a count it no longer shows.
      const ready = await recheck();
      if (ready === "limit") {
        atLimit = true;
        continue;
      }
      if (ready === "moved") continue;
      const steps = Math.abs(quantity - first);
      if (presses >= steps + Math.min(moved, 2))
        throw quantityFailure("too_many_presses", presses + " presses for " + steps + " steps, with the count moved " + moved +
          " steps by the page itself", { quantity: current, presses });
      await pressed?.stop();
      const progress = (pressed = waitProgress(tracking));
      // A limit sign already showing before the press counts only once the page has gone quiet.
      const limitBefore = (await shows(options.limit)) !== false;
      await bounded(progress.baseline());
      // The reads just before can use up the time left. A press with none left, or one the deadline
      // or the step's timeout cut short, fails as theirs, not the click's.
      if (Date.now() >= readsUntil)
        throw quantityFailure("unanswered", "the deadline or the step's timeout passed before the next press",
          { quantity: current, presses });
      try {
        await control.click({ timeout: Math.max(1, Math.min(waitLimits.action, readsUntil - Date.now())) });
      } catch (error) {
        if (Date.now() >= readsUntil)
          throw quantityFailure("unanswered", "the deadline or the step's timeout passed during the press, which may " +
            "still reach the page", { quantity: current, presses });
        throw quantityFailure("press_failed", "the click failed: " + String(error?.message ?? error).split("\n")[0],
          { quantity: current, presses });
      }
      presses += 1;
      progress.begin();
      const after = await settle(current, down, progress, stepEnds(), limitBefore);
      if (after.limit) {
        atLimit = true;
        continue;
      }
      if (after.unchanged)
        throw quantityFailure("not_changed", "a press left the count at " + current, { quantity: current, presses });
      const expected = current + (down ? -1 : 1);
      if (after.quantity !== expected)
        throw quantityFailure("unexpected_count", "a press moved the count from " + current + " to " + after.quantity +
          ", not " + expected, { quantity: after.quantity, expected, presses });
      step = { from: current, to: after.quantity };
      current = after.quantity;
    }
  } finally {
    page.off("request", flyingStarts);
    page.off("requestfinished", flyingEnds);
    page.off("requestfailed", flyingEnds);
    await pressed?.stop();
  }
};
`;
