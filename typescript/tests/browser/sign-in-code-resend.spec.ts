import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { makeCodeResend } from "../../src/runtime/code-resend.js";
import type { Question } from "../../src/runtime/input-request.js";
import { boundedSignInHooks } from "../../src/runtime/session-sign-in.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in by a phone number and the code the site sends, on a code screen whose "Resend
// code" control the site enables only once its timer ends. The owner may answer the code question
// by asking for a new code: the host waits for the control, presses it once, and asks again for
// the newest code, at most twice per screen. Nothing typed goes out with the press.

const site = "https://phone.example.test";
const host = "phone.example.test";
const phone = "+15555550123";
// A phone screen, a code screen and its resend's wait: more than the default 30 s on a busy machine.
test.describe.configure({ timeout: 120_000 });

/**
 * The site. Each code it sends is the next of `codes`. The code screen's resend control is enabled
 * `enableMs` after the screen loads, or never; with `hidden` it shows only then, enabled.
 * `inForm` makes it a submit of the code's own form, posting to its own address, else a button
 * whose script asks for the code. A wrong code shows the screen again with the code in its box.
 */
const serve = async (
  page: Page,
  options: {
    readonly enableMs?: number;
    readonly inForm?: boolean;
    readonly hidden?: boolean;
    /** The resend control is a link to another site, outside the code's own form. */
    readonly offSite?: boolean;
  } = {},
) => {
  const codes = ["111111", "222222", "333333"];
  const site_ = { sent: 0, resends: [] as string[], verified: [] as string[] };
  const current = () => codes[Math.max(0, site_.sent - 1)] ?? "";
  const hidden = options.hidden === true ? " hidden" : "";
  const resend =
    options.inForm === true
      ? `<button id="resend" name="action" value="resend" formaction="/resend" formnovalidate disabled${hidden}>Resend code</button>`
      : `<button type="button" id="resend" disabled${hidden}>Resend code</button>`;
  const codeScreen = (kept = "") => `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code" value="${kept}"></label>
<button id="verify">Verify</button>
${options.offSite === true ? "" : resend}
</form>
${options.offSite === true ? '<a id="resend" href="https://elsewhere.example.org/resend">Resend code</a>' : ""}
<script>
const resend = document.getElementById("resend");
${options.enableMs === undefined ? "" : `setTimeout(() => { resend.disabled = false; resend.hidden = false; }, ${options.enableMs});`}
${options.inForm === true || options.offSite === true ? "" : 'resend.addEventListener("click", () => fetch("/resend", { method: "POST", body: "action=resend", headers: { "content-type": "application/x-www-form-urlencoded" } }));'}
</script>`;
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const form = new URLSearchParams(request.postData() ?? "");
    if (request.method() === "POST" && path === "/send-code") {
      site_.sent += 1;
      await route.fulfill({ contentType: "text/html", body: codeScreen() });
    } else if (request.method() === "POST" && path === "/resend") {
      // What the code box held when the resend went out.
      site_.resends.push(form.get("code") ?? "");
      site_.sent += 1;
      await route.fulfill({ contentType: "text/html", body: options.inForm === true ? codeScreen() : "{}" });
    } else if (request.method() === "POST" && path === "/verify") {
      const code = form.get("code") ?? "";
      site_.verified.push(code);
      await route.fulfill({
        contentType: "text/html",
        body: code === current() ? '<h1 id="account">Your account</h1>' : `<p>Wrong code</p>${codeScreen(code)}`,
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/send-code"><label>Phone <input id="phone" name="phone" type="tel"></label><button id="send">Send code</button></form>',
      });
  });
  return site_;
};

