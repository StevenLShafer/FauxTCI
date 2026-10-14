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
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
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

    // The wide layout on a tall viewport: the API conversation on the
    // right, about a third of the width; on the left the setup above the
    // pump screen, two boxes of equal height that fit the viewport, with
    // the target entry and the charts in the same box (no scrolling
    // between them).
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
    assert.ok(screen.bottom <= 1200, `the pump screen fits the 1200 px viewport (bottom at ${screen.bottom})`);
    const innerScroll = (sel) => page.evaluate((s) => { const n = document.querySelector(s); return n.scrollHeight - n.clientHeight; }, sel);
    assert.ok((await innerScroll("#setup-card")) <= 1, `the setup fits its box without scrolling (${await innerScroll("#setup-card")} px over)`);
    assert.ok((await innerScroll("#pump-screen")) <= 1, `the pump screen fits its box without scrolling (${await innerScroll("#pump-screen")} px over)`);
    assert.ok(await page.$("#pump-screen #target-value"), "the target entry is in the pump screen");
    assert.ok(await page.$("#pump-screen #chart-ce"), "the concentration chart is in the pump screen");
    assert.ok(await page.$("#pump-screen #start"), "Start is in the pump screen");
    const chartCe = await rect("#chart-ce");
    const chartRate = await rect("#chart-rate");
    assert.ok(chartCe.height >= 120 && chartRate.height >= 80, `the charts have room (${chartCe.height}, ${chartRate.height})`);
    // The box's inner overflow, sampled a few times (the readouts change).
    const maxInnerScroll = async (sel) => {
      let worst = 0;
      for (let i = 0; i < 5; i++) {
        worst = Math.max(worst, await innerScroll(sel));
        await page.waitForTimeout(150);
      }
      return worst;
    };
    assert.ok(await visible("#start"), "Start shows before the case");
    assert.ok(!(await visible("#stop-case")), "Stop does not show before the case");
    assert.ok(!(await visible("#set-target")), "Set target does not show before the case");

    // No external resources: every request went to our own server.
    const external = [];
    page.on("request", (req) => { if (!req.url().startsWith(url) && !req.url().startsWith("data:")) external.push(req.url()); });

    // A Start that fails validation leaves Start in place and shows why,
    // in the setup's error line, scrolled into view.
    await page.fill("#min-rate", "2000");
    await page.click("#start");
    assert.ok(((await page.textContent("#setup-error")) || "").length > 0, "an invalid setup is reported");
    assert.ok(await visible("#start"), "Start stays after a failed Start");
    assert.ok(!(await visible("#stop-case")), "Stop does not show after a failed Start");
    const errorInView = await page.evaluate(() => {
      const box = document.getElementById("setup-card").getBoundingClientRect();
      const r = document.getElementById("setup-error").getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    });
    assert.ok(errorInView, "the setup error is within the visible part of its box");
    await page.fill("#min-rate", "0.1");

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
    assert.ok((await maxInnerScroll("#pump-screen")) <= 1, "the pump screen still fits its box while the case runs");
    const chartCeRunning = await rect("#chart-ce");
    const chartRateRunning = await rect("#chart-rate");
    assert.ok(chartCeRunning.height >= 120 && chartRateRunning.height >= 80, `the charts keep their room while running (${chartCeRunning.height}, ${chartRateRunning.height})`);
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
    assert.ok((await maxInnerScroll("#pump-screen")) <= 1, "the pump screen fits its box after Stop");

    // A second case can be started, and stopped, after the first.
    await page.click("#start");
    await page.waitForFunction(() => document.getElementById("stop-case").getBoundingClientRect().height > 0, null, { timeout: 10000 });
    assert.ok(!(await visible("#start")), "Start disappears again for the second case");
    await page.click("#stop-case");
    await page.waitForFunction(() => document.getElementById("start").getBoundingClientRect().height > 0, null, { timeout: 20000 });

    // A 1000 px viewport (a desktop monitor with the browser's own bars):
    // the stage still fits, the pump screen keeps what it holds and the
    // setup takes the rest without scrolling inside its box.
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(300);
    const setup1000 = await rect("#setup-card");
    const screen1000 = await rect("#pump-screen");
    assert.ok(screen1000.bottom <= 1000, `the stage fits a 1000 px viewport (pump screen bottom ${screen1000.bottom})`);
    assert.ok(screen1000.height >= setup1000.height - 2, "the pump screen is at least as tall as the setup at 1000 px");
    assert.ok((await innerScroll("#setup-card")) <= 1, `the setup fits its box at 1400x1000 (${await innerScroll("#setup-card")} px over)`);
    assert.ok((await innerScroll("#pump-screen")) <= 1, "the pump screen fits its box at 1400x1000");

    // A laptop viewport (shorter than 950 px): the setup takes its natural
    // height, the pump screen is a viewport tall beneath it, Start is on
    // screen before a case, and Start brings the whole pump screen, charts
    // included, into view.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 0));
    const startRect = await rect("#start");
    assert.ok(startRect.top >= 0 && startRect.bottom <= 768, `Start is on screen at 1366x768 before a case (top ${startRect.top})`);
    assert.ok((await innerScroll("#setup-card")) <= 1, "the setup does not scroll inside its box at 1366x768");
    await page.click("#start");
    await page.waitForFunction(() => document.getElementById("phase").textContent.trim() === "maintenance", null, { timeout: 60000 });
    const targetRect = await rect("#target-value");
    const rateRect = await rect("#chart-rate");
    assert.ok(targetRect.top >= 0 && rateRect.bottom <= 768, `the target and both charts are on screen at 1366x768 while running (target top ${targetRect.top}, rate chart bottom ${rateRect.bottom})`);
    assert.ok((await maxInnerScroll("#pump-screen")) <= 1, "the pump screen fits its box at 1366x768");
    await page.click("#stop-case");
    await page.waitForFunction(() => document.getElementById("start").getBoundingClientRect().height > 0, null, { timeout: 20000 });

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

