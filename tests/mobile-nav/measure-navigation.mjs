import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { probeFixture } from "./readiness.mjs";

const [sourceRoot, label, evidenceDir, portText] = process.argv.slice(2);
if (!sourceRoot || !["baseline", "candidate"].includes(label) || !evidenceDir || !portText) {
  throw new Error("usage: measure-navigation.mjs <source-root> <baseline|candidate> <evidence-dir> <port>");
}
const port = Number(portText);
const server = spawn(path.join(sourceRoot, "node_modules/.bin/next"), ["dev", "--webpack", "tests/mobile-nav/fixture", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: sourceRoot,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
let spawnError;
let browser;
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
server.on("error", (error) => { spawnError = error; });

try {
  const url = `http://127.0.0.1:${port}/?profile=admin`;
  console.log(`MOBILE_NAV_READINESS ${label} starting`);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (spawnError || server.exitCode !== null) {
      throw new Error(`fixture exited before readiness (${spawnError?.message ?? server.exitCode}): ${serverLog.slice(-4000)}`);
    }
    if (await probeFixture(url, "Contenuto commerciale raggiungibile")) break;
    if (attempt % 10 === 9) console.log(`MOBILE_NAV_READINESS ${label} attempt ${attempt + 1}`);
    if (attempt === 119) throw new Error(`fixture did not start: ${serverLog.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`MOBILE_NAV_READINESS ${label} ready`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  await page.goto(url);
  const metrics = await page.evaluate(() => {
    const content = document.querySelector("[data-testid=page-content]");
    const aside = document.querySelector("aside");
    const trigger = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Apri menu"));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      contentTop: content?.getBoundingClientRect().top ?? null,
      asideHeight: aside?.getBoundingClientRect().height ?? null,
      bodyScrollHeight: document.body.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      mobileTriggerVisible: Boolean(trigger && trigger.getClientRects().length),
    };
  });
  console.log(`MOBILE_NAV_MEASUREMENT ${JSON.stringify({ label, metrics })}`);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${label}-320x568.png`), fullPage: false });
  await writeFile(path.join(evidenceDir, `${label}.json`), `${JSON.stringify({ label, sourceRoot, metrics }, null, 2)}\n`);
  if (label === "baseline" && (!(metrics.contentTop && metrics.contentTop > metrics.viewport.height) || metrics.mobileTriggerVisible)) {
    throw new Error(`baseline reproduction failed: ${JSON.stringify(metrics)}`);
  }
  if (label === "candidate" && (!metrics.mobileTriggerVisible || metrics.contentTop === null || metrics.contentTop >= metrics.viewport.height)) {
    throw new Error(`candidate measurement failed: ${JSON.stringify(metrics)}`);
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    const stopped = await Promise.race([
      once(server, "exit").then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  }
}
