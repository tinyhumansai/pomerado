import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { CredentialKeyboard } from "../../src/destinations/credential-keyboard.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { typedValues } from "../../src/runtime/autofill-values.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { expectOriginsOnly, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in page that shows one "email or mobile number" box and, once digits are typed, replaces
// it with a phone box holding the value, often beside a calling-code picker. The host typed the
// value into the box it bound, in one atomic insertion, and that box is gone. It judges the
// replacement as a fresh screen, reads it back, and clicks the screen's submit, typing nothing
// again. A box that holds the national digits alone, which say no country, needs a picker near it
// that shows the number's own calling code; no control near it, nor a picker anywhere in the
// document, may show another, while a support number far from it counts for nothing. Anything
// else stays the refusal of a field gone from the page.

const site = "https://login.example.test";
const other = "https://other.example.test";
const host = "login.example.test";
const number = "+91 98765 43210";
// A fill, its look for a new document and a fresh inspection, or a run's whole sign-in: more than
// the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

const identifierStep: AutofillStep = {
  fields: [{ selector: "#identifier", slot: "phone", accepts: ["email", "phone"] }],
  submit: "#continue",
};

/**
 * The screen. `swap` runs once the box holds what looks like a phone number, with `box`, the
 * element around the identifier box, `national`, the digits after the +91 typed, and `typed`, all
 * of what was typed.
 */
const screen = (swap: string) => `<form action="/session" method="post">
<div id="box"><label>Email or mobile number <input id="identifier" name="identifier" autocomplete="username"></label></div>
<button id="continue">Continue</button>
</form>
<script>
const box = document.getElementById("box");
const identifier = document.getElementById("identifier");
identifier.addEventListener("input", () => {
  const typed = identifier.value;
  if (!/^[+0-9]/.test(typed)) return;
  const national = typed.replace(/[^0-9]/g, "").replace(/^91/, "");
  ${swap}
});
</script>`;

/** The phone box a swap draws, holding `value` (a script expression). */
const phoneBox = (value: string) => `box.innerHTML = '<label>Mobile number <input id="phone" name="phone" type="tel"></label>';
const phone = document.getElementById("phone");
phone.value = ${value};
phone.focus();`;

/** A calling-code picker before the phone box, showing the option `chosen` names. */
const pickerAndBox = (chosen: string, value = "national") => `box.innerHTML = '<label>Country <select id="dial" name="dial"><option value="1">+1</option><option value="44">+44</option><option value="91">+91</option></select></label><label>Mobile number <input id="phone" name="phone" type="tel"></label>';
document.getElementById("dial").value = ${JSON.stringify(chosen)};
const phone = document.getElementById("phone");
phone.value = ${value};
phone.focus();`;

/** Serves the screen, any page `frames` names, and keeps each form the site receives. */
const serve = async (
  page: Page,
  body: string,
  frames: Readonly<Record<string, string>> = {},
) => {
  const received: Record<string, string>[] = [];
  const answer = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    const request = route.request();
    const frame = frames[new URL(request.url()).href.split("?")[0] ?? ""];
    if (frame !== undefined) await route.fulfill({ contentType: "text/html", body: frame });
    else if (request.method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: "<p>Code sent</p>" });
    } else await route.fulfill({ contentType: "text/html", body });
  };
  await page.route(`${site}/**`, answer);
  await page.route(`${other}/**`, answer);
  await page.goto(`${site}/login`);
  return received;
};

/** The host's fill of the identifier screen with `value`, and each value its keyboard typed. */
const fill = async (page: Page, value = number) => {
  const browser = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: identifierStep, page: browser, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  const typed: string[] = [];
  const counting: CredentialKeyboard = {
    ...keyboard,
    insertText: (target, text, options) =>
      Effect.suspend(() => {
        typed.push(text);
        return keyboard.insertText(target, text, options);
      }),
  };
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: identifierStep,
      values: typedValues(identifierStep, [value]),
      inspection,
      page: browser,
      keyboard: counting,
      settleMs: 2_000,
    }),
  );
  return { report, typed };
};

