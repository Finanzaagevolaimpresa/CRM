import { defineConfig } from "@playwright/test";
import assert from "node:assert/strict";

const spki = process.env.PR140_CI_CERT_SPKI;
if (spki) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.PRACTICE_READINESS_PACKAGED, "1");
  assert.match(spki, /^[A-Za-z0-9+/]{43}=$/);
}

export default defineConfig({
  testDir: ".",
  testMatch: "readiness.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: {
    browserName: "chromium",
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
    launchOptions: { args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [] },
  },
});