const recipe = {
  version: 12,
  steps: [
    {
      page: `${site}/login`,
      fields: [{ selector: "#phone", accepts: ["phone"] }],
      submit: "#send",
      submittedBy: "host",
    },
    {
      page: `${site}/send-code`,
      fields: [{ selector: "#code", slot: "code" }],
      submit: "#verify",
      submittedBy: "host",
      resend: "#resend",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** A code question as asked: its prompt, and whether it offered a resend. */
interface Asked {
  readonly prompt: string;
  readonly resend: boolean;
}

/**
 * One run's sign-in, answering the login with the phone alone and each code question with the
 * next of `answers`: a code, or `resend` to ask for a new one.
 */
const run = async (
  page: Page,
  answers: readonly (string | "resend")[],
  resendWaitMs = 10_000,
) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const asked: Asked[] = [];
  const queue = [...answers];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question: Question | undefined = request.questions[0];
      if (question?.type === "credential")
        return { login: { identifierKind: "phone", username: phone, saveLogin: false } };
      asked.push({
        prompt: question?.prompt ?? "",
        resend: question?.type === "secret" && question.allowResend === true,
      });
      const answer = queue.shift() ?? "";
      return { [question?.id ?? "code"]: answer === "resend" ? { resend: true } : answer };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: makeSignInBrowser({
          page: browser,
          keyboard,
          siteOrigin: site,
          authenticationOrigins: [],
          typing: { typed: false },
        }),
        login: localSignInLogin({
          ask,
          register: secrets.register,
          siteOrigin: site,
          passwordless: { identifierKinds: ["phone"], password: false },
        }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250, resendWaitMs },
      }),
    ),
  );
  return { result, asked, calls: browser.calls };
};

const firstAsk = { prompt: `Enter the sign-in code ${host} sent you.`, resend: true };
const resentAsk = (resend: boolean) => ({
  prompt: `The site was asked to send a new code. Enter the newest sign-in code ${host} sent you.`,
  resend,
});

test("a run waits for the site's timer, presses its resend once, and signs in with the newest code", async ({
  page,
}) => {
  const site_ = await serve(page, { enableMs: 1_500 });
  const { result, asked, calls } = await run(page, ["resend", "222222"]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked).toEqual([firstAsk, resentAsk(true)]);
  expect(site_.resends).toEqual([""]);
  expect(site_.verified).toEqual(["222222"]);
  expectNotCarried(calls, "222222");
});

test("a run presses a screen's resend twice at most, then asks for the code alone", async ({ page }) => {
  const site_ = await serve(page, { enableMs: 200 });
  const { result, asked } = await run(page, ["resend", "resend", "333333"]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked).toEqual([firstAsk, resentAsk(true), resentAsk(false)]);
  expect(site_.resends).toEqual(["", ""]);
  expect(site_.verified).toEqual(["333333"]);
});

test("a run whose resend the site never enables presses nothing and asks for the code again", async ({
  page,
}) => {
  const site_ = await serve(page);
  const { result, asked } = await run(page, ["resend", "111111"], 1_500);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked).toEqual([
    firstAsk,
    {
      prompt: `The site's resend control couldn't be pressed, so no new code was asked for. Enter the newest sign-in code ${host} sent you.`,
      resend: true,
    },
  ]);
  expect(site_.resends).toEqual([]);
  expect(site_.verified).toEqual(["111111"]);
});

test("a run empties a refused code from its box before a resend that posts the code's own form", async ({
  page,
}) => {
  const site_ = await serve(page, { enableMs: 200, inForm: true });
  const { result, asked } = await run(page, ["999999", "resend", "222222"]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked.map(({ resend }) => resend)).toEqual([true, true, true]);
  expect(asked[2]?.prompt).toBe(
    `The site was asked to send a new code. Enter the newest sign-in code ${host} sent you.`,
  );
  // The refused code went out once, and the resend carried an empty box.
  expect(site_.verified).toEqual(["999999", "222222"]);
  expect(site_.resends).toEqual([""]);
});

test("a run waits for a resend control the site shows only once its timer ends", async ({ page }) => {
  const site_ = await serve(page, { enableMs: 1_500, hidden: true });
  const { result, asked } = await run(page, ["resend", "222222"]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked).toEqual([firstAsk, resentAsk(true)]);
  expect(site_.resends).toEqual([""]);
  expect(site_.verified).toEqual(["222222"]);
});

