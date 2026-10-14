// Tests for js/driver.js, the pump driver interface and the simulated pump,
// and for FauxPump's use of a driver: the record follows what the pump
// acknowledges, the truth follows what the pump delivers, an alarm the pump
// reports stops the controller (which commands the stop) at the alarm's own
// time, and a driver that breaks the calling convention is a driver fault,
// not a crash.
//
// Drafted by Claude Code, 2026-10-14, at the request of Steven L. Shafer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PumpDriver, SimulatedPump, makeReading } from "../js/driver.js";
import { FauxPump } from "../js/pump.js";
import { makeTransport } from "../js/transport.js";
import { parseRfc3339 } from "../js/tci.js";

const START = Date.parse("2026-10-11T14:00:00.000Z");
const T0 = START / 1000;

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
    requestIdPrefix: "d",
    ...overrides,
  });
}

async function runTo(pump, clock, until, step = 0.5) {
  let s = (clock.ms - START) / 1000;
  while (s < until - 1e-9) {
    s = Math.min(until, s + step);
    clock.set(s);
    pump.tick();
    await pump.idle();
  }
}

// As runTo, but without waiting for the transport: for a transport that
// never answers (idle() would wait for ever).  A macrotask between ticks
// lets an answer that is coming land.
async function tickTo(pump, clock, until, step = 0.5) {
  let s = (clock.ms - START) / 1000;
  while (s < until - 1e-9) {
    s = Math.min(until, s + step);
    clock.set(s);
    pump.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function startedPump(clock, overrides = {}, target = 3) {
  const pump = makePump(clock, overrides);
  clock.set(0);
  pump.start();
  pump.setTarget(target, "effect");
  await pump.idle();
  return pump;
}

const rateEvents = (snap) => snap.record.filter((e) => e.rate !== undefined)
  .map((e) => ({ at: parseRfc3339(e.time) - T0, rate: e.rate, source: e.source }));

const eventTimes = (snap) => snap.record.map((e) => parseRfc3339(e.time !== undefined ? e.time : e.from));

// A pump that stops with an alarm at a time its horizon() does not forecast
// (an occlusion: no pump can predict one).
class OccludingPump extends SimulatedPump {
  constructor(o) { super(o); this.occludeAt = o.occludeAt; this.kinds = o.kinds || ["occlusion"]; }
  _advance(to) {
    if (this.occludeAt !== null && this.state === "running" && to >= this.occludeAt) {
      super._advance(this.occludeAt);
      this.rate = 0;
      this.state = "stopped";
      for (const kind of this.kinds) {
        this.alarms.push({ kind, message: kind === "occlusion" ? "line occluded: the pump stopped" : `${kind}: the pump stopped`, at: this.occludeAt });
      }
      this.occludeAt = null;
    }
    super._advance(to);
  }
  clearOcclusion() { this.alarms = []; this.state = "running"; }
}

// A transport that answers the first request through the in-page controller
// and never answers another: the server has gone away.
function answersOnceThenHangs() {
  const local = makeTransport({ mode: "local" });
  let n = 0;
  return {
    mode: "http",
    baseUrl: "",
    label: "answers once, then hangs",
    lastRoundTripMs: null,
    send(drug, body, opts) { n += 1; return n === 1 ? local.send(drug, body, opts) : new Promise(() => {}); },
    health() { return Promise.resolve({ status: 0, body: null }); },
  };
}

// ---------------------------------------------------------------------------
// The interface and the simulated pump on their own

test("PumpDriver is an interface: its methods throw until a subclass provides them", () => {
  const d = new PumpDriver();
  assert.throws(() => d.infuse(0, 10), /not implemented/);
  assert.throws(() => d.loadSyringe(0, { volume: 50 }), /not implemented/);
  assert.equal(d.horizon(0), null, "horizon() may be left alone: null means the pump cannot predict");
  const r = makeReading({ rate: 5 });
  assert.equal(r.rate, 5);
  assert.deepEqual(Object.keys(r).sort(), ["acknowledgedAt", "alarms", "commanded", "massInfused", "massUnits", "notices", "rate", "state", "syringeRemaining", "time", "volumeInfused"]);
});

test("SimulatedPump: the totaliser integrates the commanded rate, and horizon() names the time the syringe runs out", () => {
  const p = new SimulatedPump({ syringeVolume: 50, concentration: 10, massUnits: "mg" });
  let r = p.infuse(1000, 600);
  assert.equal(r.rate, 600);
  assert.equal(r.acknowledgedAt, 1000);
  assert.equal(r.volumeInfused, 0);
  assert.equal(p.horizon(1000), 1000 + 50 * 3600 / 600, "50 mL at 600 mL/hr: empty in 300 s");
  r = p.infuse(1060, null);
  assert.ok(Math.abs(r.volumeInfused - 10) < 1e-12, `10 mL in a minute (${r.volumeInfused})`);
  assert.ok(Math.abs(r.massInfused - 100) < 1e-12, "100 mg of 10 mg/mL");
  assert.ok(Math.abs(r.syringeRemaining - 40) < 1e-12);
  assert.equal(r.state, "running");
  assert.deepEqual(r.alarms, []);
  assert.deepEqual(r.notices, []);
  r = p.infuse(1060, 0);
  assert.equal(r.rate, 0);
  assert.equal(p.horizon(1060), null, "nothing is due while the pump is at 0");
  r = p.infuse(2000, null);
  assert.ok(Math.abs(r.volumeInfused - 10) < 1e-12, "nothing delivered at 0");
  assert.throws(() => p.infuse(2000, -1), /mL\/hr/);
  assert.throws(() => p.infuse("now", 1), /seconds/);
});

test("SimulatedPump: the syringe empties mid-interval at exactly its volume, the pump stops and alarms at that time, and refuses to run until a syringe is loaded", () => {
  const p = new SimulatedPump({ syringeVolume: 50, concentration: 10 });
  p.infuse(0, 1200); // empty at 150 s
  const r = p.infuse(200, null);
  assert.equal(r.volumeInfused, 50, "delivered exactly the syringe");
  assert.equal(r.syringeRemaining, 0);
  assert.equal(r.rate, 0);
  assert.equal(r.state, "stopped");
  assert.equal(r.alarms.length, 1);
  assert.equal(r.alarms[0].kind, "syringeEmpty");
  assert.ok(Math.abs(r.alarms[0].at - 150) < 1e-9, `stopped at ${r.alarms[0].at} s`);
  assert.equal(p.horizon(200), null);
  const refused = p.infuse(210, 300);
  assert.equal(refused.rate, 0, "a stopped pump does not run");
  assert.equal(refused.alarms[0].kind, "syringeEmpty", "and still reports why");
  const loaded = p.loadSyringe(220, { volume: 20, concentration: 20, units: "mg" });
  assert.equal(loaded.state, "running");
  assert.deepEqual(loaded.alarms, []);
  assert.equal(loaded.syringeRemaining, 20);
  const running = p.infuse(220, 300);
  assert.equal(running.rate, 300);
  const later = p.infuse(220 + 60, null);
  assert.ok(Math.abs(later.volumeInfused - 55) < 1e-12, "5 mL more in a minute at 300 mL/hr");
  assert.ok(Math.abs(later.massInfused - 500 - 100) < 1e-9, "the new syringe's concentration counts");
});

test("SimulatedPump: emptiness is decided by time, so at epoch-scale clocks and inexact rates the syringe still runs out, stops and alarms", () => {
  // At ~1.79e9 s one ulp of the clock is 2.4e-7 s; deciding by residual
  // volume left nanolitres in a pump that never emptied.
  let alarmed = 0;
  const cases = [];
  for (const offset of [0, 0.37, 11.9, 1234.5678]) {
    for (const rate of [250.1, 499.9, 1199.9, 36.2, 61.7]) {
      const p = new SimulatedPump({ syringeVolume: 5, concentration: 10 });
      const t0 = T0 + offset;
      p.infuse(t0, rate);
      const emptyAt = t0 + 5 * 3600 / rate;
      for (let t = t0; t < emptyAt + 10; t += 0.25) p.infuse(t, null);
      const r = p.infuse(emptyAt + 10, null);
      cases.push({ offset, rate, state: r.state, left: r.syringeRemaining });
      if (r.state === "stopped" && r.alarms.length === 1 && r.alarms[0].kind === "syringeEmpty" &&
        r.syringeRemaining === 0 && Math.abs(r.volumeInfused - 5) < 1e-9 && Math.abs(r.alarms[0].at - emptyAt) < 1e-3) alarmed += 1;
    }
  }
  assert.equal(alarmed, cases.length, `every run emptied: ${JSON.stringify(cases.filter((c) => c.state !== "stopped"))}`);
});

test("SimulatedPump: an acknowledgement delay runs the old rate until the command takes effect, and horizon() names that time", () => {
  const p = new SimulatedPump({ syringeVolume: 50, concentration: 10, acknowledgeDelay: 2 });
  let r = p.infuse(0, 600);
  assert.equal(r.rate, 0, "not yet running");
  assert.deepEqual(r.commanded, { rate: 600, at: 2 });
  assert.equal(p.horizon(0), 2);
  r = p.infuse(1, null);
  assert.equal(r.rate, 0);
  assert.equal(r.volumeInfused, 0);
  r = p.infuse(2, null);
  assert.equal(r.rate, 600);
  assert.equal(r.acknowledgedAt, 2);
  assert.equal(r.commanded, null);
  r = p.infuse(62, null);
  assert.ok(Math.abs(r.volumeInfused - 10) < 1e-12, "a minute at 600 from the acknowledgement, not from the command");
  // A second command before the first is acknowledged replaces it.
  p.infuse(100, 1200);
  r = p.infuse(101, 300);
  assert.deepEqual(r.commanded, { rate: 300, at: 103 });
  r = p.infuse(104, null);
  assert.equal(r.rate, 300);
});

test("SimulatedPump: a time in the past reads as now and a command given then takes effect from the pump's own time; horizon() is strictly later than the time asked or null", () => {
  const p = new SimulatedPump({ syringeVolume: 50, concentration: 10 });
  p.infuse(100, 600);
  const r = p.infuse(50, 300);
  assert.equal(r.time, 100, "the pump never goes back");
  assert.equal(r.rate, 300);
  assert.equal(r.acknowledgedAt, 100, "from the pump's time, not the past one");
  assert.equal(r.commanded, null);
  assert.equal(p.horizon(100), 100 + 50 * 3600 / 300);
  assert.equal(p.horizon(100 + 50 * 3600 / 300), null, "a horizon at the time asked is not a future event");
  assert.equal(p.horizon(1e9), null);
});

// ---------------------------------------------------------------------------
// FauxPump through a driver

test("FauxPump without a driver option runs a SimulatedPump at the true syringe concentration", async () => {
  const clock = fakeClock();
  const pump = await startedPump(clock, { syringeVolume: 30, trueConcentration: 20 });
  assert.ok(pump.driver instanceof SimulatedPump);
  assert.equal(pump.driver.syringeVolume, 30);
  assert.equal(pump.driver.concentration, 20, "mg per mL really in the syringe");
  await runTo(pump, clock, 30);
  const snap = pump.snapshot();
  assert.ok(Math.abs(snap.volumeInfused - pump.driver.volumeInfused) < 1e-12, "the pump's totaliser is the record's volume");
  assert.ok(Math.abs(snap.trueMassInfused - pump.driver.massInfused) < 1e-9, "and its drug totaliser the true mass");
  assert.equal(snap.pump.state, "running");
  assert.deepEqual(snap.pump.alarms, []);
});

test("the default pump run to empty from an epoch-scale start alarms syringeEmpty, and no tick polls the driver more than a few times", async () => {
  for (const offset of [0, 0.37]) {
    const clock = fakeClock();
    clock.set(offset);
    const pump = makePump(clock, { syringeVolume: 20 });
    pump.start();
    pump.setTarget(6, "effect");
    await pump.idle();
    let calls = 0;
    let maxCalls = 0;
    const infuse = pump.driver.infuse.bind(pump.driver);
    pump.driver.infuse = (time, rate) => { calls += 1; return infuse(time, rate); };
    let s = offset;
    while (s < 500) {
      s += 0.25;
      clock.set(s);
      calls = 0;
      pump.tick();
      await pump.idle();
      maxCalls = Math.max(maxCalls, calls);
    }
    const snap = pump.snapshot();
    assert.equal(snap.state, "alarm", `offset ${offset}: the syringe ran out`);
    assert.equal(snap.alarmKind, "syringeEmpty");
    assert.equal(pump.driver.syringeRemaining, 0);
    assert.equal(pump.driver.state, "stopped");
    assert.ok(Math.abs(snap.volumeInfused - 20) < 1e-9, `delivered the whole syringe (${snap.volumeInfused} mL)`);
    assert.ok(maxCalls <= 6, `at most a few driver calls per tick (saw ${maxCalls})`);
    assert.equal(snap.alarms.filter((a) => a.kind === "syringeEmpty").length, 1, "alarmed once");
  }
});

test("a driver whose horizon() is at or before the time asked is polled once per tick, not a million times", async () => {
  class StaleHorizonPump extends SimulatedPump {
    horizon(time) { return time - 1; }
  }
  const clock = fakeClock();
  const driver = new StaleHorizonPump({ syringeVolume: 50, concentration: 10 });
  let calls = 0;
  const infuse = driver.infuse.bind(driver);
  driver.infuse = (time, rate) => { calls += 1; return infuse(time, rate); };
  const pump = await startedPump(clock, { driver });
  calls = 0;
  clock.set(1);
  pump.tick();
  await pump.idle();
  assert.ok(calls <= 4, `one tick made ${calls} driver calls`);
  await runTo(pump, clock, 30);
  assert.equal(pump.snapshot().state, "running");
});

test("a pump that acknowledges late: the record carries the rate from the acknowledgement, the segment the command", async () => {
  const clock = fakeClock();
  const driver = new SimulatedPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", acknowledgeDelay: 2 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 3);
  // The first response took effect at 1.5 s (the actual latency); the pump runs it from 3.5 s.
  let events = rateEvents(pump.snapshot());
  assert.equal(events.length, 0, "nothing recorded while the pump has not acknowledged");
  assert.equal(pump.snapshot().rate, 0);
  assert.equal(pump.snapshot().segment.rate, 1200, "the segment is the command");
  assert.deepEqual(pump.snapshot().pump.commanded, { rate: 1200, at: (T0 + 3.5) * 1000 }, "the snapshot's pump block is in milliseconds, as its other times");
  await runTo(pump, clock, 4);
  events = rateEvents(pump.snapshot());
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].at - 3.5) < 1e-3, `recorded at ${events[0].at} s, the acknowledgement`);
  assert.equal(events[0].rate, 1200);
  assert.equal(events[0].source, "tci");
  assert.equal(pump.snapshot().rate, 1200);
  assert.ok(Math.abs(pump.snapshot().pump.acknowledgedAt / 1000 - (T0 + 3.5)) < 1e-6);
  assert.equal(pump.snapshot().pump.commanded, null);
  await runTo(pump, clock, 60);
  // Every later change is likewise two seconds after its command.
  const all = rateEvents(pump.snapshot());
  assert.ok(all.length >= 3);
  const x = pump.snapshot().exchanges.filter((e) => e.outcome === "applied");
  for (const e of all.slice(1)) {
    const command = x.find((c) => Math.abs(c.caseTimeApplied / 1000 - T0 - (e.at - 2)) < 1e-3);
    assert.ok(command, `the change at ${e.at} s answers a command applied two seconds earlier`);
  }
});