const clicked = {
  outcome: "filled",
  fields: [{ slot: "phone", status: "filled" }],
  submit: "clicked",
};

test("clicks the submit of a phone box that took the identifier box's place, holding the number", async ({
  page,
}) => {
  const received = await serve(page, screen(phoneBox('"+91" + national')));
  const { report, typed } = await fill(page);
  expect(report).toMatchObject(clicked);
  expect(received).toEqual([{ phone: "+919876543210" }]);
  expect(typed).toEqual([number]);
});

test("takes a phone box that keeps the number with its calling code, formatted", async ({ page }) => {
  const received = await serve(page, screen(phoneBox('"+91 " + national.slice(0, 5) + "-" + national.slice(5)')));
  const { report, typed } = await fill(page);
  expect(report).toMatchObject(clicked);
  expect(received).toEqual([{ phone: "+91 98765-43210" }]);
  expect(typed).toEqual([number]);
});

test("takes a phone box beside a calling-code picker that shows the number's calling code", async ({
  page,
}) => {
  const received = await serve(page, screen(pickerAndBox("91")));
  const { report, typed } = await fill(page);
  expect(report).toMatchObject(clicked);
  expect(received).toEqual([{ dial: "91", phone: "9876543210" }]);
  expect(typed).toEqual([number]);
});

/** A fill the host stopped as it stops today: the typed field gone, nothing typed again or sent. */
const refusedAsToday = async (page: Page, received: readonly object[], result: Awaited<ReturnType<typeof fill>>) => {
  expect(result.report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "phone", status: "filled" }],
    submit: "refused",
    failureDetail: { phase: "not_found" },
  });
  expect(result.report).not.toHaveProperty("clicked");
  expectOriginsOnly(result.report);
  expect(result.typed).toEqual([number]);
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
};

test("refuses a phone box beside a calling-code picker that shows another calling code", async ({
  page,
}) => {
  const received = await serve(page, screen(pickerAndBox("1")));
  await refusedAsToday(page, received, await fill(page));
  await expect(page.locator("#phone")).toHaveValue("9876543210");
});

/** A swap's refusal for a calling code it can't trust beside the box: nothing clicked or typed again. */
const refusedForCallingCode = async (
  page: Page,
  received: readonly object[],
  result: Awaited<ReturnType<typeof fill>>,
) => {
  await refusedAsToday(page, received, result);
  expect(result.report).toMatchObject({ failureDetail: { context: { phoneSwap: "calling_code" } } });
};

for (const [name, picker] of [
  [
    "whose id says country",
    '<label>Country <select id="country" name="country"><option value="us">United States</option><option value="in" selected>India</option></select></label>',
  ],
  [
    "whose name and id say nothing of a country",
    '<label>Region <select id="r" name="region"><option value="US" selected>United States</option><option value="IN">India</option></select></label>',
  ],
] as const)
  test(`refuses a phone box beside a picker that shows no calling code, ${name}`, async ({ page }) => {
    const received = await serve(
      page,
      screen(`box.innerHTML = ${JSON.stringify(`${picker}<label>Mobile number <input id="phone" name="phone" type="tel"></label>`)};
document.getElementById("phone").value = national;`),
    );
    await refusedForCallingCode(page, received, await fill(page));
  });

test("refuses a phone box that holds the national number alone, with no picker beside it", async ({
  page,
}) => {
  // The site would get the national digits with no country: another country's number, maybe.
  const received = await serve(page, screen(phoneBox("national")));
  await refusedForCallingCode(page, received, await fill(page));
  await expect(page.locator("#phone")).toHaveValue("9876543210");
});

