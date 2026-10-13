// Behavioural tests for js/pump.js and js/transport.js: the section 7 safety
// contract of docs/tci-api.md as the simulated pump applies it (a dropped
// response, a pause, a lowered target, a wrong syringe, a background gap, a
// late or crossed response), the compaction of the record on a three-hour
// run, the exchange record and the stanpumpR dose-table export.  Every pump
// runs on a fake clock through the in-page controller.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FauxPump, compactHistory, summarizeResponse, summarizeError, PHASE_WORDS } from "../js/pump.js";
import { makeTransport, LOCAL_TRANSPORT_LABEL } from "../js/transport.js";
import { tciNextRate, parseRfc3339, formatRfc3339 } from "../js/tci.js";
import { resolveModel, advance, bolus, emptyState } from "../js/pk.js";

const START = Date.parse("2026-10-11T14:00:00.000Z");

function fakeClock() {
  return { ms: START, now() { return this.ms; }, set(seconds) { this.ms = START + seconds * 1000; } };
}

function makePump(clock, overrides = {}) {
  return new FauxPump({
    drug: "propofol",
    patient: { weight: 70, height: 170, age: 50, sex: "male" },
    syringe: { concentration: 10, units: "mg/mL" },
    limits: { maxRate: 1200, minRate: 0.1, rateResolution: 0.1 },
    declaredLatency: 1.5,
    actualLatency: 1.5,
    interval: 10,
    clock,
    transport: makeTransport({ mode: "local" }),
    requestIdPrefix: "t",
    ...overrides,
  });
}

// Tick the pump every `step` seconds of case time up to `until`, letting each
// transport answer arrive before the clock moves on.
async function runTo(pump, clock, until, step = 0.5) {
  let s = (clock.ms - START) / 1000;
  while (s < until - 1e-9) {
    s = Math.min(until, s + step);
    clock.set(s);
    pump.tick();
    await pump.idle();
  }
}

// A propofol pump started at t = 0 with a 3 mcg/mL target.
async function startedPump(clock, overrides = {}, target = 3) {
  const pump = makePump(clock, overrides);
  clock.set(0);
  pump.start();
  pump.setTarget(target, "effect");
  await pump.idle();
  return pump;
}

const seconds = (snapshotMs) => (snapshotMs - START) / 1000;

// ---------------------------------------------------------------------------
// The loop and the record

test("start() records the initial syringe first and asks at once when a target is set", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  const snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.deepEqual(snap.history[0], { time: "2026-10-11T14:00:00.000Z", infusate: { concentration: 10, units: "mg/mL" } });
  assert.equal(snap.exchanges.length, 1);
  const x = snap.exchanges[0];
  assert.equal(x.id, "t-000001");
  assert.equal(x.path, "POST /tci/v1/drugs/propofol/rate");
  assert.equal(x.status, 200);
  assert.equal(x.outcome, "pending", "the response has arrived but takes effect only after the actual latency");
  assert.equal(x.request.pump.state, "running");
  assert.equal(x.request.pump.currentRate, 0);
  assert.deepEqual(x.request.pump.volumeInfused, { value: 0, units: "mg" });
  assert.deepEqual(x.request.pump.syringeVolumeRemaining, { value: 50, units: "mL" });
  assert.equal(x.request.target.units, "mcg/mL");
  assert.equal(snap.rate, 0, "nothing runs before the pump acknowledges");
  await runTo(pump, clock, 1.5);
  const after = pump.snapshot();
  assert.equal(after.rate, 1200);
  assert.equal(after.exchanges[0].outcome, "applied");
  assert.equal(seconds(after.exchanges[0].caseTimeApplied), 1.5);
  assert.equal(after.history.length, 2);
  assert.deepEqual(after.history[1], { time: "2026-10-11T14:00:01.500Z", rate: 1200, units: "mL/hr", source: "tci" });
  assert.equal(after.phase, PHASE_WORDS.loading);
  assert.equal(after.segment.holdUntil, (START / 1000) + 11.5);
  assert.equal(seconds(after.nextRequestAt), 10);
});

test("a dropped response during loading runs the fallback and never exceeds the target by more than 1%", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 9.5);
  pump.dropNextResponse();
  await runTo(pump, clock, 300);
  const snap = pump.snapshot();
  const [first, dropped] = snap.exchanges;
  assert.equal(dropped.outcome, "dropped", dropped.summary);
  assert.equal(dropped.status, 200, "the answer existed; the pump never saw it");
  assert.match(dropped.summary, /dropped by the teaching control/);
  // Rule 4: at holdUntil the pump switched to the first response's fallback.
  const fallbackEvent = snap.record.find((e) => e.source === "fallback");
  assert.ok(fallbackEvent, "a fallback rate change was recorded");
  assert.equal(fallbackEvent.time, "2026-10-11T14:00:11.500Z");
  assert.equal(fallbackEvent.rate, first.response.fallback.rate);
  // The request at 20 s answered in time, so the fallback never expired.
  assert.equal(snap.alarms.length, 0);
  assert.equal(snap.exchanges[2].outcome, "applied");
  assert.equal(seconds(snap.exchanges[2].caseTimeApplied), 21.5);
  assert.ok(snap.maxTrueCe <= 3 * 1.01, `peak true Ce ${snap.maxTrueCe} is within 1% of the target`);
  assert.ok(Math.abs(snap.truth.ce - 3) <= 0.03, `Ce ${snap.truth.ce} is at the target after 5 min`);
  assert.equal(snap.state, "running");
});

test("a paused pump sends state paused and rate 0, the plan projects at zero, and resume restarts it", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  assert.ok(pump.snapshot().rate > 0, "in maintenance");
  pump.pause();
  const paused = pump.snapshot();
  const sentWhenPaused = paused.exchanges.length;
  assert.equal(paused.state, "paused");
  assert.equal(paused.rate, 0);
  assert.equal(paused.phase, "paused");
  const x = paused.exchanges[paused.exchanges.length - 1];
  assert.equal(seconds(x.caseTimeSent), 155, "a pause asks at once");
  assert.equal(x.request.pump.state, "paused");
  assert.equal(x.request.pump.currentRate, 0);
  const lastEvent = x.request.history[x.request.history.length - 1];
  assert.deepEqual(lastEvent, { time: "2026-10-11T14:02:35.000Z", rate: 0, units: "mL/hr", source: "manual" });
  await pump.idle();
  const r = x.response;
  assert.deepEqual(r.warnings.map((w) => w.code), ["PUMP_NOT_RUNNING"]);
  // The latency projection ran at rate 0: state.effectiveAt is state.now decayed with the pump off.
  const model = resolveModel({ drug: "propofol", weight: 70, height: 170, age: 50, sex: "male" });
  const decayed = advance({ p: r.state.now.p, e: r.state.now.e }, 1.5 / 60, 0, model);
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(decayed.p) - r.state.effectiveAt.cp) < 1e-9);
  assert.ok(Math.abs(sum(decayed.e) - r.state.effectiveAt.ce) < 1e-9);
  assert.ok(r.rate.value > 0, "the server still plans a rate; the pump decides");
  await runTo(pump, clock, 170);
  const still = pump.snapshot();
  assert.equal(still.rate, 0, "paused: the plan is not run");
  assert.equal(still.segment, null);
  assert.ok(still.exchanges.length > sentWhenPaused, "requests continue while paused");
  pump.resume();
  const resumed = pump.snapshot();
  assert.equal(resumed.state, "running");
  assert.equal(resumed.exchanges[resumed.exchanges.length - 1].request.pump.state, "running");
  await runTo(pump, clock, 172);
  assert.ok(pump.snapshot().rate > 0, "the response after resume restarts the pump");
});