test("a pump that delivers half the commanded rate: the truth follows the pump's totaliser, the record and the belief the command", async () => {
  class LeakyPump extends SimulatedPump {
    _deliver(to, toEmpty) {
      const dt = to - this.t;
      if (dt > 0 && this.rate > 0 && this.state === "running") {
        const ml = 0.5 * this.rate * dt / 3600;
        this.volumeInfused += ml;
        this.massInfused += ml * this.concentration;
        this.syringeRemaining = Math.max(0, this.syringeRemaining - ml);
      }
      this.t = to;
    }
  }
  const clock = fakeClock();
  const driver = new LeakyPump({ syringeVolume: 50, concentration: 10, massUnits: "mg" });
  const pump = await startedPump(clock, { driver });
  // The pump's totaliser at the instant each request is formed.
  const sent = [];
  pump.onExchange((x) => {
    if (x.outcome === "pending" && x.request && !sent.some((s) => s.id === x.id)) {
      sent.push({ id: x.id, massAtSend: driver.massInfused, reported: x.request.pump.volumeInfused.value });
    }
  });
  await runTo(pump, clock, 300);
  const snap = pump.snapshot();
  assert.ok(Math.abs(snap.truth.ce / snap.predicted.ce - 0.5) < 1e-9,
    `true Ce ${snap.truth.ce} is exactly half the controller's ${snap.predicted.ce}: half the drug arrived`);
  assert.equal(snap.state, "running", "nothing told the controller: no alarm");
  assert.ok(Math.abs(snap.volumeInfused - driver.volumeInfused) < 1e-12);
  assert.ok(sent.length >= 10);
  for (const s of sent) {
    assert.ok(Math.abs(s.reported - s.massAtSend) < 1e-9 * Math.max(1, s.massAtSend),
      `${s.id} reports the pump's own totaliser (${s.reported} vs ${s.massAtSend} mg), which the server holds against the record`);
  }
  const commanded = rateEvents(snap).map((e) => e.rate);
  assert.ok(commanded[0] === 1200, "the record is the rate commanded and acknowledged, not the volume delivered");
});