test("a run never presses a resend control that leads off the site", async ({ page }) => {
  const left: string[] = [];
  await page.route("https://elsewhere.example.org/**", async (route) => {
    left.push(route.request().url());
    await route.fulfill({ contentType: "text/html", body: "<p>Elsewhere</p>" });
  });
  const site_ = await serve(page, { offSite: true });
  const { result, asked } = await run(page, ["resend", "111111"]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(asked[1]?.prompt).toBe(
    `The site's resend control couldn't be pressed, so no new code was asked for. Enter the newest sign-in code ${host} sent you.`,
  );
  expect(left).toEqual([]);
  expect(site_.verified).toEqual(["111111"]);
});

/**
 * One press of a code screen's resend as a run makes it (`makeCodeResend`), on `body` served at
 * the code screen's address, with each form the site receives and where it went.
 */
const pressOn = async (page: Page, body: string, step: AutofillStep) => {
  const posts: { path: string; form: Record<string, string> }[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST")
      posts.push({
        path: new URL(request.url()).pathname,
        form: Object.fromEntries(new URLSearchParams(request.postData() ?? "")),
      });
    await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${site}/verify`);
  const browser = makeSignInBrowser({
    page: await hostPage(page),
    keyboard: (await hostKeyboard(page)).keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const events: Readonly<Record<string, unknown>>[] = [];
  const resend = makeCodeResend({
    hooks: {
      inspect: (each) => browser.inspect(each).pipe(Effect.orDie),
      ...(browser.resend === undefined ? {} : { resend: browser.resend }),
    },
    step,
    presses: new Map(),
    waitMs: 5_000,
    pollMs: 250,
    emit: (details) => Effect.sync(() => void events.push(details)),
  });
  if (resend === undefined) throw new Error("The step offers no resend");
  const pressed = await Effect.runPromise(resend.press);
  await page.waitForTimeout(500);
  return { pressed, posts, events };
};

const codeOnly: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#verify",
  resend: "#resend",
};

test("a press never sends a password an earlier screen left in the code's own form", async ({ page }) => {
  // A screen drawn in place of the password screen keeps the typed password in a hidden box of
  // the form its resend submits.
  const { pressed, posts } = await pressOn(
    page,
    `<form method="post" action="/verify">
<div hidden><label>Password <input id="password" name="password" type="password" value="typed-before"></label></div>
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
});

test("a press never sends a password the site's own toggle shows as text", async ({ page }) => {
  const { pressed, posts } = await pressOn(
    page,
    `<form method="post" action="/verify">
<label>Password <input id="password" name="password" type="text" autocomplete="current-password" value="typed-before"></label>
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
});

test("a press never sends a password from a form its control sits outside of", async ({ page }) => {
  // The control's own script posts the code's form, which still holds the typed password.
  const { pressed, posts } = await pressOn(
    page,
    `<form id="code-form" method="post" action="/verify">
<div hidden><label>Password <input id="password" name="password" type="password" value="typed-before"></label></div>
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
</form>
<button type="button" id="resend">Resend code</button>
<script>document.getElementById("resend").addEventListener("click", () => {
  const form = document.getElementById("code-form");
  form.action = "/resend";
  form.submit();
});</script>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
});

for (const [name, field] of [
  ["a number", '<input id="phone" name="phone" type="tel" value="+15555550123">'],
  ["a number in a box the page hides", '<div hidden><input id="phone" name="phone" value="+15555550123"></div>'],
  ["an email address", '<input id="email" name="email" type="email" value="ada@example.test">'],
  ["a note", '<textarea id="note" name="note">typed before</textarea>'],
] as const)
  test(`a press never re-posts ${name} an earlier screen left in the form its control submits`, async ({
    page,
  }) => {
    const { pressed, posts, events } = await pressOn(
      page,
      `<form method="post" action="/verify">
${field}
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form>`,
      codeOnly,
    );
    expect(pressed).toBe(false);
    expect(posts).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ outcome: "refused", part: "value_held" })]);
  });

