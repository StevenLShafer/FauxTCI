// Closed-loop conformance of js/pump.js against test/fixtures/closed-loop.json:
// six 30-minute traces of a controller + pump simulator run in R against
// stanpumpR's tciNextRate() (runLoop() in test/fixtures/generate.R).
//
// FauxPump is driven with a fake clock through the local transport with the
// trace's own settings, and at every one of the 181 steps the response it
// obtained, the rate it recorded and the true state of its model are
// compared with the fixture: rates to 1e-8 relative, limitedBy, plan, phase,
// every timing string and the warning codes exactly, the server's state at
// now to 1e-8, the true Cp and Ce to 1e-6, and the trace's maximum true Ce
// (sampled at the simulator's own instants) to 1e-6.
//
// The simulator's semantics, which the pump reproduces:
//   - a request every `interval` s from t = 0 to 1800 s inclusive, whatever
//     nextRequestAt says (the pump asks at min(nextRequestAt, sent +
//     interval); in every trace one waiting-for-peak step has nextRequestAt
//     later than the cadence, and both ask at the cadence);
//   - the pump switches to rate.value at now + actualLatency and records a
//     rate change only when the value differs from the running one;
//   - a target step or a hand bolus happens just before the request formed
//     at that minute, so that request carries it;
//   - the true state is the seven-amplitude recurrence at the rates run, and
//     the maximum true Ce is read from samples one second apart from the
//     start of each constant-rate span (span starts are the request times
//     and the switch times), which is what the fixture's `maxTrueCe` is.
// The simulator never stopped the pump on a lowered target (section 7, rule
// 6 says a pump MAY), so stopOnLoweredTarget is off here; it also sent no
// initial infusate event, which the pump always records, and which changes
// nothing numerically because the syringe never changes.  Each test prints
// the largest discrepancy it measured per field as a TAP diagnostic.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FauxPump } from "../js/pump.js";
import { makeTransport } from "../js/transport.js";
import { formatRfc3339 } from "../js/tci.js";

const closedLoop = JSON.parse(await readFile(new URL("./fixtures/closed-loop.json", import.meta.url), "utf8"));
const START = Date.parse(closedLoop.start);

const TOL_RATE = 1e-8; // rate.value, fallback.rate (relative)
// rate.ideal is the unclamped, unrounded rate.  At a pump-off step it is the
// residual of the effect-site search, (CT - B) / E at the touching point,
// where the near-cancellation CT - B amplifies the port's ~1e-11 ke0
// difference from R's by CT / (CT - B) (test/tci.test.js documents the same
// case): measured 3.6e-7 relative on 0.027 mL/hr and 2.3e-6 on 0.0044 mL/hr,
// i.e. 1e-8 mL/hr, values the pump sends as 0 under minRate.  That field is
// therefore held to 1e-8 relative or 1e-6 mL/hr absolute, a hundred-
// thousandth of the pump's resolution, whichever is looser.
const TOL_IDEAL_ABSOLUTE = 1e-6; // mL/hr
const TOL_STATE = 1e-8; // the server's state.now / state.holdUntil / prediction.peakCe (relative)
const TOL_TRUE = 1e-6; // the true Cp, Ce and the maximum true Ce (relative)
const NEAR_ZERO = 1e-9; // below this the fixture value is compared absolutely
const TOL_ABSOLUTE = 1e-10;

const relativeError = (value, reference) =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), Number.MIN_VALUE);

// Compare a number with its fixture value, keep the worst discrepancy per
// label, and fail with the step named.
function near(worst, label, value, reference, tol, where, absolute = TOL_ABSOLUTE) {
  assert.equal(typeof value, "number", `${where}: ${label} is not a number`);
  const measured = Math.abs(reference) < NEAR_ZERO ? Math.abs(value - reference) : relativeError(value, reference);
  if (!(worst[label] >= measured)) worst[label] = measured;
  const bound = Math.abs(reference) < NEAR_ZERO ? absolute : tol;
  const ok = measured <= bound || Math.abs(value - reference) <= absolute;
  assert.ok(ok,
    `${where}: ${label} = ${value}, fixture ${reference}, discrepancy ${measured.toExponential(3)} > ${bound}`);
}

