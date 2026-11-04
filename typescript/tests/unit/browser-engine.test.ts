// Failure modes covered: an engine that takes its browser's launcher from another Playwright build
// than the one chosen; a launch that drops the Firefox engine's preferences or changes Chromium's;
// and an executor that accepts a browser it has no engine for.
import type * as playwright from "playwright";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { browserEngine } from "../../src/execution/browser-engine.js";
import {
  makePlaywrightExecutor,
  nativeLaunchOptions,
} from "../../src/execution/playwright-execute.js";

describe("browser engines", () => {
  it("launches each browser from the chosen Playwright build", () => {
    const build = { chromium: { name: "chosen chromium" }, firefox: { name: "chosen firefox" } };
    const chosen = build as unknown as typeof playwright;
    expect(browserEngine("chromium").launcher(chosen)).toBe(build.chromium);
    expect(browserEngine("firefox").launcher(chosen)).toBe(build.firefox);
  });

  it("launches Firefox with its engine's preferences, and Chromium as before", () => {
    expect(nativeLaunchOptions(browserEngine("chromium"), {}, 30_000)).toEqual({
      headless: true,
      timeout: 30_000,
    });
    expect(
      nativeLaunchOptions(browserEngine("firefox"), { headless: false, executablePath: "/opt/camoufox" }, 9_000),
    ).toEqual({
      firefoxUserPrefs: { "dom.security.https_first": false },
      headless: false,
      timeout: 9_000,
      executablePath: "/opt/camoufox",
    });
  });

  it("refuses a browser it has no engine for", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makePlaywrightExecutor({ browser: "webkit" as never })),
    );
    if (Exit.isSuccess(exit)) throw new Error("The executor started");
    expect(Cause.squash(exit.cause)).toMatchObject({
      message: "browser must be chromium or firefox",
    });
  });
});