test("a press never re-posts a value in a form its control names from outside", async ({ page }) => {
  const { pressed, posts } = await pressOn(
    page,
    `<form id="code-form" method="post" action="/verify">
<input id="phone" name="phone" type="tel" value="+15555550123">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
</form>
<button id="resend" form="code-form" formaction="/resend">Resend code</button>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
});

// A selector may name what a control holds, or a label for it: the click then reaches the control.
for (const [name, control, resend] of [
  [
    "a span its button holds",
    '<button formaction="/resend"><span id="label">Resend code</span></button>',
    "#label",
  ],
  [
    "a span its button holds, named by its text",
    '<button formaction="/resend"><span>Resend code</span></button>',
    "text=Resend code",
  ],
  [
    "a label for its button",
    '<button id="again" formaction="/resend">Again</button><label id="label" for="again">Resend code</label>',
    "#label",
  ],
  [
    "a label that holds its button",
    '<label id="label">Resend code <input type="submit" formaction="/resend" value="Again"></label>',
    "#label",
  ],
] as const) {
  const screen = (field: string) => `<form method="post" action="/verify">
${field}
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
${control}
</form>`;

  test(`a press never re-posts a value left in the form, through ${name}`, async ({ page }) => {
    const { pressed, posts, events } = await pressOn(
      page,
      screen('<input id="phone" name="phone" type="tel" value="+15555550123">'),
      { ...codeOnly, resend },
    );
    expect(pressed).toBe(false);
    expect(posts).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ outcome: "refused", part: "value_held" })]);
  });

  test(`a press goes out through ${name}, from a form that holds no value`, async ({ page }) => {
    const { pressed, posts } = await pressOn(page, screen(""), { ...codeOnly, resend });
    expect(pressed).toBe(true);
    expect(posts).toEqual([{ path: "/resend", form: { code: "" } }]);
  });
}

for (const [name, field, sent] of [
  [
    "a hidden value the site wrote",
    '<input name="phone" type="hidden" value="+15555550123">',
    { phone: "+15555550123", code: "" },
  ],
  [
    "a read-only box the site filled",
    '<input name="phone" value="+15555550123" readonly>',
    { phone: "+15555550123", code: "" },
  ],
  ["a disabled box", '<input name="phone" value="+15555550123" disabled>', { code: "" }],
  ["a box left empty", '<input name="phone" type="tel">', { phone: "", code: "" }],
  ["a box with no name, which posts nothing", '<input id="filter" value="+15555550123">', { code: "" }],
  ["a choice", '<input name="remember" type="checkbox" value="yes" checked>', { remember: "yes", code: "" }],
] as const)
  test(`a press goes out from a form that holds ${name}`, async ({ page }) => {
    const { pressed, posts } = await pressOn(
      page,
      `<form method="post" action="/verify">
${field}
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form>`,
      codeOnly,
    );
    expect(pressed).toBe(true);
    expect(posts).toEqual([{ path: "/resend", form: sent }]);
  });

test("a press of a control that submits no form goes out beside a value that form holds", async ({
  page,
}) => {
  const { pressed, posts } = await pressOn(
    page,
    `<form method="post" action="/verify">
<input id="phone" name="phone" type="tel" value="+15555550123">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button type="button" id="resend">Resend code</button>
</form>
<script>document.getElementById("resend").addEventListener("click", () => {
  fetch("/resend", { method: "POST" });
});</script>`,
    codeOnly,
  );
  expect(pressed).toBe(true);
  expect(posts).toEqual([{ path: "/resend", form: {} }]);
});

// A click may reach a link the selector doesn't name, as what a link holds or a label beside it.
const codeForm = `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
</form>`;
// What a click's path takes in beyond the page's parents, with each of them leading to `to`.
const slotted = (to: string) => `<div id="shadow"><span id="press">Resend code</span></div>
<script>document.getElementById("shadow").attachShadow({ mode: "open" }).innerHTML = '<a href="${to}"><slot></slot></a>';</script>`;
const svgLink = (to: string) =>
  `<svg width="200" height="40"><a xlink:href="${to}"><text id="press" x="0" y="20">Resend code</text></a></svg>`;
const imageMap = (to: string) =>
  `<img id="press" alt="Resend code" width="120" height="40" usemap="#resend" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="><map name="resend"><area shape="rect" coords="0,0,120,40" href="${to}"></map>`;
const offSiteForm =
  '<form id="off" action="https://elsewhere.example.org/take" method="post"><input type="hidden" name="phone" value="+15555550123"></form>';
for (const [name, control] of [
  [
    "a span an off-site link holds",
    '<a href="https://elsewhere.example.org/resend"><span id="press">Resend code</span></a>',
  ],
  [
    "a label that holds an off-site link",
    '<label id="press"><a href="https://elsewhere.example.org/resend">Resend code</a></label>',
  ],
  [
    "a label for a button an off-site link holds",
    '<a href="https://elsewhere.example.org/resend"><button type="button" id="again">Again</button></a><label id="press" for="again">Resend code</label>',
  ],
  [
    "a span a link to another origin of the site holds",
    '<a href="https://accounts.phone.example.test/resend"><span id="press">Resend code</span></a>',
  ],
  ["a span slotted into an off-site link", slotted("https://elsewhere.example.org/resend")],
  ["an off-site SVG link", svgLink("https://elsewhere.example.org/resend")],
  ["an image whose map holds an off-site area", imageMap("https://elsewhere.example.org/resend")],
  [
    "a span the button of an off-site form holds",
    `${offSiteForm}<button form="off"><span id="press">Resend code</span></button>`,
  ],
  [
    "a span in a label for the button of an off-site form",
    `${offSiteForm}<button id="again" form="off">Again</button><label for="again"><span id="press">Resend code</span></label>`,
  ],
  [
    "a span in a button whose formaction leaves the site",
    '<form id="own" action="/resend" method="post"></form><button form="own" formaction="https://elsewhere.example.org/take"><span id="press">Resend code</span></button>',
  ],
  [
    "a span the button of an off-site form holds, where a control hides the form's action",
    '<form id="off" action="https://elsewhere.example.org/take" method="post"><input type="hidden" name="action" value="send"></form><button form="off"><span id="press">Resend code</span></button>',
  ],
] as const)
  test(`a press never leaves the origin through ${name}`, async ({ page }) => {
    const left: string[] = [];
    await page.route(/elsewhere\.example\.org|accounts\.phone\.example\.test/u, async (route) => {
      left.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: "<p>Elsewhere</p>" });
    });
    const { pressed, posts, events } = await pressOn(page, `${codeForm}${control}`, {
      ...codeOnly,
      resend: "#press",
    });
    expect(pressed).toBe(false);
    expect(posts).toEqual([]);
    expect(left).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ outcome: "refused", part: "other_origin" })]);
  });

