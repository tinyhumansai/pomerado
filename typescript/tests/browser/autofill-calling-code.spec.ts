import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { typedValues } from "../../src/runtime/autofill-values.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A phone sign-in whose screen has a calling-code picker beside a box that keeps only the national
// number. The step names the picker as its own field, which takes the number's calling code, and
// the box as one that takes the national number. The host picks the calling code in the picker,
// checks the choice stuck, then types the national number and reads it back. A number that says
// no calling code, and a picker that offers none or several options for it, types nothing.

const site = "https://login.example.test";
const host = "login.example.test";
// A run's whole sign-in, or a picker's list opened and read: more than the default 30 s allows on a
// busy machine.
test.describe.configure({ timeout: 120_000 });

const pickerStep: AutofillStep = {
  fields: [
    { selector: "#country", slot: "phone", accepts: ["phone"], format: "calling_code" },
    { selector: "#phone", slot: "phone", accepts: ["phone"], format: "national" },
  ],
  submit: "#send",
};

/**
 * A native picker that starts on the first country, as most do, listing two countries that share
 * +1 and one whose code starts with +1 but is longer, and a box of ten digits at most.
 */
const nativeScreen = (script = "") => `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<option value="US">United States (+1)</option>
<option value="CA">Canada (+1)</option>
<option value="AG">Antigua and Barbuda (+1 268)</option>
<option value="GB">United Kingdom (+44)</option>
<option value="IN">India (+91)</option>
<option value="AE">United Arab Emirates (+971)</option>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form><script>${script}</script>`;

/**
 * A custom picker: a button that opens its own list, showing the chosen calling code, with the
 * choice kept in a hidden input the form posts.
 */
const customScreen = `<form action="/session" method="post">
<input type="hidden" name="country" value="+1">
<button type="button" id="country" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="dial-codes" aria-label="Country code">+1</button>
<ul id="dial-codes" role="listbox" hidden>
<li role="option" data-value="+1" aria-selected="true">United States +1</li>
<li role="option" data-value="+44">United Kingdom +44</li>
<li role="option" data-value="+91">India +91</li>
<li role="option" data-value="+971">United Arab Emirates +971</li>
</ul>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form><script>
const button = document.getElementById("country");
const list = document.getElementById("dial-codes");
button.addEventListener("click", () => {
  list.hidden = !list.hidden;
  button.setAttribute("aria-expanded", String(!list.hidden));
});
for (const option of list.querySelectorAll("[role=option]"))
  option.addEventListener("click", () => {
    for (const other of list.querySelectorAll("[role=option]")) other.setAttribute("aria-selected", "false");
    option.setAttribute("aria-selected", "true");
    button.textContent = option.dataset.value;
    document.querySelector("input[name=country]").value = option.dataset.value;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
</script>`;

/** Serves the screen and keeps each form the site receives. */
const serve = async (page: Page, body: string) => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: "<p>Code sent</p>" });
    } else await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${site}/login`);
  return received;
};

/** The host's fill of the picker screen, inspected first, with `phone` as the login's number. */
const signIn = async (page: Page, phone: string) => {
  const browser = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: pickerStep, page: browser, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: pickerStep,
      values: typedValues(pickerStep, [phone, phone]),
      inspection,
      page: browser,
      keyboard,
      settleMs: 2_000,
    }),
  );
  return { report, calls: browser.calls };
};

for (const [name, screen, chosen] of [
  ["a native picker", nativeScreen(), "IN"],
  ["a custom picker", customScreen, "+91"],
] as const)
  test(`picks the number's calling code in ${name}, then types and reads back the national number`, async ({
    page,
  }) => {
    const received = await serve(page, screen);
    const { report, calls } = await signIn(page, "+91 98765 43210");
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "phone", status: "filled" },
        { slot: "phone", status: "filled" },
      ],
      submit: "clicked",
    });
    expect(received).toEqual([{ country: chosen, phone: "9876543210" }]);
    // The national number goes only through the host's own typing, never a call's script.
    expectNotCarried(calls, "9876543210");
  });

test("picks a code that is the start of a longer one, and never the longer one", async ({ page }) => {
  // +1 268 is one code, Antigua and Barbuda's, never +1 with 268 after it.
  const received = await serve(
    page,
    `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<option value="AG">Antigua and Barbuda (+1 268)</option>
<option value="US">United States (+1)</option>
<option value="GB">United Kingdom (+44)</option>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form>`,
  );
  const { report } = await signIn(page, "+1 415 555 0134");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toEqual([{ country: "US", phone: "4155550134" }]);
});

test("picks an option by its value with its plus, and takes a country listed twice as one", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<optgroup label="Popular"><option value="+91">India</option></optgroup>
<optgroup label="All"><option value="+1">United States</option><option value="+91">India</option></optgroup>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toEqual([{ country: "+91", phone: "9876543210" }]);
});

