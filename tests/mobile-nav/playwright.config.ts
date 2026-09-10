import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "mobile-navigation.spec.ts",
  outputDir: "../../test-results/mobile-nav",
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:3417", screenshot: "only-on-failure" },
  webServer: {
    command: "npx next dev --webpack fixture --hostname 127.0.0.1 --port 3417",
    url: "http://127.0.0.1:3417",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