for (const [name, control, form] of [
  [
    "the button of a form on the same site",
    '<form id="own" action="/resend" method="post"><input type="hidden" name="token" value="site"></form><button form="own"><span id="press">Resend code</span></button>',
    { token: "site" },
  ],
  [
    "the button of a form on the same site, where a control hides the form's action",
    '<form id="own" action="/resend" method="post"><input type="hidden" name="action" value="send"></form><button form="own"><span id="press">Resend code</span></button>',
    { action: "send" },
  ],
  [
    "a button whose formaction stays on the site, in an off-site form",
    `${offSiteForm}<button form="off" formaction="/resend"><span id="press">Resend code</span></button>`,
    { phone: "+15555550123" },
  ],
] as const)
  test(`a press goes out through a span in ${name}`, async ({ page }) => {
    const { pressed, posts } = await pressOn(page, `${codeForm}${control}`, {
      ...codeOnly,
      resend: "#press",
    });
    expect(pressed).toBe(true);
    expect(posts).toEqual([{ path: "/resend", form }]);
  });

for (const [name, control] of [
  ["a span a link on the same site holds", '<a href="/resend"><span id="press">Resend code</span></a>'],
  ["a span slotted into a link on the same site", slotted("/resend")],
  ["an SVG link on the same site", svgLink("/resend")],
  ["an image whose map holds an area on the same site", imageMap("/resend")],
] as const)
  test(`a press goes out through ${name}`, async ({ page }) => {
    const opened: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) opened.push(new URL(request.url()).pathname);
    });
    const { pressed } = await pressOn(page, `${codeForm}${control}`, {
      ...codeOnly,
      resend: "#press",
    });
    expect(pressed).toBe(true);
    expect(opened).toContain("/resend");
  });