test("never takes an option's bare number for a code, as a list position may be", async ({ page }) => {
  // The option at value 91 is another country's: only a label or value with a plus names a code.
  const received = await serve(
    page,
    `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<option value="1">Afghanistan (+93)</option>
<option value="91">Norway (+47)</option>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "refused", reason: "calling_code_unoffered", target: 0 });
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#country")).toHaveValue("1");
});

test("never picks an option whose label shows another country's code, whatever its value", async ({ page }) => {
  // The site would post +91 beside a list entry that shows Norway's code: the label and value
  // disagree, so the option names no code the host can trust.
  const received = await serve(
    page,
    `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<option value="+1">United States (+1)</option>
<option value="+91">Norway (+47)</option>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "refused", reason: "calling_code_unoffered", target: 0 });
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#country")).toHaveValue("+1");
});

test("never picks an option whose value names another country's code, whatever its label", async ({ page }) => {
  // The list shows India's code, but the site would post Norway's: the option names no code the
  // host can trust.
  const received = await serve(
    page,
    `<form action="/session" method="post">
<label>Country <select id="country" name="country">
<option value="+1">United States (+1)</option>
<option value="+47">India (+91)</option>
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "refused", reason: "calling_code_unoffered", target: 0 });
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#country")).toHaveValue("+1");
});

test("clicks a covered submit again beside a custom picker, which holds no text a read could count", async ({
  page,
}) => {
  // A fixed footer covers the submit. The picker is a button, so only the box holds what the host
  // typed: counting the picker as a typed field would stop a screen whose every field is in place.
  const received = await serve(
    page,
    `${customScreen}<style>#send { position: fixed; bottom: 4px; left: 4px; }</style>
<div id="footer" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 60px; z-index: 5; background: white">Footer</div>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "filled", submit: "blocked" });
  expect(received).toEqual([]);
  const browser = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: pickerStep, page: browser, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const again = await Effect.runPromise(
    resubmitAutofillStep({ step: pickerStep, inspection, page: browser, settleMs: 1_000 }),
  );
  expect(again).toMatchObject({ outcome: "filled", submit: "clicked", via: "keyboard" });
  await expect.poll(() => received).toEqual([{ country: "+91", phone: "9876543210" }]);
});

/**
 * A picker whose options show country names alone, their codes in their values, and whose page
 * puts it back on `back` a moment after each choice: a country whose name sits inside the chosen
 * one's, or holds it. `custom` draws it as a button that opens its own list; with `staleTitle`,
 * its title keeps the chosen country once its words go back.
 */
const revertingScreen = (
  options: readonly (readonly [string, string])[],
  back: string,
  custom: boolean,
  staleTitle = false,
) =>
  custom
    ? `<form action="/session" method="post">
<input type="hidden" name="country" value="${back}">
<button type="button" id="country" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="dial">${options.find(([value]) => value === back)?.[1]}</button>
<ul id="dial" role="listbox" hidden>
${options.map(([value, name]) => `<li role="option" data-value="${value}">${name}</li>`).join("\n")}
</ul>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form><script>
const button = document.getElementById("country");
const list = document.getElementById("dial");
const kept = document.querySelector("input[name=country]");
const backName = button.textContent;
button.addEventListener("click", () => {
  list.hidden = !list.hidden;
  button.setAttribute("aria-expanded", String(!list.hidden));
});
for (const option of list.querySelectorAll("[role=option]"))
  option.addEventListener("click", () => {
    button.textContent = option.textContent;
    kept.value = option.dataset.value;
    ${staleTitle ? 'button.setAttribute("title", option.textContent);' : ""}
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    setTimeout(() => { button.textContent = backName; kept.value = ${JSON.stringify(back)}; }, 50);
  });
</script>`
    : `<form action="/session" method="post">
<label>Country <select id="country" name="country">
${options.map(([value, name]) => `<option value="${value}"${value === back ? " selected" : ""}>${name}</option>`).join("\n")}
</select></label>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form><script>document.getElementById("country").addEventListener("change", (event) => {
  setTimeout(() => { event.target.value = ${JSON.stringify(back)}; }, 50);
});</script>`;

const sudans = [
  ["+249", "Sudan"],
  ["+211", "South Sudan"],
  ["+1", "United States"],
] as const;
const guineas = [
  ["+675", "Papua New Guinea"],
  ["+224", "Guinea"],
  ["+1", "United States"],
] as const;
for (const [name, options, back, phone, custom, staleTitle] of [
  ["a native picker that goes back to a country whose name sits inside the chosen one", sudans, "+249", "+211 912 345 678", false, false],
  ["a custom picker that goes back to a country whose name sits inside the chosen one", sudans, "+249", "+211 912 345 678", true, false],
  ["a native picker that goes back to a country whose name holds the chosen one", guineas, "+675", "+224 621 23 45 67", false, false],
  ["a custom picker that goes back to a country whose name holds the chosen one", guineas, "+675", "+224 621 23 45 67", true, false],
  ["a custom picker whose words go back while its title keeps the chosen country", sudans, "+249", "+211 912 345 678", true, true],
] as const)
  test(`types nothing at ${name}`, async ({ page }) => {
    const received = await serve(page, revertingScreen(options, back, custom, staleTitle));
    const { report } = await signIn(page, phone);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "phone", status: "failed" },
        { slot: "phone", status: "not_attempted" },
      ],
      submit: "not_attempted",
    });
    await page.waitForTimeout(300);
    expect(received).toEqual([]);
    await expect(page.locator("#phone")).toHaveValue("");
  });

