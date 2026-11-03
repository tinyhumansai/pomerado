// Failure modes covered: an engine that takes its browser's launcher from another Playwright build
// than the one chosen, or an executor that accepts a browser it has no engine for.
import * as playwright from "playwright";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { browserEngine } from "../../src/execution/browser-engine.js";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";

describe("browser engines", () => {
  it("launches Chromium from the chosen Playwright build", () => {
    expect(browserEngine("chromium").launcher(playwright)).toBe(playwright.chromium);
  });

  it("refuses a browser it has no engine for", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makePlaywrightExecutor({ browser: "webkit" as never })),
    );
    if (Exit.isSuccess(exit)) throw new Error("The executor started");
    expect(Cause.squash(exit.cause)).toMatchObject({ message: "browser must be chromium" });
  });
});