test("a press goes out through a link whose address is a script that does nothing", async ({
  page,
}) => {
  const { pressed, posts } = await pressOn(
    page,
    `${codeForm}<a id="link" href="javascript:void(0)"><span id="press">Resend code</span></a>
<script>document.getElementById("link").addEventListener("click", () => {
  fetch("/resend", { method: "POST" });
});</script>`,
    { ...codeOnly, resend: "#press" },
  );
  expect(pressed).toBe(true);
  expect(posts).toEqual([{ path: "/resend", form: {} }]);
});

test("a press never sends a code its box put back once emptied", async ({ page }) => {
  const { pressed, posts } = await pressOn(
    page,
    `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code" value="999999"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form><script>
const code = document.getElementById("code");
let last = code.value;
code.addEventListener("input", () => { if (code.value === "") code.value = last; else last = code.value; });
</script>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
  await expect(page.locator("#code")).toHaveValue("999999");
});

test("a press whose wait a script's stop ends never goes out, though the site then enables its control", async ({
  page,
}) => {
  const posts: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") posts.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      contentType: "text/html",
      body: `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend" disabled>Resend code</button>
</form>`,
    });
  });
  await page.goto(`${site}/verify`);
  const browser = makeSignInBrowser({
    page: await hostPage(page),
    keyboard: (await hostKeyboard(page)).keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const stop = new AbortController();
  const bounded = boundedSignInHooks(
    browser,
    { untilMs: Date.now() + 60_000, stop: stop.signal },
    () => new Error("The bound passed"),
  );
  let waiting = false;
  const resend = makeCodeResend({
    hooks: {
      inspect: (each) => bounded.inspect(each).pipe(Effect.orDie),
      resend: (input) => {
        waiting = true;
        return bounded.resend?.(input) ?? Effect.die("The browser presses no resend");
      },
    },
    step: codeOnly,
    presses: new Map(),
    waitMs: 20_000,
    pollMs: 250,
    emit: () => Effect.void,
  });
  if (resend === undefined) throw new Error("The step offers no resend");
  const pressing = Effect.runPromise(resend.press);
  await expect.poll(() => waiting, { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(600);
  stop.abort();
  await page.locator("#resend").evaluate((element) => {
    (element as HTMLButtonElement).disabled = false;
  });
  expect(await pressing).toBe(false);
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
});

/**
 * A press of an enabled resend under a script's stop. `watch` hears each call of the host's as it
 * starts, then with the answer it gave, so a spec raises the stop at an exact point of the press.
 */
const pressUnderStop = async (
  page: Page,
  watch: (stop: AbortController, answer?: unknown) => void,
) => {
  const posts: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") posts.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      contentType: "text/html",
      body: `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
<button id="resend" formaction="/resend">Resend code</button>
</form>`,
    });
  });
  await page.goto(`${site}/verify`);
  const stop = new AbortController();
  const host = await hostPage(page);
  const browser = makeSignInBrowser({
    page: {
      ...host,
      execute: (code, seconds) =>
        Effect.suspend(() => {
          watch(stop);
          return host.execute(code, seconds);
        }).pipe(Effect.tap((answer) => Effect.sync(() => watch(stop, answer)))),
    },
    keyboard: (await hostKeyboard(page)).keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const bounded = boundedSignInHooks(
    browser,
    { untilMs: Date.now() + 60_000, stop: stop.signal },
    () => new Error("The bound passed"),
  );
  const resend = makeCodeResend({
    hooks: {
      inspect: (each) => bounded.inspect(each).pipe(Effect.orDie),
      ...(bounded.resend === undefined ? {} : { resend: bounded.resend }),
    },
    step: codeOnly,
    presses: new Map(),
    waitMs: 5_000,
    pollMs: 250,
    emit: () => Effect.void,
  });
  if (resend === undefined) throw new Error("The step offers no resend");
  const pressed = await Effect.runPromise(resend.press);
  await page.waitForTimeout(500);
  return { pressed, posts };
};

/** The answer of the read before a press's click, which finds its control enabled. */
const readEnabled = (answer: unknown) =>
  typeof answer === "object" && answer !== null && Reflect.get(answer, "submit") === "none";

test("a press whose stop is raised as its read finds the control enabled never clicks", async ({
  page,
}) => {
  const { pressed, posts } = await pressUnderStop(page, (stop, answer) => {
    if (readEnabled(answer)) stop.abort();
  });
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
});

// What a stop can't do: a call that started before it still clicks, as a call can't be called back.
test("a press whose click call started before its stop was raised goes out", async ({ page }) => {
  let read = false;
  const { pressed, posts } = await pressUnderStop(page, (stop, answer) => {
    if (answer === undefined && read) stop.abort();
    read ||= readEnabled(answer);
  });
  expect(read).toBe(true);
  expect(pressed).toBe(true);
  expect(posts).toEqual(["/resend"]);
});

for (const [name, resend] of [
  ["the screen's submit by another selector", "form button"],
  ["one of the screen's fields by another selector", "input[name=code]"],
] as const)
  test(`a press never clicks a resend that is ${name}`, async ({ page }) => {
    const { pressed, posts } = await pressOn(
      page,
      `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
<button id="verify">Verify</button>
</form>`,
      { ...codeOnly, resend },
    );
    expect(pressed).toBe(false);
    expect(posts).toEqual([]);
  });

// A browser skips a label's click from a button inside it, so this press would reach no box. The
// reach counts the box all the same: refusing is the safe side, and the code is still asked for.
test("a press never clicks a resend inside the code box's own label", async ({ page }) => {
  const { pressed, posts, events } = await pressOn(
    page,
    `<form method="post" action="/verify">
<label>Code <input id="code" name="code" autocomplete="one-time-code">
<button type="button" id="resend">Resend code</button></label>
<button id="verify">Verify</button>
</form>
<script>document.getElementById("resend").addEventListener("click", () => {
  fetch("/resend", { method: "POST" });
});</script>`,
    codeOnly,
  );
  expect(pressed).toBe(false);
  expect(posts).toEqual([]);
  expect(events).toEqual([expect.objectContaining({ outcome: "refused", part: "same_control" })]);
});

for (const [name, screen] of [
  [
    "a span the screen's submit holds",
    '<label>Code <input id="code" name="code" autocomplete="one-time-code"></label><button id="verify"><span id="press">Verify</span></button>',
  ],
  [
    "a label for the screen's submit",
    '<label>Code <input id="code" name="code" autocomplete="one-time-code"></label><button id="verify">Verify</button><label id="press" for="verify">Resend code</label>',
  ],
  [
    "a label for one of the screen's fields",
    '<label id="press" for="code">Resend code</label><input id="code" name="code" autocomplete="one-time-code"><button id="verify">Verify</button>',
  ],
] as const)
  test(`a press never clicks a resend that reaches ${name}`, async ({ page }) => {
    const { pressed, posts, events } = await pressOn(
      page,
      `<form method="post" action="/verify">${screen}</form>`,
      { ...codeOnly, resend: "#press" },
    );
    expect(pressed).toBe(false);
    expect(posts).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ outcome: "refused", part: "same_control" })]);
  });