test("a target lowered below prediction.peakCe stops the pump at once; the controller then holds the new target", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  const before = pump.snapshot();
  assert.ok(before.rate > 0);
  assert.ok(before.prediction.peakCe > 2);
  pump.setTarget(2);
  const now = pump.snapshot();
  assert.equal(now.rate, 0, "stopped without waiting for the server (rule 6)");
  assert.equal(now.state, "running");
  assert.equal(now.phaseCode, "aboveTarget");
  assert.deepEqual(now.record[now.record.length - 1], { time: "2026-10-11T14:02:35.000Z", rate: 0, units: "mL/hr", source: "manual" });
  const x = now.exchanges[now.exchanges.length - 1];
  assert.equal(seconds(x.caseTimeSent), 155);
  assert.equal(x.request.target.value, 2);
  assert.equal(x.request.pump.currentRate, 0);
  await pump.idle();
  assert.equal(x.response.controller.phase, "aboveTarget");
  assert.equal(x.response.rate.value, 0);
  await runTo(pump, clock, 157);
  assert.equal(pump.snapshot().rate, 0);
  await runTo(pump, clock, 900);
  const later = pump.snapshot();
  assert.ok(later.rate > 0, "maintenance at the new target has resumed");
  assert.ok(Math.abs(later.truth.ce - 2) <= 0.06, `Ce ${later.truth.ce} is near 2 after the decrement`);
  assert.ok(later.record.filter((e) => e.rate !== undefined).length > 0);
});

test("with stopOnLoweredTarget off the pump waits for the server's command", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock, { stopOnLoweredTarget: false });
  await runTo(pump, clock, 155);
  const rate = pump.snapshot().rate;
  pump.setTarget(2);
  assert.equal(pump.snapshot().rate, rate, "still running the old rate");
  await runTo(pump, clock, 156.5);
  assert.equal(pump.snapshot().rate, 0, "stopped when the response took effect");
});

test("changeSyringe(10, 20) makes the true Ce diverge from the prediction and DELIVERY_MISMATCH appears", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  const before = pump.snapshot();
  assert.ok(Math.abs(before.truth.ce - before.predicted.ce) < 1e-9, "truth and belief agree while the syringe is as told");
  pump.changeSyringe(10, 20);
  const changed = pump.snapshot();
  const x = changed.exchanges[changed.exchanges.length - 1];
  assert.equal(seconds(x.caseTimeSent), 155, "a syringe change asks at once");
  assert.deepEqual(x.request.infusate, { concentration: 10, units: "mg/mL" }, "the controller was told 10");
  const infusateEvents = x.request.history.filter((e) => e.infusate !== undefined);
  assert.equal(infusateEvents.length, 2);
  assert.deepEqual(infusateEvents[1], { time: "2026-10-11T14:02:35.000Z", infusate: { concentration: 10, units: "mg/mL" }, source: "manual" });
  assert.equal(changed.syringeRemaining, 50, "a new syringe is full");
  await runTo(pump, clock, 300);
  const after = pump.snapshot();
  assert.ok(after.truth.ce > after.predicted.ce * 1.15,
    `true Ce ${after.truth.ce} has run away from the predicted ${after.predicted.ce}`);
  assert.ok(Math.abs(after.predicted.ce - 3) < 0.05, "the controller believes it is holding the target");
  const flagged = after.exchanges.filter((e) => e.response && e.response.warnings &&
    e.response.warnings.some((w) => w.code === "DELIVERY_MISMATCH"));
  assert.ok(flagged.length > 0, "the pump's drug totaliser disagrees with the record: DELIVERY_MISMATCH");
  const firstFlag = flagged[0];
  assert.ok(seconds(firstFlag.caseTimeSent) > 155);
  assert.ok(firstFlag.response.delivered.reported > firstFlag.response.delivered.fromHistory * 1.02);
  assert.equal(firstFlag.request.pump.volumeInfused.units, "mg");
  // Before the change no response carried it.
  for (const e of after.exchanges) {
    if (seconds(e.caseTimeSent) < 155) assert.ok(!e.response.warnings.some((w) => w.code === "DELIVERY_MISMATCH"));
  }
});

test("catchUp() after a long gap leaves the pump in alarm at rate 0 with the truth decayed; the next setTarget() restarts it", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  const before = pump.snapshot();
  const sentBefore = before.exchanges.length;
  const segment = before.segment;
  assert.ok(before.rate > 0);
  clock.set(155 + 20 * 60);
  pump.catchUp(20 * 60 * 1000);
  const snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.phase, "ALARM");
  assert.equal(snap.rate, 0);
  assert.equal(snap.alarms.length, 1);
  assert.match(snap.alarms[0].message, /fallback/);
  assert.equal(snap.exchanges.length, sentBefore, "no request was sent while the controller slept");
  assert.equal(snap.nextRequestAt, null);
  // Rule 4 in the record: the fallback at holdUntil, the stop at holdUntil + maxSeconds.
  const events = snap.record.filter((e) => e.rate !== undefined);
  const fallback = events[events.length - 2];
  const stop = events[events.length - 1];
  assert.equal(fallback.source, "fallback");
  assert.equal(parseRfc3339(fallback.time), segment.holdUntil);
  assert.equal(fallback.rate, Number(segment.fallbackRate.toPrecision(15)), "recorded as the wire carries it");
  assert.equal(stop.source, "pump");
  assert.equal(stop.rate, 0);
  assert.equal(parseRfc3339(stop.time), segment.fallbackUntil);
  assert.ok(snap.truth.ce < 0.5 * 3, `the truth decayed for twenty minutes: Ce ${snap.truth.ce}`);
  assert.equal(seconds(snap.time), 155 + 20 * 60, "the physics stands at the clock");
  // The next target entry restarts it.
  pump.setTarget(3);
  const restarted = pump.snapshot();
  assert.equal(restarted.state, "running");
  assert.equal(restarted.exchanges.length, sentBefore + 1);
  const x = restarted.exchanges[restarted.exchanges.length - 1];
  assert.equal(x.request.pump.state, "running");
  assert.equal(x.request.pump.currentRate, 0);
  await runTo(pump, clock, 155 + 20 * 60 + 2);
  const running = pump.snapshot();
  assert.ok(running.rate > 0, "the response after the alarm restarts the infusion");
  assert.equal(running.exchanges[running.exchanges.length - 1].outcome, "applied");
  assert.equal(running.phase, PHASE_WORDS.loading);
});

test("catchUp() over a short gap inside a hold is not an alarm: the controller just asks again", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 152);
  const sentBefore = pump.snapshot().exchanges.length;
  clock.set(157);
  pump.catchUp(5000);
  const snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.equal(snap.alarms.length, 0);
  assert.equal(snap.exchanges.length, sentBefore + 1, "one request, at once, when the controller woke");
  assert.equal(seconds(snap.exchanges[snap.exchanges.length - 1].caseTimeSent), 157);
  assert.deepEqual(snap.backgroundGaps.map((g) => [g.from - START / 1000, g.to - START / 1000]), [[152, 157]]);
});