test("an alarm the pump reports stops the controller at the alarm's own time; target 0 leaves it stopped; a cleared alarm the pump still reports comes back; occlusion is the controller's state and a stopped pump is standby once cleared", async () => {
  const clock = fakeClock();
  // The line occludes 5.2 s in, during the loading infusion.
  const driver = new OccludingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", occludeAt: T0 + 5.2 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 30);
  let snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "occlusion");
  assert.equal(snap.apiState, "occlusion", "the controller's own state is the kind the contract names (it does not ask while in alarm)");
  assert.equal(snap.rate, 0);
  const stop = rateEvents(snap).pop();
  assert.equal(stop.rate, 0);
  assert.equal(stop.source, "pump");
  assert.ok(Math.abs(stop.at - 5.2) < 1e-3, `the stop is recorded at ${stop.at} s, when the pump stopped, not when the controller looked`);
  assert.ok(Math.abs(snap.alarms[0].time - (T0 + 5.2)) < 1e-6);
  assert.match(snap.alarms[0].message, /occluded/);
  assert.equal(snap.alarms.length, 1, "one standing alarm is raised once");
  assert.equal(snap.nextRequestAt, null, "in alarm the controller waits");
  const sent = snap.exchanges.length;
  // Target 0 on an alarmed pump: nothing to run, the alarm stands, no request.
  pump.stop();
  await runTo(pump, clock, 32);
  snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarms.length, 1);
  assert.equal(snap.exchanges.length, sent, "no request for a target of 0 on a stopped pump");
  assert.equal(snap.target.value, 0);
  // The user clears the alarm by setting a target, but the pump still reports the occlusion.
  pump.setTarget(3);
  await runTo(pump, clock, 40);
  snap = pump.snapshot();
  assert.equal(snap.state, "alarm", "the pump's condition stands");
  assert.equal(snap.alarmKind, "occlusion");
  assert.match(snap.alarms[snap.alarms.length - 1].message, /still/);
  assert.equal(snap.alarms.length, 2);
  assert.equal(snap.rate, 0);
  assert.equal(snap.nextRequestAt, null, "a response discarded in alarm leaves no request scheduled");
  const cleared = snap.exchanges[snap.exchanges.length - 1];
  assert.equal(cleared.outcome, "late-discarded");
  assert.equal(cleared.request.pump.state, "standby", "once the user clears the alarm, a pump still stopped is reported as standby");
  // Once the line is cleared on the pump, a new target restarts the case.
  driver.clearOcclusion();
  pump.setTarget(3);
  await runTo(pump, clock, 55);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0, `the pump runs again (${snap.rate} mL/hr)`);
  assert.ok(snap.exchanges.length > sent);
  assert.equal(snap.apiState, "running");
});

