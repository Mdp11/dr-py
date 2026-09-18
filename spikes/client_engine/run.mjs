// THROWAWAY SPIKE — headless runner: serves both origins, drives Chromium
// through the benchmark twice (cold, then warm HTTP cache) and reads the JS
// replica's heap over CDP. Usage: pixi run -e frontend node spikes/client_engine/run.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_PORT, startServers } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, "../../frontend/package.json"));
const { chromium } = require("playwright-core");

const APP = `http://localhost:${APP_PORT}`;
const servers = startServers();
const browser = await chromium.launch({ headless: true });
const report = { chromium: browser.version(), runs: [] };

try {
  const context = await browser.newContext();
  const QUERY = {
    cold: "",
    warm: "?python-only",
    gc: "?python-only&fast=gc",
    orjson: "?python-only&fast=orjson",
    stores: "?mode=stores",
  };
  for (const label of (process.env.RUNS ?? "cold,warm,gc,orjson,stores").split(",")) {
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && console.error(`[page ${label}]`, m.text()));
    page.on("pageerror", (e) => console.error(`[pageerror ${label}]`, e.message));
    await page.goto(`${APP}/${QUERY[label]}`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 900_000 });
    report.runs.push({ label, ...(await page.evaluate(() => window.__results)) });
    await page.close();
  }

  const mem = await context.newPage();
  const cdp = await context.newCDPSession(mem);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const before = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  await mem.goto(`${APP}/jsmem.html`);
  await mem.waitForFunction(() => window.__done === true, null, { timeout: 300_000 });
  await cdp.send("HeapProfiler.collectGarbage");
  const after = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  report.js_replica_heap_mb = Math.round((after - before) / 1048576);
} finally {
  await browser.close();
  servers.close();
}

const outFile = process.env.OUT ?? path.join(HERE, "results.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error(`\nwrote ${outFile}`);