// ---------------------------------------------------------------------------
// Rules 1, 2, 3 and 5 with a scripted transport

// A transport whose answers the test releases by hand, in "http" mode so the
// response takes effect when it arrives.
function scriptedTransport() {
  const pending = [];
  return {
    mode: "http",
    baseUrl: "scripted",
    label: "scripted",
    lastRoundTripMs: 0,
    pending,
    send(drug, body, { receivedAt }) {
      return new Promise((resolve) => pending.push({ drug, body, receivedAt, resolve }));
    },
    health() { return Promise.resolve({ status: 200, body: {} }); },
  };
}

// Let a scripted answer's promise callbacks run (one macrotask).  The pump's
// idle() cannot be used here: these tests leave other answers pending on purpose.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const answer = (p, mutate = null) => {
  let out;
  try {
    const response = tciNextRate(p.body, p.receivedAt, { pathDrug: p.drug });
    if (mutate) mutate(response);
    out = { status: 200, body: response, roundTripMs: 1 };
  } catch (e) {
    out = { status: e.status || 500, body: { apiVersion: "1.0", errors: [{ code: e.code, message: e.message, pointer: e.pointer }] } };
  }
  p.resolve(out);
};

test("rule 2: a response that arrives late but before holdUntil is applied the moment it arrives, at the true time", async () => {
  const clock = fakeClock();
  const transport = scriptedTransport();
  const pump = makePump(clock, { transport });
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  assert.equal(transport.pending.length, 1);
  // The network holds the answer past effectiveAt (1.5 s) but not past the
  // next request (10 s); the pump keeps running its old rate (0) meanwhile.
  clock.set(6);
  pump.tick();
  assert.equal(transport.pending.length, 1, "no new request before the cadence");
  answer(transport.pending.shift());
  await settle();
  pump.tick();
  const snap = pump.snapshot();
  assert.equal(snap.exchanges[0].outcome, "applied", snap.exchanges[0].summary);
  assert.equal(seconds(snap.exchanges[0].caseTimeReceived), 6);
  assert.equal(seconds(snap.exchanges[0].caseTimeApplied), 6, "applied on arrival, never later");
  assert.equal(snap.rate, 1200);
  assert.deepEqual(snap.record[snap.record.length - 1],
    { time: "2026-10-11T14:00:06.000Z", rate: 1200, units: "mL/hr", source: "tci" }, "the record holds the true change time");
  assert.equal(snap.segment.holdUntil - START / 1000, 16, "the hold is holdSeconds from the acknowledgement");
  assert.equal(seconds(snap.nextRequestAt), 10, "the cadence is unchanged");
});

test("rule 3: only the latest request's response applies; an outstanding one is superseded by a local event", async () => {
  const clock = fakeClock();
  const transport = scriptedTransport();
  const pump = makePump(clock, { transport });
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  clock.set(2);
  pump.handBolus(10); // a local event: a new request at once, the outstanding one is stale
  assert.equal(transport.pending.length, 2);
  const first = transport.pending.shift();
  const second = transport.pending.shift();
  assert.equal(first.body.history.length, 1);
  assert.equal(second.body.history.length, 2, "the new request carries the bolus");
  answer(first);
  await settle();
  pump.tick();
  let snap = pump.snapshot();
  assert.equal(snap.exchanges[0].outcome, "superseded");
  assert.equal(snap.exchanges[0].status, 200, "its answer is still recorded");
  assert.equal(snap.rate, 0, "the superseded response did not run");
  clock.set(3.5);
  pump.tick();
  answer(second);
  await settle();
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.exchanges[1].outcome, "applied", snap.exchanges[1].summary);
  assert.ok(snap.rate > 0);
  assert.equal(seconds(snap.exchanges[1].caseTimeApplied), 3.5, "took effect on arrival, after the pump's own latency");
});

test("rule 1: a crossed response (another requestId) is discarded as an error; error statuses and network failures are no response", async () => {
  const clock = fakeClock();
  const transport = scriptedTransport();
  const pump = makePump(clock, { transport });
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  answer(transport.pending.shift(), (r) => { r.requestId = "other-channel-000007"; });
  await settle();
  clock.set(1.5);
  pump.tick();
  let snap = pump.snapshot();
  assert.equal(snap.exchanges[0].outcome, "error");
  assert.match(snap.exchanges[0].summary, /requestId/);
  assert.equal(snap.rate, 0);
  // The cadence continues: the next request at sent + interval.
  clock.set(10);
  pump.tick();
  assert.equal(transport.pending.length, 1);
  transport.pending.shift().resolve({ status: 503, body: { apiVersion: "1.0", errors: [{ code: "INTERNAL", message: "down", pointer: null }] } });
  await settle();
  clock.set(11.5);
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.exchanges[1].outcome, "error");
  assert.equal(snap.exchanges[1].status, 503);
  assert.match(snap.exchanges[1].summary, /503 INTERNAL/);
  clock.set(20);
  pump.tick();
  transport.pending.shift().resolve({ status: 0, body: null, error: "network: ECONNREFUSED" });
  await settle();
  clock.set(21.5);
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.exchanges[2].outcome, "no-response");
  assert.match(snap.exchanges[2].summary, /No response/);
  assert.equal(snap.alarms.length, 0, "nothing was ever running, so there is nothing to fall back from");
  assert.equal(snap.state, "running");
});

test("rule 4: with no accepted command the pump runs the fallback, then stops and alarms; a response after that is discarded as late", async () => {
  const clock = fakeClock();
  const transport = scriptedTransport();
  const pump = makePump(clock, { transport });
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  clock.set(1.5);
  pump.tick();
  answer(transport.pending.shift());
  await settle();
  pump.tick();
  assert.equal(pump.snapshot().rate, 1200);
  const fallbackRate = pump.snapshot().segment.fallbackRate;
  // The request at 10 s is never answered; the one at 20 s is answered too late.
  clock.set(10);
  pump.tick();
  assert.equal(transport.pending.length, 1);
  clock.set(11.5);
  pump.tick();
  let snap = pump.snapshot();
  assert.equal(snap.rate, Number(fallbackRate.toPrecision(15)), "the fallback runs from holdUntil");
  assert.equal(snap.phaseCode, "fallback");
  clock.set(20);
  pump.tick();
  assert.equal(transport.pending.length, 2, "the controller keeps asking while the fallback runs");
  assert.equal(snap.exchanges[1].outcome, "superseded");
  clock.set(21.5);
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.phase, "ALARM");
  assert.equal(snap.rate, 0);
  assert.equal(snap.segment, null);
  assert.equal(snap.alarms.length, 1);
  assert.equal(snap.alarms[0].time, START / 1000 + 21.5);
  assert.match(snap.alarms[0].message, /fallback/);
  assert.deepEqual(snap.record.filter((e) => e.rate !== undefined).map((e) => [e.time.slice(11, 23), e.rate, e.source]), [
    ["14:00:01.500", 1200, "tci"], ["14:00:11.500", Number(fallbackRate.toPrecision(15)), "fallback"], ["14:00:21.500", 0, "pump"],
  ]);
  // In alarm the controller stops asking until the user acts.
  for (let s = 22; s <= 120; s += 1) { clock.set(s); pump.tick(); }
  snap = pump.snapshot();
  assert.equal(snap.exchanges.length, 3);
  assert.equal(snap.nextRequestAt, null);
  assert.ok(snap.maxTrueCe <= 3 * 1.01, `the fallback bounded the peak: ${snap.maxTrueCe}`);
  // Rule 2: the answer to the 20 s request arrives after its holdUntil (31.5 s): discarded.
  transport.pending.shift(); // the unanswered 10 s request
  answer(transport.pending.shift());
  await settle();
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.exchanges[2].outcome, "late-discarded", snap.exchanges[2].summary);
  assert.match(snap.exchanges[2].summary, /holdUntil/);
  assert.equal(snap.rate, 0);
  assert.equal(snap.exchanges.length, 3, "in alarm the controller does not ask again by itself");
  pump.resume();
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.equal(snap.exchanges.length, 4, "resume asks at once");
  assert.equal(snap.exchanges[3].request.pump.state, "running");
});