test("picks the code in a picker that shows only a flag, by the label its control says", async ({ page }) => {
  // The control has no words of its own: its aria-label says the chosen country.
  const received = await serve(
    page,
    `<form action="/session" method="post">
<input type="hidden" name="country" value="+1">
<button type="button" id="country" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="flags" aria-label="United States"><span class="flag"></span></button>
<ul id="flags" role="listbox" hidden>
<li role="option" data-value="+1">United States</li>
<li role="option" data-value="+91">India</li>
</ul>
<label>Mobile number <input id="phone" name="phone" type="tel" maxlength="10"></label>
<button id="send">Send code</button>
</form><script>
const button = document.getElementById("country");
const list = document.getElementById("flags");
button.addEventListener("click", () => {
  list.hidden = !list.hidden;
  button.setAttribute("aria-expanded", String(!list.hidden));
});
for (const option of list.querySelectorAll("[role=option]"))
  option.addEventListener("click", () => {
    for (const other of list.querySelectorAll("[role=option]")) other.setAttribute("aria-selected", "false");
    option.setAttribute("aria-selected", "true");
    button.setAttribute("aria-label", option.textContent);
    document.querySelector("input[name=country]").value = option.dataset.value;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
</script>`,
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toEqual([{ country: "+91", phone: "9876543210" }]);
});

for (const [name, phone, reason] of [
  ["a number that says no calling code", "98765 43210", "calling_code_missing"],
  ["a code the picker offers for two countries", "+1 415 555 0134", "calling_code_ambiguous"],
  ["a code the picker does not offer", "+81 90 1234 5678", "calling_code_unoffered"],
] as const)
  test(`types nothing for ${name}`, async ({ page }) => {
    const received = await serve(page, nativeScreen());
    const { report } = await signIn(page, phone);
    expect(report).toMatchObject({ outcome: "refused", reason, target: 0 });
    await page.waitForTimeout(300);
    expect(received).toEqual([]);
    await expect(page.locator("#phone")).toHaveValue("");
    await expect(page.locator("#country")).toHaveValue("US");
  });

test("types nothing when the picker's choice does not stick", async ({ page }) => {
  // The page puts the picker back on its first country a moment after each change.
  const received = await serve(
    page,
    nativeScreen(`document.getElementById("country").addEventListener("change", (event) => {
  setTimeout(() => { event.target.value = "US"; }, 50);
});`),
  );
  const { report } = await signIn(page, "+91 98765 43210");
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "phone", status: "failed" },
      { slot: "phone", status: "not_attempted" },
    ],
    submit: "not_attempted",
  });
  await page.waitForTimeout(300);
  expect(received).toEqual([]);
  await expect(page.locator("#phone")).toHaveValue("");
});

// A run's sign-in by a recipe that records the picker, answered with a host's handles: the picker
// takes the calling code of the phone revealed for its own document, and the box its national
// number, each from one reveal.
test("a run picks the calling code of a revealed phone number and signs in", async ({ page }) => {
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
    } else await route.fulfill({ contentType: "text/html", body: nativeScreen() });
  });
  const recipe = {
    version: 11,
    steps: [
      {
        page: `${site}/login`,
        fields: [
          { selector: "#country", accepts: ["phone"], format: "calling_code" },
          { selector: "#phone", accepts: ["phone"], format: "national" },
        ],
        submit: "#send",
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
  } as const;
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const handles = new Map([
    ["sec_phone", "+91 98765 43210"],
    ["sec_code", "424242"],
  ]);
  const revealed: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      return question?.type === "credential"
        ? { login: { identifierKind: "phone", username: "sec_phone", saveLogin: false } }
        : { [question?.id ?? "code"]: "sec_code" };
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
        reveal: (value, origin) =>
          Effect.sync(() => {
            revealed.push(`${value} ${origin}`);
            return handles.get(value) ?? value;
          }),
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(posted).toEqual([{ country: "IN", phone: "9876543210" }]);
  expect(codes).toEqual(["424242"]);
  // One reveal for both of the screen's phone fields, in the document they sit in.
  expect(revealed).toEqual([`sec_phone ${site}`, `sec_code ${site}`]);
  expectNotCarried(browser.calls, "9876543210");
});
