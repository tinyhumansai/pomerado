import { defineConfig } from "@playwright/test";
import { firefoxPrefs } from "./typescript/src/execution/browser-engine.js";

// Suspected destination-boundary bugs stop instead of continuing, locally as in CI. Workers
// inherit this process's environment.
process.env["POMERADO_BOUNDARY_STRICT"] ??= "1";

const camoufox = process.env["CAMOUFOX_EXECUTABLE"] || undefined;

export default defineConfig({
  testDir: "./typescript/tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/browser-results.json" }],
  ],
  metadata: {
    revision: process.env["GITHUB_SHA"] ?? "local-working-tree",
    command: "pnpm test:browser",
    fixtures: "typescript/tests/browser (controlled local fixtures)",
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: "**/native-firefox.spec.ts" },
    // Firefox runs with the preferences a Firefox executor launches it with.
    {
      name: "firefox",
      use: { browserName: "firefox", launchOptions: { firefoxUserPrefs: firefoxPrefs } },
      testMatch: "**/native-firefox.spec.ts",
    },
    // Camoufox, a Firefox build, when CAMOUFOX_EXECUTABLE names its binary.
    ...(camoufox === undefined
      ? []
      : [
          {
            name: "camoufox",
            use: {
              browserName: "firefox" as const,
              launchOptions: { executablePath: camoufox, firefoxUserPrefs: firefoxPrefs },
            },
            metadata: { executablePath: camoufox },
          },
        ]),
  ],
});