// ---------------------------------------------------------------------------
// Compaction

test("compaction keeps a three-hour record under 400 events and leaves the plan within the resolution", { timeout: 120000 }, async (t) => {
  const run = async (compaction) => {
    const clock = fakeClock();
    // A 500 mL reservoir: a 50 mL syringe of 1% propofol empties in about an
    // hour at maintenance rates, and the pump then alarms and stops asking.
    const pump = makePump(clock, { compaction, syringeVolume: 500 });
    clock.set(0);
    pump.start();
    pump.setTarget(3);
    await pump.idle();
    const rates = [];
    const ideals = [];
    const checkpoints = [];
    for (let s = 0; s <= 3 * 3600; s += 10) {
      if (s > 0) {
        clock.set(s);
        pump.tick();
        await pump.idle();
      }
      const x = pump.snapshot().exchanges[pump.snapshot().exchanges.length - 1];
      assert.equal(seconds(x.caseTimeSent), s, "a request every interval");
      assert.equal(x.status, 200, `${compaction ? "compacted" : "full"} at ${s} s: ${x.summary}`);
      rates.push(x.response.rate.value);
      ideals.push(x.response.rate.ideal);
      if (s % 3600 === 0 && s > 0) {
        checkpoints.push({ s, request: x.request, response: x.response, record: pump.snapshot().record.map((e) => ({ ...e })) });
      }
      clock.set(s + 1.5);
      pump.tick();
    }
    return { pump, rates, ideals, checkpoints, snap: pump.snapshot() };
  };
  const full = await run(false);
  const compact = await run(true);
  assert.equal(full.rates.length, 1081);
  assert.equal(compact.rates.length, 1081);
  // The maintenance rate settles after the first hour and the rounded command
  // then repeats for many intervals, so even the full record is a few hundred
  // events over three hours; compaction bounds its growth to one segment per
  // minute beyond the last half hour whatever the case length.
  t.diagnostic(`  events sent after three hours: full record ${full.snap.history.length}, compacted ${compact.snap.history.length}`);
  assert.ok(full.snap.history.length > compact.snap.history.length);
  assert.ok(compact.snap.history.length < 400, `the compacted record has ${compact.snap.history.length} events`);
  assert.ok(compact.snap.record.length >= compact.snap.history.length, "the full record is kept for audit");
  assert.ok(compact.snap.record.every((e) => e.delivered === undefined), "the audit record is never merged");
  const segments = compact.snap.history.filter((e) => e.delivered !== undefined);
  assert.ok(segments.length >= 140, `${segments.length} one-minute segments`);
  for (const s of segments) assert.equal(s.units, "mL");
  for (let j = 1; j < segments.length; j++) assert.ok(parseRfc3339(segments[j].from) >= parseRfc3339(segments[j - 1].to));
  const lastSegmentEnd = parseRfc3339(segments[segments.length - 1].to);
  assert.ok(lastSegmentEnd <= START / 1000 + 3 * 3600 - 1800 + 1e-9, "nothing within the last half hour is merged");
  assert.ok(compact.snap.history.filter((e) => e.rate !== undefined).length <= 181 + 1);
  // What the merge costs, measured within one run: the compacted body the
  // pump sent at each hour against the same request carrying the full record.
  // The merge keeps the delivered total exactly and moves mass within a
  // minute, so the reconstructed state differs by a little and the ideal
  // rate (a small deficit divided by a small unit response) by more; the
  // contract promises "far less than the pump's own resolution".
  let worstIdeal = 0;
  let worstIdealRelative = 0;
  let worstState = 0;
  for (const c of compact.checkpoints) {
    const exact = tciNextRate({ ...c.request, history: c.record }, START + c.s * 1000);
    const relDelivered = Math.abs(c.response.delivered.fromHistory - exact.delivered.fromHistory) / exact.delivered.fromHistory;
    assert.ok(relDelivered < 1e-9, `delivered total at ${c.s} s: ${relDelivered}`);
    const relCp = Math.abs(c.response.state.now.cp - exact.state.now.cp) / exact.state.now.cp;
    const relCe = Math.abs(c.response.state.now.ce - exact.state.now.ce) / exact.state.now.ce;
    const dIdeal = Math.abs(c.response.rate.ideal - exact.rate.ideal);
    worstIdeal = Math.max(worstIdeal, dIdeal);
    worstIdealRelative = Math.max(worstIdealRelative, dIdeal / exact.rate.ideal);
    worstState = Math.max(worstState, relCp, relCe);
    t.diagnostic(`  at ${c.s / 3600} h: ${c.request.history.length} events merged for ${c.record.length}; state.now Cp ${relCp.toExponential(2)}, Ce ${relCe.toExponential(2)} relative; ideal rate ${dIdeal.toExponential(2)} mL/hr of ${exact.rate.ideal.toFixed(3)} (${(dIdeal / exact.rate.ideal).toExponential(2)} relative); commanded ${c.response.rate.value} vs ${exact.rate.value}`);
    assert.ok(Math.abs(c.response.rate.value - exact.rate.value) <= 0.1 + 1e-9, "the command differs by at most one resolution step");
  }
  assert.ok(worstIdealRelative <= 1e-6, `the ideal rate moved by ${worstIdealRelative} relative (${worstIdeal} mL/hr)`);
  assert.ok(worstState < 1e-7, `the reconstructed state moved by ${worstState} relative`);
  // Between the two runs: with the plan unchanged to 1e-6, no rounded command
  // flipped and the two trajectories are the same.
  let flips = 0;
  for (let i = 0; i < full.rates.length; i++) if (compact.rates[i] !== full.rates[i]) flips += 1;
  t.diagnostic(`  steps where the two runs' rounded commands differed: ${flips} of ${full.rates.length}`);
  assert.equal(flips, 0);
  const relCe = Math.abs(compact.snap.truth.ce - full.snap.truth.ce) / full.snap.truth.ce;
  t.diagnostic(`  true Ce after three hours, compacted run vs full run: ${relCe.toExponential(3)} relative`);
  assert.ok(relCe < 1e-9);
  // The exchange record keeps full bodies for the latest 200 only.
  const xs = compact.snap.exchanges;
  assert.equal(xs.length, 1081);
  assert.equal(xs[0].request, undefined);
  assert.equal(xs[0].response, undefined);
  assert.ok(xs[0].stripped);
  assert.equal(typeof xs[0].summary, "string");
  assert.equal(xs[0].status, 200);
  assert.ok(xs[xs.length - 200].request);
  assert.ok(!xs[xs.length - 201].request);
});

