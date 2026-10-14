// Tests for js/driver.js, the pump driver interface and the simulated pump,
// and for FauxPump's use of a driver: the record follows what the pump
// acknowledges, the truth follows what the pump delivers, and an alarm the
// pump reports stops the controller at the alarm's own time.
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

// ---------------------------------------------------------------------------
// The interface and the simulated pump on their own

test("PumpDriver is an interface: its methods throw until a subclass provides them", () => {
  const d = new PumpDriver();
  assert.throws(() => d.infuse(0, 10), /not implemented/);
  assert.throws(() => d.loadSyringe(0, { volume: 50 }), /not implemented/);
  assert.equal(d.horizon(0), null, "horizon() may be left alone: null means the pump cannot predict");
  const r = makeReading({ rate: 5 });
  assert.equal(r.rate, 5);
  assert.deepEqual(Object.keys(r).sort(), ["acknowledgedAt", "alarms", "commanded", "massInfused", "massUnits", "rate", "state", "syringeRemaining", "time", "volumeInfused"]);
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
  assert.deepEqual(pump.snapshot().pump.commanded, { rate: 1200, at: T0 + 3.5 });
  await runTo(pump, clock, 4);
  events = rateEvents(pump.snapshot());
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].at - 3.5) < 1e-3, `recorded at ${events[0].at} s, the acknowledgement`);
  assert.equal(events[0].rate, 1200);
  assert.equal(events[0].source, "tci");
  assert.equal(pump.snapshot().rate, 1200);
  assert.ok(Math.abs(pump.snapshot().pump.acknowledgedAt / 1000 - (T0 + 3.5)) < 1e-6);
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
    _deliver(to) {
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
  await runTo(pump, clock, 300);
  const snap = pump.snapshot();
  assert.ok(snap.truth.ce < 0.7 * snap.predicted.ce,
    `true Ce ${snap.truth.ce} is well below the controller's ${snap.predicted.ce}: half the drug arrived`);
  assert.equal(snap.state, "running", "nothing told the controller: no alarm");
  assert.ok(Math.abs(snap.volumeInfused - driver.volumeInfused) < 1e-12);
  const last = snap.exchanges.filter((e) => e.outcome === "applied").pop();
  assert.ok(Math.abs(last.request.pump.volumeInfused.value - driver.massInfused) < 1e-6 ||
    last.request.pump.volumeInfused.value <= driver.massInfused,
    "the request reports the pump's own totaliser, which the server can hold against the record");
  const commanded = rateEvents(snap).map((e) => e.rate);
  assert.ok(commanded[0] === 1200, "the record is the rate commanded and acknowledged, not the volume delivered");
});

test("an alarm the pump reports stops the controller at the alarm's own time, and a cleared alarm the pump still reports comes back", async () => {
  class OccludingPump extends SimulatedPump {
    constructor(o) { super(o); this.occludeAt = o.occludeAt; }
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
    clearOcclusion() { this.alarms = this.alarms.filter((a) => a.kind !== "occlusion"); this.state = "running"; }
  }
  const clock = fakeClock();
  // The line occludes 5.2 s in, during the loading infusion.
  const driver = new OccludingPump({ syringeVolume: 50, concentration: 10, massUnits: "mg", occludeAt: T0 + 5.2 });
  const pump = await startedPump(clock, { driver });
  await runTo(pump, clock, 30);
  let snap = pump.snapshot();
  assert.equal(snap.state, "alarm");
  assert.equal(snap.alarmKind, "occlusion");
  assert.equal(snap.apiState, "alarm");
  assert.equal(snap.rate, 0);
  const stop = rateEvents(snap).pop();
  assert.equal(stop.rate, 0);
  assert.equal(stop.source, "pump");
  assert.ok(Math.abs(stop.at - 5.2) < 1e-3, `the stop is recorded at ${stop.at} s, when the pump stopped, not when the controller looked`);
  assert.ok(Math.abs(snap.alarms[0].time - (T0 + 5.2)) < 1e-6);
  assert.match(snap.alarms[0].message, /occluded/);
  assert.equal(snap.nextRequestAt, null, "in alarm the controller waits");
  const sent = snap.exchanges.length;
  // The user clears the alarm by setting a target, but the pump still reports the occlusion.
  pump.setTarget(3);
  await runTo(pump, clock, 40);
  snap = pump.snapshot();
  assert.equal(snap.state, "alarm", "the pump's condition stands");
  assert.equal(snap.alarmKind, "occlusion");
  assert.match(snap.alarms[snap.alarms.length - 1].message, /still/);
  assert.equal(snap.rate, 0);
  // Once the line is cleared on the pump, a new target restarts the case.
  driver.clearOcclusion();
  pump.setTarget(3);
  await runTo(pump, clock, 55);
  snap = pump.snapshot();
  assert.equal(snap.state, "running");
  assert.ok(snap.rate > 0, `the pump runs again (${snap.rate} mL/hr)`);
  assert.ok(snap.exchanges.length > sent);
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