test("an alarm absorbed by the physics just before a hold end or a fallback end (the server gone away) does not crash the controller and raises no fallbackExpired", async () => {
  for (const [occludeAt, where] of [[11.2, "hold"], [21.2, "fallback"]]) {
    const clock = fakeClock();
    const driver = new OccludingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", occludeAt: T0 + occludeAt });
    const pump = await startedPump(clock, { driver, transport: answersOnceThenHangs() });
    // The first response (hold 10 s from 1.5 s, fallback to 21.5 s) is the only one; the occlusion lands 0.3 s before the event.
    await tickTo(pump, clock, 60);
    const snap = pump.snapshot();
    assert.equal(snap.state, "alarm", `${where}: the occlusion alarmed`);
    assert.equal(snap.alarmKind, "occlusion");
    assert.equal(snap.segment, null);
    assert.deepEqual([...new Set(snap.alarms.map((a) => a.kind))], ["occlusion"], `${where}: no fallbackExpired over the pump's own alarm`);
    const stop = rateEvents(snap).pop();
    assert.equal(stop.rate, 0);
    assert.ok(Math.abs(stop.at - occludeAt) < 1e-3, `${where}: the stop is at the occlusion (${stop.at} s)`);
    assert.equal(stop.source, "pump");
  }
});

test("an alarm the command itself provokes: no segment is installed, the exchange is refused, no fallbackExpired follows, and the case restarts once the pump is cleared", async () => {
  class RefusingPump extends SimulatedPump {
    constructor(o) { super(o); this.refuseNext = true; }
    infuse(time, rate) {
      if (this.refuseNext && rate !== null && rate !== undefined && rate > 0) {
        this.refuseNext = false;
        const r = super.infuse(time, 0);
        this.state = "stopped";
        this.alarms.push({ kind: "rateRefused", message: `the pump refused ${rate} mL/hr`, at: time });
        return { ...r, state: this.state, alarms: this.alarms.map((a) => ({ ...a })) };
      }
      return super.infuse(time, rate);
    }
    clear() { this.alarms = []; this.state = "running"; }
  }
  const clock = fakeClock();
  const driver = new RefusingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg" });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 60);
  let snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "rateRefused");
  assert.equal(snap.segment, null, "no segment on a pump in alarm");
  assert.equal(snap.alarms.length, 1);
  assert.deepEqual(snap.alarms.map((a) => a.kind), ["rateRefused"], "no fallbackExpired, no (still)");
  const first = snap.exchanges[0];
  assert.equal(first.outcome, "refused");
  assert.match(first.summary, /rateRefused/);
  assert.equal(rateEvents(snap).length, 0, "nothing ran, nothing recorded");
  assert.ok(!snap.notes.some((n) => /hold of .* ended/.test(n.message)), "no hold ran on a stopped pump");
  driver.clear();
  pump.setTarget(3);
  await runTo(pump, clock, 75);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0);
});

test("two alarms in one reading are raised once each and stand together; clearing them brings both back once", async () => {
  const clock = fakeClock();
  const driver = new OccludingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", occludeAt: T0 + 5.2, kinds: ["doorOpen", "occlusion"] });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 66);
  let snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.deepEqual(snap.alarms.map((a) => a.kind), ["doorOpen", "occlusion"]);
  assert.equal(snap.alarmKind, "occlusion", "the kind the API names is the one reported");
  assert.equal(snap.apiState, "occlusion");
  const notes = snap.notes.filter((n) => /ALARM/.test(n.message)).length;
  assert.equal(notes, 2);
  pump.setTarget(3);
  await runTo(pump, clock, 126);
  snap = pump.snapshot();
  assert.equal(snap.alarms.length, 4, "each comes back once when the user clears them");
  assert.ok(snap.alarms.slice(2).every((a) => /still/.test(a.message)));
  assert.equal(snap.state, "alarm");
});

test("an alarm reported while the pump still runs: the controller commands the stop, records it when the pump reports 0, and keeps its own commands' sources", async () => {
  class AdvisoryPump extends SimulatedPump {
    constructor(o) { super(o); this.alarmAt = o.alarmAt; this.commands = []; }
    infuse(time, rate) {
      if (rate !== null && rate !== undefined) this.commands.push({ time: time - T0, rate });
      return super.infuse(time, rate);
    }
    _advance(to) {
      super._advance(to);
      if (this.alarmAt !== null && to >= this.alarmAt) {
        this.alarms.push({ kind: "lowBattery", message: "battery low", at: this.alarmAt });
        this.alarmAt = null;
      }
    }
  }
  const clock = fakeClock();
  const driver = new AdvisoryPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", alarmAt: T0 + 20.3 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 60);
  const snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "lowBattery");
  assert.equal(driver.rate, 0, "the pump was stopped");
  const stopCommand = driver.commands.find((c) => c.rate === 0 && c.time >= 20.3);
  assert.ok(stopCommand, "the controller commanded 0 on the alarm");
  assert.ok(Math.abs(stopCommand.time - 20.5) < 1e-3, `commanded at the reading that showed the alarm (${stopCommand.time} s)`);
  const events = rateEvents(snap);
  const stop = events[events.length - 1];
  assert.equal(stop.rate, 0);
  assert.equal(stop.source, "pump");
  assert.ok(Math.abs(stop.at - 20.5) < 1e-3, `the stop is recorded when the pump reported 0 (${stop.at} s), not at an alarm time the pump kept running past`);
  assert.deepEqual(events.slice(0, -1).map((e) => e.source), events.slice(0, -1).map(() => "tci"), "the controller's own commands keep their source");
  assert.ok(!snap.notes.some((n) => /did not command/.test(n.message)));
  assert.ok(Math.abs(driver.volumeInfused - snap.volumeInfused) < 1e-9);
  assert.ok(driver.volumeInfused < 10, `the pump did not run on (${driver.volumeInfused} mL)`);
});

test("a notice the pump reports is noted once and changes nothing", async () => {
  class NoticingPump extends SimulatedPump {
    constructor(o) { super(o); this.noticeAt = o.noticeAt; }
    _advance(to) {
      super._advance(to);
      if (this.noticeAt !== null && to >= this.noticeAt) {
        this.notices.push({ kind: "lowBattery", message: "battery low", at: this.noticeAt });
        this.noticeAt = null;
      }
    }
  }
  const clock = fakeClock();
  const driver = new NoticingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", noticeAt: T0 + 20.3 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 90);
  const snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.deepEqual(snap.alarms, []);
  assert.ok(snap.exchanges.length >= 6 && snap.exchanges.slice(0, -1).every((x) => x.outcome === "applied"), "the case ran on");
  const notes = snap.notes.filter((n) => /battery low/.test(n.message));
  assert.equal(notes.length, 1, "noted once");
  assert.ok(Math.abs(notes[0].time - (T0 + 20.3)) < 1e-6);
  assert.equal(snap.pump.notices.length, 1);
  assert.equal(snap.pump.notices[0].at, (T0 + 20.3) * 1000);
});