test("an empty syringe stops the pump with a syringeEmpty alarm; a new syringe lets it resume", async () => {
  const clock = fakeClock();
  // 5 mL of 1% propofol: 3.33 mL go in the first capped interval, 1.40 mL in
  // the second, and the last 0.27 mL run out a few seconds into maintenance.
  const pump = await startedPump(clock, { syringeVolume: 5 });
  await runTo(pump, clock, 240);
  const snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.apiState, "syringeEmpty");
  assert.equal(snap.rate, 0);
  assert.equal(snap.syringeRemaining, 0);
  assert.match(snap.alarms[0].message, /syringe empty/);
  const stop = snap.record.filter((e) => e.rate !== undefined).pop();
  assert.equal(stop.rate, 0);
  assert.equal(stop.source, "pump");
  const stopAt = parseRfc3339(stop.time) - START / 1000;
  assert.ok(stopAt > 101.5 && stopAt < 130, `stopped at ${stopAt} s, when the plunger hit the end`);
  assert.ok(Math.abs(snap.alarms[0].time - START / 1000 - stopAt) < 1e-3, "the record carries the stop to the millisecond");
  assert.ok(Math.abs(snap.volumeInfused - 5) < 1e-9, `volume infused ${snap.volumeInfused} mL`);
  const sent = snap.exchanges.length;
  await runTo(pump, clock, 270);
  assert.equal(pump.snapshot().exchanges.length, sent, "in alarm the controller waits for the user");
  pump.changeSyringe(10, 10, 50);
  const changed = pump.snapshot();
  assert.equal(changed.state, "running");
  assert.equal(changed.syringeRemaining, 50);
  assert.equal(changed.exchanges.length, sent + 1);
  assert.equal(changed.exchanges[sent].request.pump.state, "running");
  await runTo(pump, clock, 273);
  assert.ok(pump.snapshot().rate > 0);
});

test("compactHistory() merges a window into one-minute mL segments, splits at a syringe change and re-states the running rate", (t) => {
  const T0 = START / 1000;
  const at = (s) => formatRfc3339(T0 + s);
  const history = [
    { time: at(0), infusate: { concentration: 10, units: "mg/mL" } },
    { time: at(1.5), rate: 1200, units: "mL/hr", source: "tci" },
    { time: at(11.5), rate: 0, units: "mL/hr", source: "tci" },
    { time: at(45), bolus: 20, units: "mg", source: "manual" },
    { time: at(90), infusate: { concentration: 20, units: "mg/mL" }, source: "manual" },
    { time: at(101.5), rate: 60, units: "mL/hr", source: "tci" },
    { time: at(111.5), rate: 30, units: "mL/hr", source: "tci" },
    { time: at(130), rate: 31, units: "mL/hr", source: "tci" },
  ];
  const out = compactHistory(history, T0, T0 + 120);
  const segments = out.filter((e) => e.delivered !== undefined);
  // Minute 1 is split at the large steps 0 -> 1200 (1.5 s) and 1200 -> 0
  // (11.5 s): 1200 mL/hr for 10 s = 3.3333 mL, nothing before or after.
  // Minute 2 is split at the syringe change (90 s) and at the large steps
  // 0 -> 60 (101.5 s) and 60 -> 30 (111.5 s): 60 mL/hr for 10 s, then 30
  // mL/hr for 8.5 s up to the boundary.
  assert.deepEqual(segments.map((s) => [s.from, s.to, s.delivered]), [
    [at(1.5), at(11.5), 3.33333333333333],
    [at(101.5), at(111.5), Number((60 * 10 / 3600).toPrecision(15))],
    [at(111.5), at(120), Number((30 * 8.5 / 3600).toPrecision(15))],
  ]);
  // A maintenance staircase (steps of a fraction of a percent) is merged
  // whole, into a span inside each minute with the minute's own mass and
  // mean delivery time: a falling rate puts the centroid before the
  // midpoint, so the span ends a fraction of a second before the minute does.
  const staircase = [{ time: at(0), infusate: { concentration: 10, units: "mg/mL" } }];
  for (let k = 0; k < 18; k++) staircase.push({ time: at(k * 10), rate: 40 - 0.1 * k, units: "mL/hr", source: "tci" });
  const merged = compactHistory(staircase, T0, T0 + 120);
  const mergedSegments = merged.filter((e) => e.delivered !== undefined);
  assert.equal(mergedSegments.length, 2);
  const minuteRates = (k0) => [0, 1, 2, 3, 4, 5].map((k) => 40 - 0.1 * (k0 + k));
  const mass = (rates) => rates.reduce((acc, r) => acc + r * 10 / 3600, 0);
  const centroid = (rates, a) => rates.reduce((acc, r, k) => acc + r * 10 / 3600 * (a + 10 * k + 5), 0) / mass(rates);
  for (const [j, a] of [[0, 0], [1, 60]]) {
    const seg = mergedSegments[j];
    const rates = minuteRates(j * 6);
    assert.ok(Math.abs(seg.delivered - mass(rates)) < 1e-12, "the minute's mass");
    const from = parseRfc3339(seg.from) - T0;
    const to = parseRfc3339(seg.to) - T0;
    assert.ok(from >= a && to <= a + 60, "inside the minute");
    assert.ok(Math.abs((from + to) / 2 - centroid(rates, a)) <= 0.001, "the minute's mean delivery time, to the millisecond");
    assert.ok(a + 60 - to < 1 && to > a + 59, `a falling rate shortens the span by a fraction of a second (${a + 60 - to} s)`);
  }
  assert.deepEqual(merged.filter((e) => e.rate !== undefined).map((e) => [e.time, e.rate]),
    [[at(120), 38.8], [at(130), 38.7], [at(140), 38.6], [at(150), 38.5], [at(160), 38.4], [at(170), 38.3]]);
  assert.ok(out.some((e) => e.bolus === 20), "the bolus is kept");
  assert.equal(out.filter((e) => e.infusate !== undefined).length, 2, "the syringes are kept");
  const marker = out.find((e) => e.rate !== undefined && e.time === at(120));
  assert.deepEqual(marker, { time: at(120), rate: 30, units: "mL/hr", source: "compacted" });
  assert.ok(out.some((e) => e.rate === 31 && e.time === at(130)), "later rate changes are untouched");
  assert.ok(!out.some((e) => e.rate !== undefined && parseRfc3339(e.time) < T0 + 120 - 1e-9), "no rate change remains inside the window");
  // The server accepts it and reads the same delivered total as the uncompacted record.
  // Thirty minutes after the merged window (the earliest the pump would merge
  // it) the merge is invisible to the plan.
  const now = 120 + 1800;
  const body = (h) => ({
    drug: "propofol", now: at(now), patient: { weight: 70, height: 170, age: 50, sex: "male" },
    infusate: { concentration: 20, units: "mg/mL" },
    pump: { rateUnits: "mL/hr", maxRate: 1200, rateResolution: 0.1 }, target: { site: "effect", value: 3, units: "mcg/mL" },
    timing: { latency: 1.5, interval: 10 }, history: h,
  });
  const a = tciNextRate(body(history), START + now * 1000);
  const b = tciNextRate(body(out), START + now * 1000);
  assert.ok(Math.abs(a.delivered.fromHistory - b.delivered.fromHistory) < 1e-9);
  const relCp = Math.abs(a.state.now.cp - b.state.now.cp) / a.state.now.cp;
  const relCe = Math.abs(a.state.now.ce - b.state.now.ce) / a.state.now.ce;
  t.diagnostic(`  state 30 min after the merged window, merged vs exact: Cp ${relCp.toExponential(2)}, Ce ${relCe.toExponential(2)} relative`);
  assert.ok(relCp < 1e-3 && relCe < 1e-3, `state after the merge: ${relCp.toExponential(2)} / ${relCe.toExponential(2)} relative`);
  assert.equal(a.rate.value, b.rate.value, "the same command");
});