test("refuses a phone box whose picker sits outside its form and shows another calling code", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<label>Country <select id="dial" name="dial" form="elsewhere"><option value="1">+1</option><option value="91">+91</option></select></label>
${screen(`${phoneBox("national")}
document.getElementById("dial").value = "1";`)}`,
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("refuses a phone box whose picker sits in an open shadow root and shows another calling code", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<script>customElements.define("dial-pick", class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" }).innerHTML = '<select aria-label="Country code"><option>+1</option><option>+91</option></select>';
  }
});</script>
${screen(`box.innerHTML = '<dial-pick></dial-pick><label>Mobile number <input id="phone" name="phone" type="tel"></label>';
document.getElementById("phone").value = national;`)}`,
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("refuses a phone box whose only control showing its code sits far from it", async ({ page }) => {
  // The picker beside the box is a plain focusable element showing +1; a header button shows +91.
  const received = await serve(
    page,
    `<header><button type="button">Recent: +91</button></header>
${screen(`box.innerHTML = '<div class="picker" tabindex="0">US +1</div><label>Mobile number <input id="phone" name="phone" type="tel"></label>';
document.getElementById("phone").value = national;`)}`,
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("refuses a phone box whose country select and a box holding its code sit far from it", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<label>Country <select id="country" name="country"><option value="US" selected>United States</option><option value="IN">India</option></select></label>
<input id="hint" type="text" value="+91" readonly>
${screen(phoneBox("national"))}`,
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("refuses a phone box holding the whole number beside a plain focusable picker that shows another code", async ({
  page,
}) => {
  const received = await serve(
    page,
    screen(`box.innerHTML = '<div class="picker" tabindex="0">US +1</div><label>Mobile number <input id="phone" name="phone" type="tel"></label>';
document.getElementById("phone").value = "+91" + national;`),
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("takes a phone box beside a picker that shows its code, whatever a support number far from it shows", async ({
  page,
}) => {
  const received = await serve(
    page,
    `${screen(pickerAndBox("91"))}
<footer><button type="button">Call us +1 800 555 0100</button></footer>`,
  );
  const { report, typed } = await fill(page);
  expect(report).toMatchObject(clicked);
  expect(received).toEqual([{ dial: "91", phone: "9876543210" }]);
  expect(typed).toEqual([number]);
});

test("refuses a phone box beside a plain button that shows another calling code", async ({ page }) => {
  const received = await serve(
    page,
    screen(`box.innerHTML = '<button type="button" class="flag">US +1</button><label>Mobile number <input id="phone" name="phone" type="tel"></label>';
document.getElementById("phone").value = national;`),
  );
  await refusedForCallingCode(page, received, await fill(page));
});

test("refuses a phone box in another origin's frame", async ({ page }) => {
  const received = await serve(page, screen(`box.innerHTML = '<iframe src="${other}/phone"></iframe>';`), {
    [`${other}/phone`]: '<input id="phone" name="phone" type="tel" value="9876543210">',
  });
  await refusedAsToday(page, received, await fill(page));
});

test("refuses a phone box in another document of the same origin", async ({ page }) => {
  const received = await serve(page, screen(`box.innerHTML = '<iframe src="${site}/phone"></iframe>';`), {
    [`${site}/phone`]: '<input id="phone" name="phone" type="tel" value="9876543210">',
  });
  await refusedAsToday(page, received, await fill(page));
});

test("refuses a phone box in another form", async ({ page }) => {
  const received = await serve(
    page,
    screen(`box.remove();
document.body.insertAdjacentHTML("beforeend", '<form action="/elsewhere" method="post"><label>Mobile number <input id="phone" name="phone" type="tel"></label></form>');
document.getElementById("phone").value = national;`),
  );
  await refusedAsToday(page, received, await fill(page));
});

for (const [name, box] of [
  ["a password box", '<label>Password <input id="other" name="password" type="password"></label>'],
  ["a code box", '<label>Code <input id="other" name="otp" autocomplete="one-time-code"></label>'],
  ["a code box that takes digits as a phone box does", '<label>PIN <input id="other" name="pin" type="tel"></label>'],
  ["a text box that names no phone", '<label>Name <input id="other" name="name"></label>'],
] as const)
  test(`refuses a swap to ${name}`, async ({ page }) => {
    const received = await serve(
      page,
      screen(`box.innerHTML = ${JSON.stringify(box)};
document.getElementById("other").value = national;`),
    );
    await refusedAsToday(page, received, await fill(page));
  });

test("refuses a phone box that holds another number", async ({ page }) => {
  const received = await serve(page, screen(phoneBox('"9999988888"')));
  await refusedAsToday(page, received, await fill(page));
  await expect(page.locator("#phone")).toHaveValue("9999988888");
});

test("refuses a phone box that holds the number cut short", async ({ page }) => {
  const received = await serve(page, screen(phoneBox("national.slice(1)")));
  await refusedAsToday(page, received, await fill(page));
});

test("refuses a swap that clears the value", async ({ page }) => {
  const received = await serve(page, screen(phoneBox('""')));
  await refusedAsToday(page, received, await fill(page));
  await expect(page.locator("#phone")).toHaveValue("");
});

test("refuses two phone boxes, either of which may be the replacement", async ({ page }) => {
  const received = await serve(
    page,
    screen(`box.innerHTML = '<input id="phone" name="phone" type="tel"><input id="phone2" name="phone2" type="tel">';
document.getElementById("phone").value = national;
document.getElementById("phone2").value = national;`),
  );
  await refusedAsToday(page, received, await fill(page));
});

/** The screen with no form: its button sends what the phone box and picker hold by script. */
const formless = (chosen: string) => `<div id="box"><label>Email or mobile number <input id="identifier" name="identifier"></label></div>
<button id="continue" type="button">Continue</button>
<script>
const box = document.getElementById("box");
document.getElementById("identifier").addEventListener("input", (event) => {
  const national = event.target.value.replace(/[^0-9]/g, "").replace(/^91/, "");
  box.innerHTML = '<select id="dial"><option value="1">+1</option><option value="91">+91</option></select><input id="phone" type="tel">';
  document.getElementById("dial").value = ${JSON.stringify(chosen)};
  document.getElementById("phone").value = national;
});
document.getElementById("continue").addEventListener("click", () => {
  fetch("/session", { method: "POST", body: new URLSearchParams({
    dial: document.getElementById("dial").value,
    phone: document.getElementById("phone").value,
  }) });
});
</script>`;

test("reads a picker beside a phone box that sits in no form", async ({ page }) => {
  const received = await serve(page, formless("91"));
  const { report, typed } = await fill(page);
  expect(report).toMatchObject(clicked);
  await expect.poll(() => received).toEqual([{ dial: "91", phone: "9876543210" }]);
  expect(typed).toEqual([number]);
});

test("refuses a picker beside a phone box in no form that shows another calling code", async ({
  page,
}) => {
  const received = await serve(page, formless("1"));
  await refusedAsToday(page, received, await fill(page));
});

test("refuses a phone box in a frame of its own that reads as the screen's place, on a screen with no form", async ({
  page,
}) => {
  // A srcdoc frame has its parent's origin and address, and a box in no form sends nowhere, so only
  // the document itself tells this box from one in the document the host typed in.
  const received = await serve(
    page,
    `<div id="box"><label>Email or mobile number <input id="identifier" name="identifier"></label></div>
<button id="continue" type="button">Continue</button>
<script>
document.getElementById("identifier").addEventListener("input", () => {
  document.getElementById("box").innerHTML = '<iframe srcdoc="<input id=phone name=phone type=tel value=9876543210>"></iframe>';
});
document.getElementById("continue").addEventListener("click", () => {
  fetch("/session", { method: "POST", body: new URLSearchParams({ clicked: "yes" }) });
});
</script>`,
  );
  const { report, typed } = await fill(page);
  expect(report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    failureDetail: { phase: "not_found", context: { phoneSwap: "another_document" } },
  });
  expect(typed).toEqual([number]);
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
});

test("types nothing again when the submit beside the phone box stays disabled", async ({ page }) => {
  const received = await serve(
    page,
    screen(`${phoneBox('"+91" + national')}
document.getElementById("continue").disabled = true;`),
  );
  const { report, typed } = await fill(page);
  expect(report).toMatchObject({ outcome: "filled", submit: "stayed_disabled" });
  expect(typed).toEqual([number]);
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#phone")).toHaveValue("+919876543210");
});

test("types nothing again when the submit stays disabled and the page puts the identifier box back", async ({
  page,
}) => {
  // The identifier box comes back beside the phone box while the host waits on the submit: the
  // host's wait for a page that enables its submit only on key presses must not type into it.
  const received = await serve(
    page,
    screen(`${phoneBox('"+91" + national')}
document.getElementById("continue").disabled = true;
setTimeout(() => {
  box.insertAdjacentHTML("beforeend", '<label>Email or mobile number <input id="identifier" name="identifier" autocomplete="username"></label>');
}, 2_000);`),
  );
  const { report, typed } = await fill(page);
  expect(report).toMatchObject({ outcome: "filled", submit: "stayed_disabled" });
  expect(typed).toEqual([number]);
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#identifier")).toHaveValue("");
});

test("leaves an email that took the box's place to the refusal of a field gone", async ({ page }) => {
  const received = await serve(
    page,
    `<form action="/session" method="post"><div id="box"><input id="identifier" name="identifier"></div><button id="continue">Continue</button></form>
<script>
const box = document.getElementById("box");
document.getElementById("identifier").addEventListener("input", (event) => {
  const typed = event.target.value;
  box.innerHTML = '<input id="phone" name="phone" type="tel">';
  document.getElementById("phone").value = typed;
});
</script>`,
  );
  const step: AutofillStep = {
    fields: [{ selector: "#identifier", slot: "email", accepts: ["email", "phone"] }],
    submit: "#continue",
  };
  const browser = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: browser, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({ step, values: ["ada@example.test"], inspection, page: browser, keyboard, settleMs: 2_000 }),
  );
  expect(report).toMatchObject({ outcome: "filled", submit: "refused", failureDetail: { phase: "not_found" } });
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
});

// A run's sign-in by a recipe that recorded only the identifier box, as the build saw it: the swap
// goes unrecorded, and the next recorded screen follows the screen's own submit.
test("a run signs in through a swap, then the screen the submit leads to", async ({ page }) => {
  const posted: Record<string, string>[] = [];
  const codes: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/session") {
      posted.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/verify"><label>Code <input id="code" name="code" autocomplete="one-time-code"></label><button id="verify">Verify</button></form>',
      });
    } else if (request.method() === "POST" && path === "/verify") {
      codes.push(new URLSearchParams(request.postData() ?? "").get("code") ?? "");
      await route.fulfill({ contentType: "text/html", body: '<h1 id="account">Your account</h1>' });
    } else await route.fulfill({ contentType: "text/html", body: screen(pickerAndBox("91")) });
  });
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      return question?.type === "credential"
        ? { login: { identifierKind: "phone", username: number, saveLogin: false } }
        : { [question?.id ?? "code"]: "424242" };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe: {
          version: 1,
          steps: [
            {
              page: `${site}/login`,
              fields: [{ selector: "#identifier", accepts: ["email", "phone"] }],
              submit: "#continue",
              submittedBy: "host",
            },
            {
              page: `${site}/session`,
              fields: [{ selector: "#code", slot: "code" }],
              submit: "#verify",
              submittedBy: "host",
            },
          ],
          signedIn: { selector: "#account" },
        },
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
          passwordless: { identifierKinds: ["email", "phone"], password: false },
        }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(posted).toEqual([{ dial: "91", phone: "9876543210" }]);
  expect(codes).toEqual(["424242"]);
});