test("a rate the pump reports that the controller did not command is recorded with source pump", async () => {
  class WilfulPump extends SimulatedPump {
    constructor(o) { super(o); this.changeAt = o.changeAt; }
    _advance(to) {
      if (this.changeAt !== null && to >= this.changeAt) {
        super._advance(this.changeAt);
        this.rate = 7;
        this.acknowledgedAt = this.changeAt;
        this.changeAt = null;
      }
      super._advance(to);
    }
  }
  const clock = fakeClock();
  const pump = await startedPump(clock, { driver: new WilfulPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", changeAt: T0 + 20.3 }) });
  await runTo(pump, clock, 21);
  const snap = pump.snapshot();
  const e = rateEvents(snap).find((ev) => ev.rate === 7);
  assert.ok(e, "the pump's own rate is in the record");
  assert.equal(e.source, "pump");
  assert.ok(Math.abs(e.at - 20.3) < 1e-3, `recorded at ${e.at} s`);
  assert.ok(snap.notes.some((n) => /did not command/.test(n.message)));
  assert.equal(snap.rate, 7);
});

test("a pump that echoes the rate at its own precision answers the command within the rate resolution: the record carries its value with the command's source", async () => {
  class Float32Pump extends SimulatedPump {
    reading() { const r = super.reading(); r.rate = Math.fround(r.rate); return r; }
  }
  const clock = fakeClock();
  const pump = await startedPump(clock, { driver: new Float32Pump({ syringeVolume: 50, concentration: 10, massUnits: "mg" }) });
  await runTo(pump, clock, 120);
  const snap = pump.snapshot();
  const events = rateEvents(snap);
  assert.ok(events.length >= 4);
  assert.ok(events.every((e) => e.source !== "pump"), `every change is the command it answers: ${JSON.stringify(events)}`);
  assert.ok(!snap.notes.some((n) => /did not command/.test(n.message)));
  assert.equal(snap.pump.commanded, null);
  assert.equal(pump._commanded, null, "no command is left pending");
  assert.ok(events.some((e) => e.rate !== Math.round(e.rate * 10) / 10), "the record carries the pump's own value");
});

test("the pump's totalisers are rebased to the case: a counter that is not zero at the first reading, or that resets, never credits or debits the patient", async () => {
  class PrimedPump extends SimulatedPump {
    constructor(o) { super(o); this.volumeInfused = 12.3; this.massInfused = 123; }
  }
  class ResettingPump extends SimulatedPump {
    constructor(o) { super(o); this.resetAt = o.resetAt; }
    _advance(to) {
      super._advance(to);
      if (this.resetAt !== null && to >= this.resetAt) { this.volumeInfused = 0; this.massInfused = 0; this.resetAt = null; }
    }
  }
  const ref = fakeClock();
  const reference = await startedPump(ref, { syringeVolume: 50 }, 6);
  await runTo(reference, ref, 120);
  const refSnap = reference.snapshot();

  const c1 = fakeClock();
  const primed = new PrimedPump({ syringeVolume: 50, concentration: 10, massUnits: "mg" });
  const p1 = await startedPump(c1, { driver: primed }, 6);
  assert.equal(p1.snapshot().volumeInfused, 0, "the counter at the start is the baseline");
  assert.equal(p1.snapshot().trueMassInfused, 0);
  await runTo(p1, c1, 120);
  let snap = p1.snapshot();
  assert.ok(Math.abs(snap.volumeInfused - (primed.volumeInfused - 12.3)) < 1e-9);
  assert.ok(Math.abs(snap.volumeInfused - refSnap.volumeInfused) < 1e-9, "the same case as a fresh counter");
  assert.ok(Math.abs(snap.truth.cp - refSnap.truth.cp) < 1e-9);

  const c2 = fakeClock();
  const resetting = new ResettingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", resetAt: T0 + 60.1 });
  const p2 = await startedPump(c2, { driver: resetting }, 6);
  const sent = [];
  p2.onExchange((x) => { if (x.outcome === "pending" && x.request) sent.push(x.request.pump.volumeInfused.value); });
  await runTo(p2, c2, 120);
  snap = p2.snapshot();
  assert.ok(snap.notes.some((n) => /reset/.test(n.message)), "the reset is noted");
  // The half second of delivery the pump's counter dropped at the reset is lost, nothing else.
  const lost = 0.5 * 1200 / 3600;
  assert.ok(snap.volumeInfused <= refSnap.volumeInfused + 1e-9 && snap.volumeInfused >= refSnap.volumeInfused - lost - 1e-9,
    `${snap.volumeInfused} mL counted against ${refSnap.volumeInfused} mL`);
  assert.ok(snap.truth.cp > 0.9 * refSnap.truth.cp && snap.truth.cp <= refSnap.truth.cp + 1e-9, `true Cp ${snap.truth.cp} vs ${refSnap.truth.cp}`);
  assert.ok(snap.truth.p.every((a) => a >= 0), "no negative amounts in the patient");
  assert.ok(sent.every((v) => v >= 0), "every request's totaliser is non-negative");
  assert.ok(sent[sent.length - 1] > sent[0]);
});

test("every driver is told the initial syringe at start(), with the volume in mL, the true concentration in the drug's base unit per mL, the unit and the drug", async () => {
  class SpyPump extends SimulatedPump {
    constructor(o) { super(o); this.loads = []; }
    loadSyringe(time, syringe) { this.loads.push({ time: time - T0, ...syringe }); return super.loadSyringe(time, syringe); }
  }
  const clock = fakeClock();
  const driver = new SpyPump({});
  const pump = await startedPump(clock, { driver, syringeVolume: 20, trueConcentration: 5 });
  assert.equal(driver.loads.length, 1);
  assert.deepEqual(driver.loads[0], { time: 0, volume: 20, concentration: 5, units: "mg", drug: "propofol" });
  assert.equal(driver.syringeVolume, 20);
  assert.equal(driver.concentration, 5);
  await runTo(pump, clock, 30);
  pump.changeSyringe(10, 20, 30);
  await runTo(pump, clock, 31);
  assert.equal(driver.loads.length, 2);
  assert.ok(Math.abs(driver.loads[1].time - 30) < 1e-6);
  assert.deepEqual({ ...driver.loads[1], time: 0 }, { time: 0, volume: 30, concentration: 20, units: "mg", drug: "propofol" });
  // Remifentanil: the base unit is mcg, so the concentration arrives in mcg/mL.
  const c2 = fakeClock();
  const d2 = new SpyPump({});
  await startedPump(c2, {
    driver: d2, drug: "remifentanil", syringe: { concentration: 0.05, units: "mg/mL" }, trueConcentration: 0.04, syringeVolume: 30,
  }, 4);
  assert.deepEqual(d2.loads[0], { time: 0, volume: 30, concentration: 40, units: "mcg", drug: "remifentanil" });
});

test("massInfused is converted by massUnits into the drug's unit; an unknown unit falls back to the volume totaliser, with a note", async () => {
  const remi = { drug: "remifentanil", syringe: { concentration: 50, units: "mcg/mL" }, syringeVolume: 50 };
  class MgPump extends SimulatedPump {
    reading() { const r = super.reading(); r.massInfused = r.massInfused / 1000; r.massUnits = "mg"; return r; }
  }
  class OddPump extends SimulatedPump {
    reading() { const r = super.reading(); r.massInfused = r.massInfused * 7; r.massUnits = "units"; return r; }
  }
  const runs = [];
  for (const Driver of [SimulatedPump, MgPump, OddPump]) {
    const clock = fakeClock();
    const driver = new Driver({ syringeVolume: 50, concentration: 50, massUnits: "mcg" });
    const pump = await startedPump(clock, { ...remi, driver }, 4);
    await runTo(pump, clock, 120);
    runs.push(pump.snapshot());
  }
  const [plain, mg, odd] = runs;
  assert.ok(plain.trueMassInfused > 10, `delivered ${plain.trueMassInfused} mcg`);
  assert.ok(Math.abs(mg.trueMassInfused - plain.trueMassInfused) < 1e-9 * plain.trueMassInfused, `${mg.trueMassInfused} mcg from a mg totaliser`);
  assert.ok(Math.abs(mg.truth.ce - plain.truth.ce) < 1e-9 * plain.truth.ce);
  assert.ok(Math.abs(odd.trueMassInfused - plain.trueMassInfused) < 1e-9 * plain.trueMassInfused, "the volume at the true concentration");
  assert.equal(odd.notes.filter((n) => /not mg or mcg/.test(n.message)).length, 1, "said once");
  assert.equal(mg.exchanges[mg.exchanges.length - 1].request.pump.volumeInfused.units, "mcg");
});

test("a driver that returns a Promise or throws is a driver fault: an alarm, not a crash; the exchange is not left pending; the case restarts when the link is back", async () => {
  class AsyncPump extends SimulatedPump {
    async infuse(time, rate) { return super.infuse(time, rate); }
  }
  const c1 = fakeClock();
  const p1 = await startedPump(c1, { driver: new AsyncPump({ syringeVolume: 50, concentration: 10 }) });
  await runTo(p1, c1, 5);
  let snap = p1.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "driverFault");
  assert.match(snap.alarms[0].message, /Promise/);
  assert.equal(snap.alarms.length, 1, "raised once, not every tick");

  class FlakyPump extends SimulatedPump {
    constructor(o) { super(o); this.failFrom = o.failFrom; this.failing = false; }
    infuse(time, rate) {
      if (this.failFrom !== null && time >= this.failFrom) this.failing = true;
      // Status reads keep working; commands time out.
      if (this.failing && rate !== null && rate !== undefined) throw new Error("serial timeout");
      return super.infuse(time, rate);
    }
    recover() { this.failing = false; this.failFrom = null; }
  }
  // The pump stops taking commands at 11 s: the second command (at 11.5 s) fails.
  const c2 = fakeClock();
  const driver = new FlakyPump({ syringeVolume: 50, concentration: 10, failFrom: T0 + 11 });
  const p2 = await startedPump(c2, { driver });
  await runTo(p2, c2, 40);
  snap = p2.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "driverFault");
  assert.match(snap.alarms[0].message, /serial timeout/);
  assert.equal(snap.alarms.length, 1);
  assert.ok(Math.abs(snap.caseSeconds - 40) < 1e-6, "the controller's clock kept running");
  assert.ok(snap.exchanges.every((x) => x.outcome !== "pending"), `no exchange is left pending: ${snap.exchanges.map((x) => x.outcome)}`);
  assert.equal(snap.exchanges[1].outcome, "refused");
  assert.equal(snap.segment, null);
  assert.ok(!rateEvents(snap).some((e) => e.source === "fallback"), "no fallback ran on an unreachable pump");
  assert.ok(!rateEvents(snap).some((e) => e.at > 11), "nothing was recorded that the controller did not see");
  driver.recover();
  p2.setTarget(3);
  await runTo(p2, c2, 60);
  snap = p2.snapshot();
  assert.equal(snap.state, "running");
  assert.equal(snap.alarms.length, 1);
  // The pump ran its loading rate all through the fault (the controller could
  // not stop it, and its record says so), so the controller now holds it at 0.
  const applied = snap.exchanges.filter((x) => x.outcome === "applied").pop();
  assert.ok(applied && applied.caseTimeApplied / 1000 - T0 > 40, "a command after the recovery was applied");
  assert.ok(Math.abs(driver.rate - snap.rate) < 1e-9, `the pump runs what the controller commands again (${driver.rate} vs ${snap.rate})`);
  assert.ok(rateEvents(snap).some((e) => e.at > 40 && e.source === "tci"), "and it is in the record");
  // The drug the pump delivered while unreachable reaches the truth through the totaliser when the link is back.
  assert.ok(Math.abs(snap.volumeInfused - driver.volumeInfused) < 1e-9);
});