// ---------------------------------------------------------------------------
// Export

test("exportDoseTable() gives stanpumpR rows in the library's units for both drugs", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 30);
  pump.handBolus(20);
  await runTo(pump, clock, 45);
  const rows = pump.exportDoseTable();
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.equal(r.Drug, "propofol");
    assert.ok(["mg", "mg/hr"].includes(r.Units), r.Units);
    assert.equal(typeof r.Time, "number");
    assert.equal(typeof r.Dose, "number");
  }
  assert.deepEqual(rows[0], { Drug: "propofol", Time: 0.025, Dose: 12000, Units: "mg/hr" }, "1200 mL/hr of 10 mg/mL at 1.5 s");
  const bolusRow = rows.find((r) => r.Units === "mg");
  assert.deepEqual(bolusRow, { Drug: "propofol", Time: 0.5, Dose: 20, Units: "mg" });
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].Time >= rows[i - 1].Time);
  const csv = pump.exportDoseTableCsv();
  assert.ok(csv.startsWith("Drug,Time,Dose,Units\npropofol,0.025,12000,mg/hr\n"));

  const clock2 = fakeClock();
  const remi = makePump(clock2, { drug: "remifentanil", syringe: { concentration: 50, units: "mcg/mL" } });
  clock2.set(0);
  remi.start();
  remi.setTarget(4);
  await remi.idle();
  await runTo(remi, clock2, 12);
  remi.handBolus(50);
  await runTo(remi, clock2, 13);
  const rrows = remi.exportDoseTable();
  assert.ok(rrows.length >= 2);
  for (const r of rrows) assert.ok(["mcg", "mcg/min"].includes(r.Units), r.Units);
  const first = rrows[0];
  assert.equal(first.Units, "mcg/min");
  assert.equal(first.Time, 0.025);
  const firstRate = remi.snapshot().record.find((e) => e.rate !== undefined).rate;
  assert.ok(Math.abs(first.Dose - firstRate * 50 / 60) < 1e-9, "mL/hr x mcg/mL / 60 = mcg/min");
  assert.deepEqual(rrows.find((r) => r.Units === "mcg"), { Drug: "remifentanil", Time: 0.2, Dose: 50, Units: "mcg" });
});

// ---------------------------------------------------------------------------
// The transport and the summaries

test("the local transport answers asynchronously with the API's status and body", async () => {
  const transport = makeTransport({ mode: "local" });
  assert.equal(transport.mode, "local");
  assert.equal(transport.label, LOCAL_TRANSPORT_LABEL);
  const body = {
    requestId: "x-1", drug: "propofol", now: "2026-10-11T14:00:00.000Z",
    patient: { weight: 70, height: 170, age: 50, sex: "male" },
    infusate: { concentration: 10, units: "mg/mL" },
    pump: { rateUnits: "mL/hr", maxRate: 1200 },
    target: { site: "effect", value: 3, units: "mcg/mL" },
    timing: { latency: 1.5, interval: 10 }, history: [],
  };
  let settled = false;
  const p = transport.send("propofol", body, { receivedAt: START }).then((r) => { settled = true; return r; });
  assert.equal(settled, false, "not settled within the caller's turn");
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(r.body.requestId, "x-1");
  assert.equal(r.body.rate.value, 1200);
  assert.equal(r.body.server.package, "FauxTCI");
  assert.equal(r.body.server.receivedAt, "2026-10-11T14:00:00.000Z");
  const bad = await transport.send("propofol", { ...body, target: { site: "effect", value: 3, units: "ng/mL" } }, { receivedAt: START });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].code, "UNIT_MISMATCH");
  assert.equal(bad.body.requestId, "x-1");
  const wrongDrug = await transport.send("remifentanil", body, { receivedAt: START });
  assert.equal(wrongDrug.status, 400);
  assert.equal(wrongDrug.body.errors[0].code, "DRUG_MISMATCH");
  const health = await transport.health();
  assert.equal(health.body.status, "ok");
});

test("the http transport reports a refused connection as no response", async () => {
  const transport = makeTransport({ mode: "http", baseUrl: "http://127.0.0.1:9/" });
  assert.equal(transport.mode, "http");
  assert.equal(transport.baseUrl, "http://127.0.0.1:9");
  const r = await transport.send("propofol", { history: [] });
  assert.equal(r.status, 0);
  assert.equal(r.body, null);
  assert.match(r.error, /network/);
  assert.throws(() => makeTransport({ mode: "carrier-pigeon" }), /unknown mode/);
});

test("summaries read as the panel shows them", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  const x = pump.snapshot().exchanges[pump.snapshot().exchanges.length - 1];
  const line = summarizeResponse(x.response, x.request);
  assert.match(line, /^Run [0-9.]+ mL\/hr for 10 s \(ideal [0-9.]+; rounded down to 0\.1\), then fall back to [0-9.]+ mL\/hr\. Plan: plasma hold, maintenance\. Ce now [0-9.]+, at hold end [0-9.]+, peak [0-9.]+ at 14:0[0-9]:[0-9.]+\. Next request at 14:0[0-9]:[0-9]{2}\.$/);
  assert.equal(x.summary, line);
  const first = pump.snapshot().exchanges[0];
  assert.match(first.summary, /^Run 1200 mL\/hr for 10 s \(ideal 1702\.21; ceiling\), then fall back to 504\.1 mL\/hr\. Plan: effect-site, loading\./);
  assert.equal(summarizeError(422, { errors: [{ code: "UNIT_MISMATCH", message: "m", pointer: "/target/units" }] }),
    "422 UNIT_MISMATCH at /target/units: m");
  assert.equal(summarizeError(0, null, "network: down"), "No response (network: down).");
});

