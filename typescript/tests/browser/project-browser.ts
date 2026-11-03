import { test } from "@playwright/test";
import type { PlaywrightOptions } from "../../src/execution/playwright-execute.js";

/**
 * The native executor's browser for the running test's project: Chromium by default, and on the
 * firefox and camoufox projects Firefox, with the build the project names. A host the test makes
 * itself then drives the browser the project tests.
 */
export const projectBrowser = (): Pick<PlaywrightOptions, "browser" | "executablePath"> => {
  const project = test.info().project;
  if (project.use.browserName !== "firefox") return {};
  const executablePath: unknown = project.metadata["executablePath"];
  return { browser: "firefox", ...(typeof executablePath === "string" ? { executablePath } : {}) };
};