test("a pump paused from its own panel pauses the controller (the plan is noted, not run) and resumes it when the pump runs again", async () => {
  class PausingPump extends SimulatedPump {
    constructor(o) { super(o); this.pauseAt = o.pauseAt; }
    _advance(to) {
      if (this.pauseAt !== null && to >= this.pauseAt) {
        super._advance(this.pauseAt);
        this.rate = 0;
        this.acknowledgedAt = this.pauseAt;
        this.state = "paused";
        this.pauseAt = null;
      }
      super._advance(to);
    }
    _applyCommand() { const c = this.commanded; super._applyCommand(); if (this.state === "paused") { this.rate = 0; this.held = c.rate; } }
    resumeOnPump() { this.state = "running"; }
  }
  const clock = fakeClock();
  const driver = new PausingPump({ syringeVolume: 50, concentration: 10, pauseAt: T0 + 20.3 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 45);
  let snap = pump.snapshot();
  assert.equal(snap.state, "paused");
  assert.equal(snap.rate, 0);
  assert.equal(snap.segment, null);
  const last = snap.exchanges[snap.exchanges.length - 1];
  assert.equal(last.request.pump.state, "paused", "the server is told the pump is paused");
  assert.match(last.summary, /paused/);
  assert.ok(snap.notes.some((n) => /reports itself paused/.test(n.message)));
  driver.resumeOnPump();
  await runTo(pump, clock, 50);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0, `running again at ${snap.rate} mL/hr`);
  assert.ok(snap.notes.some((n) => /running again/.test(n.message)));
  await runTo(pump, clock, 150);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0 && Math.abs(snap.predicted.ce - 3) < 0.1, `on target (${snap.predicted.ce}) at ${snap.rate} mL/hr`);
});