test("the constructor refuses what the API would refuse", () => {
  const clock = fakeClock();
  assert.throws(() => makePump(clock, { drug: "midazolam" }), /unknown drug/);
  assert.throws(() => makePump(clock, { declaredLatency: 10 }), /LATENCY_INVALID/);
  assert.throws(() => makePump(clock, { syringe: { concentration: 10, units: "mg/L" } }), /syringe.units/);
  assert.throws(() => makePump(clock, { interval: 0.5 }), /interval/);
  const pump = makePump(clock);
  assert.throws(() => pump.setTarget(-1), /target value/);
  assert.throws(() => pump.setTarget(3, "brain"), /site/);
  assert.throws(() => pump.handBolus(0), /positive/);
  assert.throws(() => pump.setActualLatency(-1), /actualLatency/);
});

// ---------------------------------------------------------------------------
// Rule 6 against a response in flight.  The in-page controller answers in a
// later macrotask, so a tick that sends a request which fell due since the
// last tick parks the physics at the request's applyAt until the answer is
// there; a click in that gap (most clicks at 60x) is a local event while a
// response is outstanding.  The event must be stamped at the physics time and
// the outstanding response superseded, or the record goes out of order and
// the stale plan, made for the OLD target, runs.

// A local transport whose answers are released only when told, in order: the
// macrotask gap between the tick that sends and the setTimeout(0) answer,
// held open on purpose.
function gatedLocalTransport() {
  const inner = makeTransport({ mode: "local" });
  const gates = [];
  return {
    mode: "local",
    baseUrl: null,
    label: "gated local",
    lastRoundTripMs: 0,
    gates,
    send(drug, body, opts) {
      return new Promise((resolve) => {
        const answer = inner.send(drug, body, opts);
        gates.push(() => answer.then(resolve));
      });
    },
    health() { return inner.health(); },
  };
}

const chronological = (record) => {
  const times = record.map((e) => parseRfc3339(e.time !== undefined ? e.time : e.from));
  return times.every((t, i) => i === 0 || t >= times[i - 1]);
};

test("rule 6 in the macrotask gap: a target lowered while the physics waits for the in-page answer supersedes it, and the record stays chronological", async () => {
  const clock = fakeClock();
  const transport = gatedLocalTransport();
  const pump = makePump(clock, { transport });
  const release = async () => {
    while (transport.gates.length) transport.gates.shift()();
    await pump.idle();
  };
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  await release();
  // To maintenance in steps of the cadence, each answer released at once.
  for (let s = 10; s <= 900; s += 10) {
    clock.set(s);
    pump.tick();
    await release();
  }
  let snap = pump.snapshot();
  assert.equal(snap.phaseCode, "maintenance");
  assert.ok(snap.rate > 0);
  const due = seconds(snap.nextRequestAt);
  // A tick 12 s after the request fell due (a 60x tick is 15 case seconds):
  // the request goes out at its due time and the physics parks at its
  // applyAt, waiting for the answer we hold back.
  clock.set(due + 12);
  pump.tick();
  snap = pump.snapshot();
  const stale = snap.exchanges[snap.exchanges.length - 1];
  assert.equal(stale.outcome, "pending");
  assert.equal(stale.status, null, "the answer has not arrived");
  assert.equal(stale.request.target.value, 3);
  assert.equal(seconds(snap.time), due + 1.5, "the physics waits at applyAt");
  assert.equal(seconds(snap.clockNow), due + 12);
  const rateBefore = snap.rate;
  // The operator lowers the target in the gap.
  pump.setTarget(2);
  snap = pump.snapshot();
  assert.equal(snap.rate, 0, "stopped at once: 2 is below the predicted peak");
  assert.equal(snap.phaseCode, "aboveTarget");
  assert.equal(stale.outcome, "superseded", stale.summary);
  assert.match(stale.summary, /local event/);
  const manual = snap.record[snap.record.length - 1];
  assert.deepEqual(manual, { time: formatRfc3339(START / 1000 + due + 1.5), rate: 0, units: "mL/hr", source: "manual" },
    "the stop is stamped at the physics time, which is the case clock the face shows");
  const fresh = snap.exchanges[snap.exchanges.length - 1];
  assert.notEqual(fresh.id, stale.id, "a superseding request went out at once");
  assert.equal(seconds(fresh.caseTimeSent), due + 1.5);
  assert.equal(fresh.request.target.value, 2);
  assert.equal(fresh.request.pump.currentRate, 0);
  assert.deepEqual(fresh.request.history[fresh.request.history.length - 1], manual, "the new request carries the stop");
  assert.equal(snap.inFlight.id, fresh.id);
  // Both answers arrive: the stale one (planned for target 3) must not run.
  await release();
  pump.tick();
  await release();
  snap = pump.snapshot();
  assert.equal(stale.outcome, "superseded");
  assert.equal(stale.status, 200, "its answer is recorded, not applied");
  assert.equal(fresh.outcome, "applied", fresh.summary);
  assert.equal(fresh.response.controller.phase, "aboveTarget");
  assert.equal(fresh.response.rate.value, 0);
  assert.equal(snap.rate, 0);
  assert.equal(snap.target.value, 2);
  assert.ok(chronological(snap.record), `the record is chronological: ${snap.record.slice(-3).map((e) => e.time).join(", ")}`);
  const manualAt = parseRfc3339(manual.time);
  const tciAfterStop = snap.record.filter((e) => e.source === "tci" && e.rate > 0 && parseRfc3339(e.time) >= manualAt);
  assert.deepEqual(tciAfterStop, [], "no tci rate computed for the old target ran after the stop");
  assert.ok(rateBefore > 0);
  // The loop carries on at the new target without a hiccup.
  for (let i = 1; i <= 6; i++) {
    clock.set(due + 12 + 10 * i);
    pump.tick();
    await release();
  }
  snap = pump.snapshot();
  assert.ok(chronological(snap.record));
  assert.equal(snap.alarms.length, 0);
  // The newest request went out at the cadence 0.5 s before this tick, so
  // its answer takes effect only at the next one; every earlier one applied.
  const [newest, ...earlier] = snap.exchanges.slice(-7).reverse();
  assert.equal(newest.outcome, "pending");
  for (const x of earlier) {
    assert.equal(x.outcome, "applied", `${x.id}: ${x.summary}`);
    assert.equal(x.request.target.value, 2);
  }
  assert.ok(snap.exchanges.every((x) => !x.response || !x.response.warnings ||
    x.response.warnings.every((w) => w.code !== "HISTORY_INVALID")));
});

