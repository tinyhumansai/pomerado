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
      testMatch: [
        "**/native-firefox.spec.ts",
        "**/host-hooks.spec.ts",
        "**/choose.spec.ts",
        "**/quantity.spec.ts",
        "**/amounts.spec.ts",
        "**/qr-code.spec.ts",
        "**/dismiss-patterns.spec.ts",
        "**/order-press.spec.ts",
        "**/location-pick.spec.ts",
        "**/autofill-phone-read-back.spec.ts",
        "**/autofill-calling-code.spec.ts",
        "**/autofill-phone-swap.spec.ts",
        "**/autofill-code-boxes.spec.ts",
        "**/sign-in-code-boxes.spec.ts",
        "**/sign-in-code-sends-itself.spec.ts",
        "**/sign-in-code-closes-in-place.spec.ts",
        "**/sign-in-code-either-side.spec.ts",
        "**/sign-in-code-resend.spec.ts",
      ],
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