test("a pump that cannot tell its syringe volume: the controller derives it from the volume totalised since the load", async () => {
  class BlindPump extends SimulatedPump {
    reading() { const r = super.reading(); r.syringeRemaining = null; return r; }
  }
  const clock = fakeClock();
  const driver = new BlindPump({ syringeVolume: 50, concentration: 10 });
  const pump = await startedPump(clock, { driver }, 6);
  const sent = [];
  pump.onExchange((x) => { if (x.outcome === "pending" && x.request) sent.push({ reported: x.request.pump.syringeVolumeRemaining.value, delivered: driver.volumeInfused }); });
  await runTo(pump, clock, 120);
  let snap = pump.snapshot();
  assert.ok(snap.volumeInfused > 4);
  assert.ok(Math.abs(snap.syringeRemaining - (50 - snap.volumeInfused)) < 1e-9, `${snap.syringeRemaining} mL left of 50 after ${snap.volumeInfused} mL`);
  assert.ok(Math.abs(snap.syringeRemaining - driver.syringeRemaining) < 1e-9, "which is what the syringe really holds");
  for (const s of sent) assert.ok(Math.abs(s.reported - (50 - s.delivered)) < 1e-9);
  pump.changeSyringe(10, 10, 30);
  snap = pump.snapshot();
  assert.ok(Math.abs(snap.syringeRemaining - 30) < 1e-9, "a new syringe is full");
  await runTo(pump, clock, 180);
  snap = pump.snapshot();
  assert.ok(snap.syringeRemaining < 30 - 1e-6);
  assert.ok(Math.abs(snap.syringeRemaining - driver.syringeRemaining) < 1e-9);
});

test("a rate change the pump reports late, with its true acknowledgement time, keeps the record chronological", async () => {
  class LaggingPump extends SimulatedPump {
    constructor(o) { super(o); this.shown = { rate: 0, at: null }; this.pending = null; }
    _applyCommand() {
      const before = { rate: this.rate, at: this.acknowledgedAt };
      super._applyCommand();
      this.pending = { rate: this.rate, at: this.acknowledgedAt, before };
    }
    reading() {
      const r = super.reading();
      if (this.pending && this.t >= this.pending.at + 2) { this.shown = { rate: this.pending.rate, at: this.pending.at }; this.pending = null; }
      if (this.pending) { r.rate = this.pending.before.rate; r.acknowledgedAt = this.pending.before.at; }
      else { r.rate = this.shown.rate; r.acknowledgedAt = this.shown.at; }
      return r;
    }
  }
  const clock = fakeClock();
  const pump = await startedPump(clock, { driver: new LaggingPump({ syringeVolume: 50, concentration: 10 }) });
  await runTo(pump, clock, 2.5);
  pump.handBolus(10); // at 2.5 s, before the pump has shown the 1.5 s command running
  await runTo(pump, clock, 6);
  const snap = pump.snapshot();
  const times = eventTimes(snap);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `the record is in time order: ${times.map((t) => t - T0)}`);
  const first = rateEvents(snap)[0];
  assert.equal(first.rate, 1200);
  assert.ok(Math.abs(first.at - 2.5) < 1e-3, `the late-reported change is placed no earlier than the bolus already recorded (${first.at} s)`);
  assert.equal(first.source, "tci");
});

// ---------------------------------------------------------------------------
// After the second review: who paused, mass seen in a command's reading, a
// case that starts in alarm, a syringe change the driver did not take, a
// stop acknowledged late, and a reading ahead of the clock.

class PausingPump extends SimulatedPump {
  constructor(o) { super(o); this.pauseAt = o.pauseAt === undefined ? null : o.pauseAt; this.unpauseAt = o.unpauseAt === undefined ? null : o.unpauseAt; }
  _advance(to) {
    if (this.pauseAt !== null && to >= this.pauseAt) {
      super._advance(this.pauseAt);
      this.rate = 0;
      this.acknowledgedAt = this.pauseAt;
      this.state = "paused";
      this.pauseAt = null;
    }
    if (this.unpauseAt !== null && to >= this.unpauseAt) {
      super._advance(this.unpauseAt);
      this.state = "running";
      this.unpauseAt = null;
    }
    super._advance(to);
  }
  _applyCommand() { super._applyCommand(); if (this.state === "paused") this.rate = 0; }
}

test("the user's own Pause holds after a pause the pump made earlier: the flag follows who paused", async () => {
  // Path 1: the pump pauses itself, the user presses Resume while it is still
  // paused (the controller re-pauses at the next reading), the pump runs
  // again on its own (the controller resumes), and later the user pauses.
  const c1 = fakeClock();
  const d1 = new PausingPump({ syringeVolume: 50, concentration: 10, pauseAt: T0 + 20.3, unpauseAt: T0 + 30 });
  const p1 = await startedPump(c1, { driver: d1 });
  await runTo(p1, c1, 25);
  assert.equal(p1.snapshot().state, "paused");
  p1.resume();
  await runTo(p1, c1, 26);
  assert.equal(p1.snapshot().state, "paused", "the pump is still paused, so the controller is again");
  await runTo(p1, c1, 60);
  assert.equal(p1.snapshot().state, "running", "the pump ran again and the controller followed");
  p1.pause();
  await runTo(p1, c1, 70);
  let snap = p1.snapshot();
  assert.equal(snap.state, "paused", "the user's Pause holds while the pump reports itself running at 0");
  assert.equal(snap.rate, 0);
  assert.ok(!snap.notes.some((n) => n.time - T0 > 60 && /running again/.test(n.message)), "no un-pause the user did not ask for");
  p1.resume();
  await runTo(p1, c1, 80);
  assert.equal(p1.snapshot().state, "running");

  // Path 2: the user presses Pause while the pump is pump-paused; the pump
  // then runs again on its own: the controller stays paused until Resume.
  const c2 = fakeClock();
  const d2 = new PausingPump({ syringeVolume: 50, concentration: 10, pauseAt: T0 + 20.3, unpauseAt: T0 + 30 });
  const p2 = await startedPump(c2, { driver: d2 });
  await runTo(p2, c2, 25);
  p2.pause();
  await runTo(p2, c2, 45);
  snap = p2.snapshot();
  assert.equal(snap.state, "paused", "the user's Pause over the pump's is the user's");
  assert.equal(snap.rate, 0);
  p2.resume();
  await runTo(p2, c2, 50);
  assert.equal(p2.snapshot().state, "running");
  assert.ok(p2.snapshot().rate > 0, `running again after Resume (${p2.snapshot().rate} mL/hr)`);

  // Path 3: an alarm while pump-paused, cleared by the user with the pump
  // running again; a later user Pause holds.
  const c3 = fakeClock();
  class AlarmingPausingPump extends PausingPump {
    _advance(to) { super._advance(to); if (this.alarmAt !== undefined && this.alarmAt !== null && to >= this.alarmAt) { this.alarms.push({ kind: "doorOpen", message: "door open", at: this.alarmAt }); this.alarmAt = null; } }
    close() { this.alarms = []; this.state = "running"; }
  }
  const d3 = new AlarmingPausingPump({ syringeVolume: 50, concentration: 10, pauseAt: T0 + 20.3 });
  d3.alarmAt = T0 + 30;
  const p3 = await startedPump(c3, { driver: d3 });
  await runTo(p3, c3, 35);
  assert.equal(p3.snapshot().state, "alarm");
  d3.close();
  p3.setTarget(3);
  await runTo(p3, c3, 120);
  assert.equal(p3.snapshot().state, "running");
  p3.pause();
  await runTo(p3, c3, 140);
  assert.equal(p3.snapshot().state, "paused", "the user's Pause holds after an alarm cleared an earlier pump pause");
});