test("rule 6 over HTTP with an actual latency under the one-second minimum: the outstanding response is superseded, not applied", async () => {
  const clock = fakeClock();
  const transport = scriptedTransport();
  const pump = makePump(clock, { transport, actualLatency: 0.5 });
  clock.set(0);
  pump.start();
  pump.setTarget(3);
  // To maintenance, answering each request as it is sent.
  let s = 0;
  while (s < 160 - 1e-9) {
    s = Math.min(160, s + 0.5);
    clock.set(s);
    pump.tick();
    while (transport.pending.length) answer(transport.pending.shift());
    await settle();
    pump.tick();
  }
  let snap = pump.snapshot();
  assert.equal(snap.phaseCode, "maintenance");
  assert.ok(snap.rate > 0);
  clock.set(170);
  pump.tick();
  assert.equal(transport.pending.length, 1, "the cadence request is out and unanswered");
  const stale = transport.pending.shift();
  assert.equal(stale.body.target.value, 3);
  clock.set(170.2);
  pump.setTarget(2);
  snap = pump.snapshot();
  assert.equal(snap.rate, 0, "stopped at once");
  const staleX = snap.exchanges.find((x) => x.id === stale.body.requestId);
  assert.equal(staleX.outcome, "superseded", staleX.summary);
  assert.equal(transport.pending.length, 0, "the superseding request waits for the one-second minimum");
  assert.equal(seconds(snap.nextRequestAt), 171);
  // The stale answer arrives; its applyAt (170.5) is before the new request (171).
  answer(stale);
  await settle();
  clock.set(170.5);
  pump.tick();
  snap = pump.snapshot();
  assert.equal(snap.rate, 0, "the stale plan did not run");
  assert.equal(staleX.outcome, "superseded");
  assert.equal(staleX.status, 200);
  clock.set(171);
  pump.tick();
  assert.equal(transport.pending.length, 1);
  const fresh = transport.pending.shift();
  assert.equal(fresh.body.target.value, 2);
  assert.equal(fresh.body.history[fresh.body.history.length - 1].time, "2026-10-11T14:02:50.200Z");
  answer(fresh);
  await settle();
  clock.set(171.5);
  pump.tick();
  snap = pump.snapshot();
  const freshX = snap.exchanges[snap.exchanges.length - 1];
  assert.equal(freshX.outcome, "applied", freshX.summary);
  assert.equal(freshX.response.controller.phase, "aboveTarget");
  assert.equal(snap.rate, 0);
  assert.ok(chronological(snap.record));
  assert.deepEqual(snap.record.filter((e) => e.source === "tci" && e.rate > 0 && e.time >= "2026-10-11T14:02:50.200Z"), []);
});

// ---------------------------------------------------------------------------
// Target 0 (section 7, rules 4 and 8): the planned stop, not an alarm.

test("target 0 is the planned stop: the off command's fallback ends without an alarm, and a new target restarts the pump", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 300);
  assert.equal(pump.snapshot().phaseCode, "maintenance");
  pump.setTarget(0);
  let snap = pump.snapshot();
  assert.equal(snap.rate, 0, "stopped at once");
  assert.equal(snap.phaseCode, "stopped");
  await runTo(pump, clock, 310);
  const sentByThen = pump.snapshot().exchanges.length;
  await runTo(pump, clock, 360);
  snap = pump.snapshot();
  const off = snap.exchanges[snap.exchanges.length - 1];
  assert.equal(off.outcome, "applied", off.summary);
  assert.equal(off.response.controller.plan, "off");
  assert.equal(off.response.rate.value, 0);
  assert.equal(off.response.fallback.rate, 0);
  assert.ok(parseRfc3339(off.response.timing.nextRequestAt) < parseRfc3339(off.response.timing.holdUntil) + off.response.fallback.maxSeconds,
    "the API's nextRequestAt for an off plan lies before the end of the fallback");
  assert.equal(snap.state, "running", "the stop that was asked for is not an alarm");
  assert.equal(snap.phaseCode, "stopped");
  assert.equal(snap.rate, 0);
  assert.deepEqual(snap.alarms, []);
  assert.equal(snap.segment, null);
  assert.equal(snap.nextRequestAt, null, "nothing to control until the user acts");
  assert.equal(snap.exchanges.length, sentByThen, "no further requests while stopped at target 0");
  // A new target restarts the pump without anything to clear.
  pump.setTarget(3);
  await runTo(pump, clock, 365);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0, "the response to the new target restarted the pump");
  assert.deepEqual(snap.alarms, []);
  assert.ok(!snap.notes.some((n) => /alarm cleared/.test(n.message)), "there was no alarm to clear");
});

test("stop() is target 0 and ends in the same planned stop", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 120);
  pump.stop();
  await runTo(pump, clock, 200);
  const snap = pump.snapshot();
  assert.equal(snap.target.value, 0);
  assert.equal(snap.state, "running");
  assert.equal(snap.phaseCode, "stopped");
  assert.deepEqual(snap.alarms, []);
});

// ---------------------------------------------------------------------------
// The export after a syringe change

test("exportDoseTable() carries a syringe change as a rate row, so the table re-simulates to the truth", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 155);
  assert.ok(pump.snapshot().rate > 0, "running when the syringe is changed");
  pump.changeSyringe(20); // told and true alike: the truth is what the record says
  await runTo(pump, clock, 300);
  const snap = pump.snapshot();
  const rows = pump.exportDoseTable();
  const changeMinutes = Number((155 / 60).toPrecision(12));
  const atChange = rows.filter((r) => r.Time === changeMinutes);
  assert.equal(atChange.length, 1, "one rate row at the syringe change");
  assert.equal(atChange[0].Units, "mg/hr");
  const running = snap.record.filter((e) => e.rate !== undefined && e.time < "2026-10-11T14:02:35.000Z").pop().rate;
  assert.equal(atChange[0].Dose, Number((running * 20).toPrecision(12)), "the running mL/hr at the new concentration");
  // Re-simulate the table as stanpumpR would read it: piecewise-constant
  // mg/hr infusions and mg boluses, through the same closed form.
  const model = resolveModel({ drug: "propofol", weight: 70, height: 170, age: 50, sex: "male" });
  let state = emptyState();
  let t = 0;
  let ratePerMin = 0;
  for (const r of [...rows].sort((a, b) => a.Time - b.Time)) {
    state = advance(state, r.Time - t, ratePerMin, model);
    t = r.Time;
    if (r.Units === "mg") state = bolus(state, r.Dose, model);
    else ratePerMin = r.Dose / 60;
  }
  state = advance(state, 300 / 60 - t, ratePerMin, model);
  const ceSim = state.e.reduce((a, b) => a + b, 0);
  const cpSim = state.p.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(ceSim - snap.truth.ce) < 1e-9, `Ce from the table ${ceSim} vs the truth ${snap.truth.ce}`);
  assert.ok(Math.abs(cpSim - snap.truth.cp) < 1e-9, `Cp from the table ${cpSim} vs the truth ${snap.truth.cp}`);
});

// ---------------------------------------------------------------------------
// The in-page wire carries numbers as R's would

const walkNumbers = (value, visit, path = "$") => {
  if (typeof value === "number") visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkNumbers(v, visit, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const k of Object.keys(value)) walkNumbers(value[k], visit, `${path}.${k}`);
};

test("the local transport delivers every number at 15 significant digits, as jsonlite writes the R wire", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock);
  await runTo(pump, clock, 60);
  const snap = pump.snapshot();
  const offenders = [];
  for (const x of snap.exchanges) {
    walkNumbers(x.response, (v, path) => {
      if (Number.isFinite(v) && Number(v.toPrecision(15)) !== v) offenders.push(`${x.id} ${path} = ${v}`);
    });
  }
  assert.deepEqual(offenders, []);
  // A request total that JavaScript cannot write shortly (0.1 + 0.2) reaches
  // the controller as 0.3, which is what R would have read from the JSON.
  const body = JSON.parse(JSON.stringify(snap.exchanges[0].request));
  body.pump.volumeInfused = { value: 0.1 + 0.2, units: "mg" };
  const result = await makeTransport({ mode: "local" }).send("propofol", body, { receivedAt: START });
  assert.equal(result.status, 200);
  assert.equal(result.body.delivered.reported, 0.3);
});