test("the page's alarms and the window.FauxTCI.driver hook in Chromium: the syringe runs out, a real-pump driver's occlusion stops the case", { skip: playwright ? false : "playwright is not installed (npm install -g playwright; npx playwright install chromium)", timeout: 110000 }, async () => {
  const { server, url } = await serve(ROOT);
  let browser = null;
  try {
    browser = await playwright.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(url + "index.html", { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("concentration").options.length > 0);
    const text = async (sel) => ((await page.textContent(sel)) || "").trim();
    const lastRecordRow = () => page.$$eval("#record-body tr", (rows) => {
      const r = rows[rows.length - 1];
      return r ? Array.from(r.querySelectorAll("td")).map((td) => td.textContent.trim()) : null;
    });

    // A 5 mL syringe at 60x: the pump empties during the loading infusion,
    // stops and alarms; the alarm line says what to do; Resume brings the
    // alarm back (the pump will not run without a syringe); Change syringe
    // clears it and the case runs on.
    await page.selectOption("#drug", "propofol");
    await page.selectOption("#multiplier", "60");
    await page.fill("#syringe-volume", "5");
    await page.fill("#target-value", "3");
    await page.click("#start");
    await page.waitForFunction(() => /syringe empty/.test(document.getElementById("alarm").textContent), null, { timeout: 30000 });
    assert.match(await text("#alarm"), /Change the syringe to continue\./, "the alarm line names the way out");
    assert.equal(await text("#phase"), "ALARM");
    assert.equal(Number(await text("#rate-value")), 0);
    assert.match(await text("#mass-rate"), /pump stopped/, "the face shows the pump's own state");
    assert.match(await text("#syringe-remaining"), /^0\.0 of 5 mL/);
    const stopRow = await lastRecordRow();
    assert.ok(stopRow && stopRow[1] === "rate change" && stopRow[2] === "0" && stopRow[4] === "pump", `the stop is in the record from the pump: ${JSON.stringify(stopRow)}`);
    await page.click("#pause-resume"); // Resume: the pump still has no syringe
    await page.waitForFunction(() => /\(still\)/.test(document.getElementById("alarm").textContent), null, { timeout: 10000 });
    assert.match(await text("#alarm"), /Change the syringe to continue\./);
    await page.fill("#syringe-told", "10");
    await page.fill("#syringe-true", "10");
    await page.click("#change-syringe");
    await page.waitForFunction(() => document.getElementById("alarm").textContent.trim() === "" && Number(document.getElementById("rate-value").textContent) > 0, null, { timeout: 30000 });
    assert.notEqual(await text("#phase"), "ALARM");
    await page.click("#stop-case");
    await page.waitForFunction(() => document.getElementById("start").getBoundingClientRect().height > 0, null, { timeout: 20000 });

    // A driver handed to the page: a pump whose line occludes 20 s into the
    // case, which the controller cannot foresee.  The hook is a function of
    // the settings, so it can size the syringe as the page did.
    await page.evaluate(async () => {
      const { SimulatedPump } = await import("./js/driver.js");
      class OccludingPump extends SimulatedPump {
        constructor(o) { super(o); this.occludeAt = null; this.loads = 0; }
        loadSyringe(time, syringe) {
          this.loads += 1;
          if (this.occludeAt === null) {
            this.occludeAt = time + 120;
            this.notices.push({ kind: "lowBattery", message: "battery low", at: time });
          }
          return super.loadSyringe(time, syringe);
        }
        _advance(to) {
          if (this.occludeAt !== null && this.state === "running" && to >= this.occludeAt) {
            super._advance(this.occludeAt);
            this.rate = 0;
            this.state = "stopped";
            this.alarms.push({ kind: "occlusion", message: "line occluded: the pump stopped", at: this.occludeAt });
            this.occludeAt = null;
          }
          super._advance(to);
        }
      }
      window.FauxTCI = {
        driver: (settings) => {
          window.FauxTCI.built = { syringeVolume: settings.syringeVolume, drug: settings.drug };
          window.FauxTCI.instance = new OccludingPump({ syringeVolume: settings.syringeVolume, concentration: 10, massUnits: "mg" });
          return window.FauxTCI.instance;
        },
      };
    });
    await page.fill("#syringe-volume", "50");
    await page.fill("#target-value", "3");
    await page.click("#start");
    // The pump's notice shows on the alarm line, as a notice, until the alarm takes it.
    await page.waitForFunction(() => /battery low/.test(document.getElementById("alarm").textContent), null, { timeout: 10000 });
    assert.equal(await text("#alarm"), "Pump: battery low");
    assert.ok(await page.evaluate(() => document.getElementById("alarm").classList.contains("is-notice")), "a notice is not styled as an alarm");
    await page.waitForFunction(() => /occluded/.test(document.getElementById("alarm").textContent), null, { timeout: 30000 });
    const built = await page.evaluate(() => window.FauxTCI.built);
    assert.deepEqual(built, { syringeVolume: 50, drug: "propofol" }, "the hook was called with the case settings");
    assert.equal(await page.evaluate(() => window.FauxTCI.instance.loads), 1, "the driver was told the initial syringe");
    assert.match(await text("#alarm"), /Clear the condition on the pump, then set a target or press Resume\./);
    assert.ok(!(await page.evaluate(() => document.getElementById("alarm").classList.contains("is-notice"))));
    assert.equal(await text("#phase"), "ALARM");
    assert.equal(Number(await text("#rate-value")), 0);
    const occlusionRow = await lastRecordRow();
    assert.ok(occlusionRow && occlusionRow[1] === "rate change" && occlusionRow[2] === "0" && occlusionRow[4] === "pump", `the pump's stop is in the record: ${JSON.stringify(occlusionRow)}`);
    const sim = await page.evaluate(() => window.FauxTCI.instance.volumeInfused);
    assert.ok(sim > 0 && sim < 20, `the driver's own totaliser ran the case (${sim} mL)`);
    await mkdir(RESULTS, { recursive: true });
    await page.screenshot({ path: path.join(RESULTS, "smoke-driver.png"), fullPage: true });
    await page.click("#stop-case");
    await page.waitForFunction(() => document.getElementById("start").getBoundingClientRect().height > 0, null, { timeout: 20000 });
    assert.equal(await text("#phase"), "ALARM", "the pump's condition stands after Stop");
    assert.equal(await text("#alarm"), "ALARM: line occluded: the pump stopped.", "once the case has ended the hint, whose controls are disabled, is dropped");

    assert.deepEqual(pageErrors, [], "no page errors");
    assert.deepEqual(consoleErrors, [], "no console errors");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