test("mass a command's reading shows delivered reaches the truth", async () => {
  // A driver answering from a background-updated cache can return a larger
  // totaliser on the reading that acknowledges a command.
  class JitterPump extends SimulatedPump {
    infuse(time, rate) {
      const r = super.infuse(time, rate);
      if (rate !== null && rate !== undefined && this.state === "running") {
        this.volumeInfused += 0.02;
        this.massInfused += 0.02 * this.concentration;
        this.syringeRemaining -= 0.02;
        return this.reading();
      }
      return r;
    }
  }
  const cr = fakeClock();
  const ref = await startedPump(cr, {});
  await runTo(ref, cr, 120);
  const cj = fakeClock();
  const jitter = await startedPump(cj, { driver: new JitterPump({ syringeVolume: 50, concentration: 10 }) });
  await runTo(jitter, cj, 120);
  const a = ref.snapshot();
  const b = jitter.snapshot();
  assert.ok(b.trueMassInfused > a.trueMassInfused + 0.5, `the extra mass is in the totals (${b.trueMassInfused} vs ${a.trueMassInfused} mg)`);
  assert.ok(b.truth.cp > a.truth.cp + 1e-6, `and in the patient (${b.truth.cp} vs ${a.truth.cp})`);
  assert.ok(Math.abs(b.predicted.cp - a.predicted.cp) < 1e-9, "the belief, which follows the commands, is unchanged");
});

test("a case that starts in alarm schedules no request", async () => {
  class DeadPump extends SimulatedPump {
    infuse() { throw new Error("no pump"); }
    loadSyringe() { throw new Error("no pump"); }
  }
  const clock = fakeClock();
  const pump = makePump(clock, { driver: new DeadPump({}), target: { site: "effect", value: 3 } });
  clock.set(0);
  pump.start();
  await pump.idle();
  await runTo(pump, clock, 5);
  const snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "driverFault");
  assert.equal(snap.nextRequestAt, null, "in alarm the controller waits");
  assert.equal(snap.exchanges.length, 0);
});

test("a syringe change the driver did not take is sent again at its first reading, and said so", async () => {
  class FlakyLoad extends SimulatedPump {
    constructor(o) { super(o); this.loads = []; this.failLoads = false; }
    loadSyringe(time, syringe) {
      if (this.failLoads) throw new Error("pump busy");
      this.loads.push({ ...syringe });
      return super.loadSyringe(time, syringe);
    }
  }
  const clock = fakeClock();
  const driver = new FlakyLoad({ syringeVolume: 50, concentration: 10 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 30);
  driver.failLoads = true;
  pump.changeSyringe(10, 20, 30);
  let snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "driverFault");
  assert.ok(snap.notes.some((n) => /did not reach the pump/.test(n.message)));
  assert.equal(driver.loads.length, 1);
  driver.failLoads = false;
  pump.setTarget(3);
  await runTo(pump, clock, 40);
  snap = pump.snapshot();
  assert.equal(driver.loads.length, 2, "the change was sent again");
  assert.deepEqual(driver.loads[1], { volume: 30, concentration: 20, units: "mg", drug: "propofol" });
  assert.equal(driver.syringeVolume, 30);
  assert.equal(driver.concentration, 20);
  assert.ok(snap.notes.some((n) => /has reached the pump/.test(n.message)));
  assert.equal(snap.state, "running");
});

test("a stop the controller commanded on an alarm, acknowledged late, is recorded as the pump's stop without an 'unasked' note", async () => {
  class SlowAdvisoryPump extends SimulatedPump {
    constructor(o) { super(o); this.alarmAt = o.alarmAt; }
    _advance(to) {
      super._advance(to);
      if (this.alarmAt !== null && to >= this.alarmAt) {
        this.alarms.push({ kind: "lowBattery", message: "battery low", at: this.alarmAt });
        this.alarmAt = null;
      }
    }
  }
  const clock = fakeClock();
  const driver = new SlowAdvisoryPump({ syringeVolume: 50, concentration: 10, acknowledgeDelay: 2, alarmAt: T0 + 20.3 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 40);
  const snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  const stop = rateEvents(snap).pop();
  assert.equal(stop.rate, 0);
  assert.equal(stop.source, "pump");
  assert.ok(Math.abs(stop.at - 22.5) < 1e-3, `recorded when the pump acknowledged the stop (${stop.at} s)`);
  assert.ok(!snap.notes.some((n) => /did not command/.test(n.message)), "the stop was the controller's own");
  assert.equal(driver.rate, 0);
});

test("a reading ahead of the controller's clock is noted once", async () => {
  class AheadPump extends SimulatedPump {
    reading() { const r = super.reading(); r.time = r.time + 5; return r; }
  }
  const clock = fakeClock();
  const pump = await startedPump(clock, { driver: new AheadPump({ syringeVolume: 50, concentration: 10 }) });
  await runTo(pump, clock, 30);
  const notes = pump.snapshot().notes.filter((n) => /ahead of the controller's clock/.test(n.message));
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /5 s ahead/);
  assert.equal(pump.snapshot().state, "running", "a note, not an alarm");
});
