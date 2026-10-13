// Browser smoke test for the FauxTCI page (spec section 8).
//
// If Playwright is resolvable (as a local dependency, or installed globally:
// `npm root -g`), a static server is started on an ephemeral port serving
// the repository, index.html is opened in Chromium, a propofol case is run
// at 60x to maintenance, a hand bolus is given, and screenshots are written
// to test-results/.  Without Playwright the test is skipped with a message,
// so `node --test test/*.js` passes on any machine with Node alone.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "test-results");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Playwright: a local install first, then the global one.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e) {
    // not installed locally
  }
  try {
    const globalRoot = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const require = createRequire(import.meta.url);
    return require(path.join(globalRoot, "playwright"));
  } catch (e) {
    return null;
  }
}

// A tiny static server over node:http, serving the repository read-only.
function serve(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const playwright = await loadPlaywright();

test("the page runs a propofol case to maintenance in Chromium", { skip: playwright ? false : "playwright is not installed (npm install -g playwright; npx playwright install chromium)", timeout: 110000 }, async () => {
  const { server, url } = await serve(ROOT);
  let browser = null;
  try {
    browser = await playwright.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("requestfailed", (req) => consoleErrors.push(`request failed: ${req.url()}`));

    await page.goto(url + "index.html", { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("concentration").options.length > 0);
    assert.equal(await page.title(), "FauxTCI");

    // The Server URL field and its CORS note belong to the HTTP transport
    // only: the hidden attribute must beat the .field display rule.
    const urlFieldHeight = () => page.evaluate(() => document.getElementById("base-url").getBoundingClientRect().height);
    assert.equal(await page.inputValue("#transport"), "local");
    assert.equal(await urlFieldHeight(), 0, "the Server URL field is hidden for the in-page controller");
    await page.selectOption("#transport", "http");
    assert.ok((await urlFieldHeight()) > 0, "the Server URL field shows for the HTTP transport");
    await page.selectOption("#transport", "local");
    assert.equal(await urlFieldHeight(), 0, "and hides again");

    // The wide layout: the API conversation on the right, about a third of
    // the width; on the left the setup above the pump screen, two boxes of
    // equal height that fit the viewport, with the target entry and the
    // charts in the same box (no scrolling between them).
    const rect = (sel) => page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }, sel);
    const visible = (sel) => page.evaluate((s) => {
      const n = document.querySelector(s);
      return n !== null && n.getBoundingClientRect().height > 0;
    }, sel);
    const api = await rect("#api-panel");
    const setup = await rect("#setup-card");
    const screen = await rect("#pump-screen");
    assert.ok(api.left >= setup.right, "the API panel is to the right of the setup");
    assert.ok(api.width / 1400 > 0.28 && api.width / 1400 < 0.4, `the API panel is about a third of the width (${api.width} px of 1400)`);
    assert.ok(screen.top >= setup.bottom, "the pump screen is below the setup");
    assert.ok(Math.abs(setup.height - screen.height) <= 2, `the two boxes are the same height (${setup.height} vs ${screen.height})`);
    assert.ok(screen.bottom <= 1000, `the pump screen fits the 1000 px viewport (bottom at ${screen.bottom})`);
    const innerScroll = (sel) => page.evaluate((s) => { const n = document.querySelector(s); return n.scrollHeight - n.clientHeight; }, sel);
    assert.ok((await innerScroll("#setup-card")) <= 1, `the setup fits its box without scrolling (${await innerScroll("#setup-card")} px over)`);
    assert.ok((await innerScroll("#pump-screen")) <= 1, `the pump screen fits its box without scrolling (${await innerScroll("#pump-screen")} px over)`);
    assert.ok(await page.$("#pump-screen #target-value"), "the target entry is in the pump screen");
    assert.ok(await page.$("#pump-screen #chart-ce"), "the concentration chart is in the pump screen");
    const chartCe = await rect("#chart-ce");
    const chartRate = await rect("#chart-rate");
    assert.ok(chartCe.height >= 94 && chartRate.height >= 56, `the charts have room (${chartCe.height}, ${chartRate.height})`);
    assert.ok(await visible("#start"), "Start shows before the case");
    assert.ok(!(await visible("#stop-case")), "Stop does not show before the case");
    assert.ok(!(await visible("#set-target")), "Set target does not show before the case");

    // No external resources: every request went to our own server.
    const external = [];
    page.on("request", (req) => { if (!req.url().startsWith(url) && !req.url().startsWith("data:")) external.push(req.url()); });

    // A propofol case at 60x with a 3 mcg/mL effect-site target.
    await page.selectOption("#drug", "propofol");
    await page.selectOption("#multiplier", "60");
    await page.fill("#target-value", "3");
    await page.click("#start");
    assert.equal(await page.inputValue("#target-value"), "3");
    assert.ok(!(await visible("#start")), "Start disappears once pressed");
    assert.ok(await visible("#stop-case"), "Stop takes its place");
    assert.ok(await visible("#set-target"), "Set target shows while the case runs");

    await page.waitForFunction(() => document.getElementById("phase").textContent.trim() === "maintenance", null, { timeout: 60000 });
    const rateText = (await page.textContent("#rate-value")).trim();
    const rate = Number(rateText);
    assert.ok(Number.isFinite(rate), `rate readout "${rateText}" is a number`);
    assert.ok(rate > 0, `maintenance rate ${rate} mL/hr is positive`);
    const count = Number((await page.textContent("#api-count")).replace(/\D/g, ""));
    assert.ok(count >= 3, `exchanges were recorded (${count})`);
    assert.ok((await page.$$(".xcard")).length >= 3, "cards were rendered in the API panel");

    // A hand bolus: the controller answers with the pump off, above target.
    const phaseBefore = (await page.textContent("#phase")).trim();
    await page.fill("#bolus-amount", "20");
    await page.click("#hand-bolus");
    await page.waitForFunction((before) => document.getElementById("phase").textContent.trim() !== before, phaseBefore, { timeout: 20000 });
    const phaseAfter = (await page.textContent("#phase")).trim();
    assert.notEqual(phaseAfter, phaseBefore);
    assert.ok((await page.$$("#record-body tr")).length >= 3, "the record table has rows");

    await mkdir(RESULTS, { recursive: true });
    await page.screenshot({ path: path.join(RESULTS, "smoke.png"), fullPage: true });

    // Stop ends the case: Start comes back for the next one.
    await page.click("#stop-case");
    await page.waitForFunction(() => document.getElementById("start").getBoundingClientRect().height > 0, null, { timeout: 20000 });
    assert.ok(!(await visible("#stop-case")), "Stop goes once the case has ended");
    assert.equal((await page.textContent("#phase")).trim(), "stopped");

    // Narrow viewport: no horizontal scroll at 375 px.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal overflow at 375 px (scrollWidth exceeds clientWidth by ${overflow})`);
    await page.screenshot({ path: path.join(RESULTS, "smoke-375.png"), fullPage: true });

    assert.deepEqual(pageErrors, [], "no page errors");
    assert.deepEqual(consoleErrors, [], "no console errors");
    assert.deepEqual(external, [], "no external requests");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