const diagnostics = (t, worst) => {
  for (const [label, value] of Object.entries(worst)) {
    t.diagnostic(`  max discrepancy ${label}: ${value.toExponential(3)}`);
  }
};

test("closed-loop.json is what the README describes", () => {
  assert.equal(closedLoop.traces.length, 6);
  assert.equal(closedLoop.start, "2026-10-11T14:00:00.000Z");
  assert.equal(closedLoop.stanpumpRCommit, "7d2d2f1b7727f39eba313fd8c5deea5b5104d959");
  for (const trace of closedLoop.traces) {
    assert.equal(trace.steps.length, 181, trace.name);
    assert.equal(trace.steps[0].nowSeconds, 0);
    assert.equal(trace.steps[180].nowSeconds, 1800);
  }
});

for (const trace of closedLoop.traces) {
  test(`closed loop: ${trace.name}`, async (t) => {
    const spec = trace.spec;
    const clock = { ms: START, now() { return this.ms; } };
    const pump = new FauxPump({
      drug: spec.drug,
      patient: spec.patient,
      syringe: spec.infusate,
      limits: { maxRate: spec.maxRate, minRate: spec.minRate, rateResolution: spec.rateResolution },
      declaredLatency: spec.latency,
      actualLatency: spec.actualLatency,
      interval: spec.interval,
      clock,
      transport: makeTransport({ mode: "local" }),
      syringeVolume: 50,
      stopOnLoweredTarget: false, // the simulator did not exercise rule 6's optional stop
      requestIdPrefix: "cl",
    });
    pump.setTarget(spec.target, spec.site);
    const targetSteps = spec.targetSteps || [];
    const handBoluses = spec.handBoluses || [];
    const atMinute = (ev, seconds) => Math.abs(ev.minute * 60 - seconds) < 1e-9;

    const worst = {};
    let maxCe = -Infinity;
    let maxCeAt = null;
    const tickAt = (seconds) => {
      clock.ms = START + seconds * 1000;
      pump.tick();
    };
    const sampleAt = (seconds) => {
      tickAt(seconds);
      const c = pump.trueCe();
      if (c > maxCe) {
        maxCe = c;
        maxCeAt = seconds;
      }
    };

    const aL = spec.actualLatency;
    const steps = trace.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const now = step.nowSeconds;
      const where = `${trace.name} step ${step.index} (t = ${now} s)`;
      clock.ms = START + now * 1000;
      if (i === 0) pump.start();
      for (const ev of targetSteps) if (atMinute(ev, now)) pump.setTarget(ev.value);
      for (const ev of handBoluses) if (atMinute(ev, now)) pump.handBolus(ev.amount);
      pump.tick();
      // The truth at now, before the request's answer can have changed anything.
      near(worst, "trueCp", pump.trueCp(), step.trueCp, TOL_TRUE, where);
      near(worst, "trueCe", pump.trueCe(), step.trueCe, TOL_TRUE, where);
      await pump.idle();

      const exchanges = pump.snapshot().exchanges;
      assert.equal(exchanges.length, i + 1, `${where}: one request per step`);
      const x = exchanges[i];
      assert.equal(x.caseTimeSent, START + now * 1000, `${where}: request time`);
      assert.equal(x.request.now, step.now, `${where}: request now`);
      assert.equal(x.request.target.value, step.target, `${where}: request target`);
      assert.equal(x.status, 200, `${where}: status (${x.summary})`);
      const r = x.response;

      near(worst, "rate.value", r.rate.value, step.rate.value, TOL_RATE, where);
      assert.equal(r.rate.units, step.rate.units, where);
      near(worst, "rate.ideal", r.rate.ideal, step.rate.ideal, TOL_RATE, where, TOL_IDEAL_ABSOLUTE);
      assert.deepEqual(r.rate.limitedBy, step.rate.limitedBy, `${where}: limitedBy`);
      assert.equal(r.controller.plan, step.controller.plan, `${where}: plan`);
      assert.equal(r.controller.phase, step.controller.phase, `${where}: phase`);
      near(worst, "fallback.rate", r.fallback.rate, step.fallbackRate, TOL_RATE, where);
      for (const key of ["now", "effectiveAt", "holdUntil", "nextRequestAt"]) {
        assert.equal(r.timing[key], step.timing[key], `${where}: timing.${key}`);
      }
      assert.equal(r.timing.latency, step.timing.latency, where);
      assert.equal(r.timing.interval, step.timing.interval, where);
      near(worst, "state.now.cp", r.state.now.cp, step.stateNow.cp, TOL_STATE, where);
      near(worst, "state.now.ce", r.state.now.ce, step.stateNow.ce, TOL_STATE, where);
      near(worst, "state.holdUntil.cp", r.state.holdUntil.cp, step.stateHoldUntil.cp, TOL_STATE, where);
      near(worst, "state.holdUntil.ce", r.state.holdUntil.ce, step.stateHoldUntil.ce, TOL_STATE, where);
      near(worst, "prediction.peakCe", r.prediction.peakCe, step.prediction.peakCe, TOL_STATE, where);
      assert.equal(r.prediction.peakAt, step.prediction.peakAt, `${where}: peakAt`);
      assert.equal(r.prediction.onTarget, step.prediction.onTarget, `${where}: onTarget`);
      assert.deepEqual(r.warnings.map((w) => w.code), step.warnings, `${where}: warning codes`);

      // Samples at one-second offsets within [now, switch], then the switch.
      const n1 = Math.floor(aL + 1e-9);
      for (let k = 1; k <= n1; k++) sampleAt(now + k);
      tickAt(now + aL);
      assert.equal(x.outcome, "applied", `${where}: outcome (${x.summary})`);
      assert.equal(formatRfc3339(x.caseTimeApplied / 1000), step.pumpSwitchesAt, `${where}: switch time`);
      assert.equal(pump.snapshot().rate, step.rate.value, `${where}: the pump runs the commanded rate`);
      // Samples within [switch, next request).
      if (i + 1 < steps.length) {
        const n2 = Math.floor(spec.interval - aL + 1e-9);
        for (let k = 1; k <= n2; k++) sampleAt(now + aL + k);
      }
    }

    // The record the last request carried equals the simulator's, apart from
    // the initial infusate event the pump always records.
    const sent = pump.snapshot().exchanges[steps.length - 1].request.history;
    assert.deepEqual(sent[0], { time: closedLoop.start, infusate: spec.infusate });
    const recorded = sent.slice(1);
    assert.equal(recorded.length, trace.finalHistory.length, `${trace.name}: history length`);
    for (let j = 0; j < recorded.length; j++) {
      const a = recorded[j];
      const e = trace.finalHistory[j];
      assert.equal(a.time, e.time, `${trace.name}: history[${j}].time`);
      if (e.rate !== undefined) {
        assert.equal(a.units, e.units);
        assert.equal(a.source, e.source);
        near(worst, "history.rate", a.rate, e.rate, 1e-12, `${trace.name}: history[${j}]`);
      } else {
        assert.equal(a.bolus, e.bolus);
        assert.equal(a.units, e.units);
        assert.equal(a.source, e.source);
      }
    }

    // The maximum true Ce over the simulator's sample instants, and its time.
    near(worst, "maxTrueCe", maxCe, trace.maxTrueCe, TOL_TRUE, trace.name);
    assert.equal(maxCeAt, trace.maxTrueCeAtSeconds, `${trace.name}: time of the maximum true Ce`);
    // (The final true state is the last step's trueCp/trueCe, compared above.)

    // The pump's own running maximum (every tick) is at least the sampled
    // one and within the sampling slack of it.
    const snap = pump.snapshot();
    assert.ok(snap.maxTrueCe >= maxCe - 1e-12);
    near(worst, "pump.maxTrueCe (all ticks)", snap.maxTrueCe, trace.maxTrueCe, 1e-4, trace.name);
    assert.equal(snap.alarms.length, 0, `${trace.name}: no alarm`);
    assert.equal(snap.state, "running");
    diagnostics(t, worst);
  });
}
