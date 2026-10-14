// FauxTCI: the simulated TCI syringe pump and the controller that drives it.
//
// WHAT IT IS
// ==========
// FauxPump is a syringe pump and its TCI controller in one object, run by a
// simulated clock.  The controller forms the request body of
// docs/tci-api.md section 4 from its own delivery record and clock, sends it
// through a transport (js/transport.js: the in-page port of the API, or a
// real stanpumpR server), and applies the response under the safety contract
// of section 7: apply on arrival and never later, discard a response that is
// later than its holdUntil, apply only the latest request's response, run
// each command as a bounded segment (rate for holdSeconds, then the fallback
// for maxSeconds, then stop and alarm), treat any error or dropped response
// as no response, ask again at once on any local event, and stop at once
// when a lowered target is below the predicted peak.  The pump's physics is
// the seven-amplitude closed-form recurrence of tciSchedule()'s advance()
// (R/tci.R), through pk.js, advanced at the rates the pump actually ran.
//
// TWO STATES
// ==========
// The pump keeps two model states side by side.  The truth is advanced with
// the concentration really in the syringe; the belief with the concentration
// the controller was told, which is what the server reconstructs from the
// record.  They agree unless a teaching control (changeSyringe) makes the
// syringe lie, and their divergence is the lesson: the controller can only
// be as right as its record.  Ce of the truth is the solid line on the
// chart; Ce of the belief is the dashed one.
//
// THE PUMP DRIVER
// ===============
// The hardware is behind one object, the driver (js/driver.js): infuse(time,
// rate) commands a rate and reads back what the pump has done (the volume
// infused, the rate running, the syringe left, its state and alarms),
// loadSyringe() loads a new one, horizon() says when the pump will next
// change state by itself.  FauxPump never integrates the commanded rate: the
// truth is advanced with the mass the driver's totaliser says was delivered
// (rebased to the case, reset-proof), the record gets a rate change only
// when a reading shows it running (at the pump's acknowledgement, with the
// command's source when it answers one within the rate resolution), and an
// alarm the pump reports stops the controller, which commands 0 so the stop
// is real.  A driver that throws or answers with a Promise is a driver
// fault, raised as an alarm.  The page runs the SimulatedPump driver; a real
// pump plugs in by passing its own driver.
//
// TIME
// ====
// Everything is event-driven.  tick() (every 250 ms of real time in the app,
// or whenever a test chooses) brings the pump up to clock.now(): the pending
// events (a response that is due to take effect, a request that is due, the
// end of a hold, the end of a fallback, an emptying syringe) are processed
// in time order, with the physics advanced exactly to each one, so the
// result does not depend on how often tick() is called.  A request that
// fell due between two ticks is formed at its due time; a response from the
// in-page controller takes effect at sentAt + actualLatency, so the physics
// waits there until the asynchronous answer has arrived (the local transport
// resolves after a setTimeout of zero; the pump then continues by itself).
// All times inside are seconds since the epoch on the simulated clock.
//
// REQUEST CADENCE
// ===============
// The controller asks at min(timing.nextRequestAt, sentAt + interval), and
// never sooner than a second after the last request.  nextRequestAt is the
// LATEST time to ask (section 5.5); asking once every interval as well keeps
// the record fresh and is STANPUMP's ten-second loop, and it is the cadence
// of the stanpumpR simulator the fixtures were made with, which asks every
// interval whatever nextRequestAt says.  When nextRequestAt is earlier (a
// peak predicted within the hold) the pump honours it.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { resolveModel, advance, bolus, cp, ce, emptyState } from "./pk.js";
import { formatRfc3339, parseRfc3339, TCI_API } from "./tci.js";
import { makeTransport } from "./transport.js";
import { SimulatedPump } from "./driver.js";

/** The pump's defaults: the stanpumpR simulator's base pump (fixtures README). */
export const PUMP_DEFAULTS = Object.freeze({
  drug: "propofol",
  patient: Object.freeze({ weight: 70, height: 170, age: 50, sex: "male" }),
  syringe: Object.freeze({ concentration: 10, units: "mg/mL" }), // what the controller believes
  trueConcentration: null, // what is really in the syringe; null means as told
  syringeVolume: 50, // mL
  limits: Object.freeze({ maxRate: 1200, minRate: 0.1, rateResolution: 0.1 }), // mL/hr
  declaredLatency: 1.5, // s, what the request says (timing.latency)
  actualLatency: 1.5, // s, how long the simulated pump really takes to acknowledge
  interval: 10, // s, timing.interval
  target: Object.freeze({ site: "effect", value: 0 }),
  requestIdPrefix: "fauxtci",
  stopOnLoweredTarget: true, // section 7, rule 6: stop at once when the new target is below prediction.peakCe
  compaction: true, // merge segments older than 30 min into one-minute delivered segments (section 4.2)
  compactEverySeconds: 600,
  compactOlderThanSeconds: 1800,
  volumeInfusedUnits: "mass", // "mass": the pump's drug totaliser in the drug's mass unit; "mL"; or null to omit
  reportSyringeVolume: true, // send pump.syringeVolumeRemaining
  lookAhead: null, // lookAhead.concentration, in target units, or null
  adjustToFFM: null, // options.adjustToFFM, or null to omit the block
  fullExchanges: 200, // exchanges whose request and response bodies are kept in full
  maxSeriesPoints: 40000,
});

/**
 * Compaction splits its one-minute segments wherever the rate stepped by more
 * than this fraction of the larger of the two rates, so a loading infusion
 * or a target change keeps its exact timing while the maintenance staircase
 * (steps of a fraction of a percent) is merged.  Measured on a three-hour
 * propofol case: merging the loading minute whole moves the plan at 1 h by
 * 0.11 mL/hr (one resolution step); with this split the move is below a
 * thousandth of the resolution.
 */
export const COMPACTION_LARGE_STEP = 0.25;

/** The pump's words for controller.phase, for the pump face. */
export const PHASE_WORDS = Object.freeze({
  loading: "loading",
  waitingForPeak: "waiting for peak",
  maintenance: "maintenance",
  aboveTarget: "above target",
  stopped: "stopped",
});

const PLAN_WORDS = Object.freeze({ effectSite: "effect-site", plasma: "plasma hold", off: "off" });

// A hair of tolerance for "due" comparisons on times that are sums of
// decimals (an actual latency of 0.3 s is not exact in binary).
const EPS = 1e-9;

const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);

// The concentration of a syringe in the drug's base mass unit per mL: port
// of tciApiInfusateBase() in R/tci-api.R (concentration times the mass
// factor between the syringe's unit and the base unit).
function concentrationInBase(concentration, units, baseMass) {
  const mass = units.replace(/\/mL$/, "");
  const factor = mass === baseMass ? 1 : mass === "mg" ? 1000 : 1 / 1000;
  return concentration * factor;
}

// Fifteen significant digits, which is what the JSON carries (jsonlite's
// digits = NA and the fixtures' j15()): a rate is recorded as the wire would.
const j15 = (x) => (x === 0 ? 0 : Number(x.toPrecision(15)));

const fmt = (secs) => formatRfc3339(secs);

// HH:MM:SS(.f) in UTC, for the one-line summaries.
function clockText(input) {
  const secs = typeof input === "string" ? parseRfc3339(input) : input;
  if (!isFiniteNumber(secs)) return "?";
  const iso = formatRfc3339(secs);
  const hhmmss = iso.slice(11, 19);
  const ms = iso.slice(20, 23);
  if (ms === "000") return hhmmss;
  return `${hhmmss}.${ms.replace(/0+$/, "")}`;
}

function sig(x, digits = 4) {
  if (!isFiniteNumber(x)) return String(x);
  if (x === 0) return "0";
  return String(Number(x.toPrecision(digits)));
}

/**
 * The one-line reading of a 200 response, as the API conversation panel
 * shows it beneath the JSON (spec section 7a), from the response fields and
 * the request it answers.
 */
export function summarizeResponse(body, request) {
  const r = body.rate;
  const s = body.segment;
  const f = body.fallback;
  const c = body.controller;
  const st = body.state;
  const p = body.prediction;
  const tm = body.timing;
  const phase = PHASE_WORDS[c.phase] || c.phase;
  const plan = PLAN_WORDS[c.plan] || c.plan;
  const res = request && request.pump ? request.pump.rateResolution : null;
  const limits = (r.limitedBy || []).map((l) => {
    if (l === "maxRate") return "ceiling";
    if (l === "minRate") return "below the minimum rate, sent as 0";
    return res === null || res === undefined ? "rounded down" : `rounded down to ${res}`;
  });
  const ideal = `ideal ${sig(r.ideal, 6)}${limits.length ? "; " + limits.join(", ") : ""}`;
  const peak = p.peakCe === null || p.peakCe === undefined ? "" : `, peak ${sig(p.peakCe)} at ${clockText(p.peakAt)}`;
  let line;
  if (c.plan === "off") {
    line = `Pump off: target 0. Ce now ${sig(st.now.ce)}, at hold end ${sig(st.holdUntil.ce)}.`;
  } else if (r.value === 0) {
    const why = c.phase === "aboveTarget"
      ? `Ce ${sig(st.effectiveAt.ce)} is above target ${sig(body.target.value)}`
      : `${phase} (${ideal})`;
    line = `Pump off: ${why}; fallback ${sig(f.rate, 6)} ${f.units}. Ce now ${sig(st.now.ce)}, at hold end ${sig(st.holdUntil.ce)}${peak}.`;
  } else {
    line = `Run ${sig(r.value, 6)} ${r.units} for ${s.holdSeconds} s (${ideal}), then fall back to ${sig(f.rate, 6)} ${f.units}. ` +
      `Plan: ${plan}, ${phase}. Ce now ${sig(st.now.ce)}, at hold end ${sig(st.holdUntil.ce)}${peak}.`;
  }
  line += ` Next request at ${clockText(tm.nextRequestAt)}.`;
  if (body.warnings && body.warnings.length) {
    line += ` Warnings: ${body.warnings.map((w) => `${w.code} (${w.message})`).join("; ")}`;
  }
  return line;
}

/**
 * The one-line reading of an error body (section 6.3) or of a transport
 * failure, for the API conversation panel.
 */
export function summarizeError(status, body, error) {
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const e = body.errors[0];
    return `${status} ${e.code}${e.pointer ? ` at ${e.pointer}` : ""}: ${e.message}`;
  }
  if (status === 0 || status === null || status === undefined) return `No response${error ? ` (${error})` : ""}.`;
  return `HTTP ${status} without an API error body${error ? ` (${error})` : ""}: treated as no response.`;
}

/**
 * A simulated TCI syringe pump with its controller.  `options` are the
 * PUMP_DEFAULTS fields plus `clock` ({ now(): milliseconds since the epoch
 * on the simulated clock }, default the real clock) and `transport` (from
 * makeTransport(), default the in-page controller).  Call start(), then
 * setTarget(), and tick() regularly; snapshot() has everything the page
 * shows.  Nothing here touches the DOM.
 */
export class FauxPump {
  constructor(options = {}) {
    const o = { ...PUMP_DEFAULTS, ...options };
    this.clock = options.clock || { now: () => Date.now() };
    this.transport = options.transport || makeTransport({ mode: "local" });

    // The drug and the model (resolveModel() throws for an unknown drug or
    // a covariate out of the API's range).
    this.drug = o.drug;
    this.patient = { ...o.patient };
    this.model = resolveModel({ drug: this.drug, ...this.patient, adjustToFFM: o.adjustToFFM !== false });
    this.massUnits = this.model.massUnits; // mg or mcg
    this.concentrationUnits = this.model.concentrationUnits; // mcg/mL or ng/mL

    // The syringe, as told and as it is.
    if (!TCI_API.INFUSATE_UNITS.includes(o.syringe.units)) {
      throw new Error(`syringe.units must be one of ${TCI_API.INFUSATE_UNITS.join(", ")}`);
    }
    if (!isFiniteNumber(o.syringe.concentration) || o.syringe.concentration < TCI_API.MIN_INFUSATE) {
      throw new Error(`syringe.concentration must be at least ${TCI_API.MIN_INFUSATE} ${o.syringe.units}`);
    }
    this.syringe = { concentration: o.syringe.concentration, units: o.syringe.units };
    this.trueConcentration = o.trueConcentration === null || o.trueConcentration === undefined
      ? o.syringe.concentration : o.trueConcentration;
    if (!isFiniteNumber(this.trueConcentration) || this.trueConcentration <= 0) {
      throw new Error("trueConcentration must be a positive number");
    }
    this.syringeVolume = o.syringeVolume;
    this.syringeRemaining = o.syringeVolume;
    this._recomputeConcentrations();

    // The pump itself, behind the driver interface (js/driver.js).
    this.driver = options.driver || new SimulatedPump({
      syringeVolume: o.syringeVolume,
      concentration: this.trueConcBase,
      massUnits: this.massUnits,
    });
    this._commanded = null; // { value, source }: a rate commanded that no reading has yet shown running
    this._lastReading = null;
    this._raisedAlarms = new Set(); // "kind@at" of the driver alarms already raised once (a later raise says "(still)")
    this._standingAlarms = new Set(); // the alarm kinds raised and not yet cleared by the user or the pump
    this._seenNotices = new Set(); // "kind@at" of the driver notices already noted
    this._totals = { volume: { last: null, offset: 0 }, mass: { last: null, offset: 0 } }; // the pump's raw totalisers, rebased to the case
    this._volumeAtLoad = 0; // this.volumeInfused when the syringe was last loaded
    this._pumpPaused = false; // the pump paused itself (reading.state "paused")
    this._massUnitsWarned = false;

    // The pump's limits and timing.
    this.rateUnits = "mL/hr";
    this.limits = { ...o.limits };
    if (!isFiniteNumber(this.limits.maxRate) || this.limits.maxRate <= 0) throw new Error("limits.maxRate must be > 0");
    if (!isFiniteNumber(o.declaredLatency) || o.declaredLatency < 0) throw new Error("declaredLatency must be >= 0");
    if (!isFiniteNumber(o.actualLatency) || o.actualLatency < 0) throw new Error("actualLatency must be >= 0");
    if (!isFiniteNumber(o.interval) || o.interval < TCI_API.MIN_INTERVAL || o.interval > TCI_API.MAX_INTERVAL) {
      throw new Error(`interval must be between ${TCI_API.MIN_INTERVAL} and ${TCI_API.MAX_INTERVAL} s`);
    }
    if (o.declaredLatency >= o.interval) throw new Error("declaredLatency must be less than interval (LATENCY_INVALID)");
    this.declaredLatency = o.declaredLatency;
    this.actualLatency = o.actualLatency;
    this.interval = o.interval;

    // Options.
    this.requestIdPrefix = o.requestIdPrefix;
    this.stopOnLoweredTarget = o.stopOnLoweredTarget;
    this.compaction = o.compaction;
    this.compactEverySeconds = o.compactEverySeconds;
    this.compactOlderThanSeconds = o.compactOlderThanSeconds;
    this.volumeInfusedUnits = o.volumeInfusedUnits;
    this.reportSyringeVolume = o.reportSyringeVolume;
    this.lookAhead = o.lookAhead;
    this.adjustToFFM = o.adjustToFFM;
    this.fullExchanges = o.fullExchanges;
    this.maxSeriesPoints = o.maxSeriesPoints;

    // The target.
    this.target = { site: "effect", value: 0 };
    this._setTargetValue(o.target.value, o.target.site);

    // Pump state.
    this.started = false;
    this.caseStart = null; // s
    this.t = null; // s, the time the physics has been advanced to
    this.state = "standby"; // standby | running | paused | alarm
    this.alarmKind = null; // null | "fallbackExpired" | a kind the driver reports ("syringeEmpty", ...)
    this.alarms = []; // { time, message }
    this.notes = []; // { time, message }: the pump's own log for the page
    this.rate = 0; // mL/hr running
    this.segment = null; // { rate, startsAt, holdUntil, fallbackRate, fallbackUntil, phase, responseNextRequestAt, requestId }
    this.truth = emptyState();
    this.belief = emptyState();
    this.volumeInfused = 0; // mL through the pump
    this.trueMassInfused = 0; // base units, truly delivered by the pump
    this.history = []; // the API event objects the next request carries (compacted)
    this.record = []; // the full record, never compacted
    this.compactedUntil = null;
    this.lastCompactionAt = null;
    this.stoppedForTarget = false;

    // The controller.
    this.requestCounter = 0;
    this.lastSentAt = null;
    this.nextRequestAt = null;
    this.inFlight = null;
    this.dropNext = false;
    this.lastRequest = null;
    this.lastResponse = null;
    this.lastResponseAt = null;
    this.lastStatus = null;
    this.exchanges = [];
    this.backgroundGaps = [];

    // The chart series.
    this.series = [];
    this.lastSampleAt = -Infinity;
    this.maxTrueCe = 0;
    this.maxTrueCeAt = null;

    this._running = false;
    this._suspended = false;
    this._pending = 0;
    this._idleResolvers = [];
    this._exchangeListeners = [];
  }

  // -------------------------------------------------------------------------
  // Small helpers

  _now() {
    return this.clock.now() / 1000;
  }

  _recomputeConcentrations() {
    this.toldConcBase = concentrationInBase(this.syringe.concentration, this.syringe.units, this.massUnits);
    this.trueConcBase = concentrationInBase(this.trueConcentration, this.syringe.units, this.massUnits);
  }

  _setTargetValue(value, site) {
    if (!isFiniteNumber(value) || value < 0) throw new Error("target value must be a finite number >= 0");
    const s = site === undefined || site === null ? this.target.site : site;
    if (s !== "effect" && s !== "plasma") throw new Error('target site must be "effect" or "plasma"');
    this.target = { site: s, value };
  }

  _apiState() {
    if (this.state === "alarm") return this.alarmKind === "syringeEmpty" || this.alarmKind === "occlusion" ? this.alarmKind : "alarm";
    if (this.state === "running" && this._lastReading && this._lastReading.state === "stopped") return "standby";
    return this.state;
  }

  _controllerActive() {
    return !this._suspended && (this.state === "running" || this.state === "paused");
  }

  _note(time, message) {
    this.notes.push({ time, message });
    if (this.notes.length > 500) this.notes.splice(0, this.notes.length - 500);
  }

  // The base-unit-per-minute rate for a pump rate (mL/hr), as tciApiToBase()
  // computes it: value * (concBase / 60).
  _baseRate(rate, concBase) {
    return rate * (concBase / 60);
  }

  /** True plasma concentration at the physics time (target units). */
  trueCp() { return cp(this.truth); }

  /** True effect-site concentration at the physics time (target units). */
  trueCe() { return ce(this.truth); }

  /** The controller's own prediction of the plasma concentration (the belief state). */
  predictedCp() { return cp(this.belief); }

  /** The controller's own prediction of the effect-site concentration (the belief state). */
  predictedCe() { return ce(this.belief); }

  /** Seconds since the epoch to which the physics has been advanced, or null before start(). */
  time() { return this.t; }

  /** A promise that resolves once no transport call is outstanding. */
  idle() {
    if (this._pending === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleResolvers.push(resolve));
  }

  _resolveIdle() {
    if (this._pending === 0) {
      const waiters = this._idleResolvers;
      this._idleResolvers = [];
      for (const w of waiters) w();
    }
  }

  // -------------------------------------------------------------------------
  // The record

  // Append an event to the compacted history and the full record.  A rate
  // change or an infusate change at the same instant as the last one of its
  // kind replaces it (two at one instant are HISTORY_INVALID: the order of two
  // objects in an array is not evidence of which came later).
  _pushEvent(event) {
    this._pushInto(this.history, event);
    this._pushInto(this.record, cloneEvent(event));
  }

  _pushInto(list, event) {
    const key = event.rate !== undefined ? "rate" : event.infusate !== undefined ? "infusate" : null;
    if (key !== null) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        const when = e.time !== undefined ? e.time : e.to;
        if (when < event.time) break;
        if (when === event.time && e[key] !== undefined && e.time !== undefined) {
          list[i] = event;
          return;
        }
      }
    }
    list.push(event);
  }

  // The rate before the last rate change in a list (0 when there is none).
  _rateBeforeLast(list) {
    let seen = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].rate === undefined) continue;
      if (!seen) { seen = true; continue; }
      return list[i].rate;
    }
    return 0;
  }

  _removeLastRateEvent(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].rate !== undefined) { list.splice(i, 1); return; }
    }
  }

  // Command the driver to run `value` mL/hr from `time` (the physics has been
  // advanced to `time`), and record whatever the reading shows running.  A
  // pump that acknowledges later is recorded when a later reading shows the
  // rate running, at that reading's acknowledgedAt.  The value is rounded to
  // 15 significant digits first, as the JSON carries it, so the record and
  // the pump agree with the wire.
  _setRate(time, value, source) {
    this._commanded = { value: j15(value), source };
    const reading = this._driverCall(() => this.driver.infuse(time, value), time);
    if (!reading) return;
    this._absorbTotals(reading, time);
    this._absorbEvents(reading, time);
  }

  // Write a rate change into the history and the record at `time`.
  _recordRate(time, value, source) {
    const v = j15(value);
    if (v === this.rate) return false;
    const stamp = fmt(time);
    const last = lastRateEvent(this.history);
    if (last && last.time === stamp) {
      // A second change at the same instant: the later value wins; if it
      // restores the rate before the first, the instant saw no change at all.
      if (v === this._rateBeforeLast(this.history)) {
        this._removeLastRateEvent(this.history);
        this._removeLastRateEvent(this.record);
      } else {
        last.rate = v;
        last.source = source;
        const lastRecord = lastRateEvent(this.record);
        if (lastRecord && lastRecord.time === stamp) { lastRecord.rate = v; lastRecord.source = source; }
      }
    } else {
      this._pushEvent({ time: stamp, rate: v, units: this.rateUnits, source });
    }
    this.rate = v;
    this._sample(true);
    return true;
  }

  // Every call into the driver goes through here.  The contract (js/driver.js)
  // is that the methods return a reading at once and never throw; a method
  // that throws, or returns a Promise or no reading, is a driver fault,
  // raised as an alarm.  Returns the reading, or null on a fault.
  _driverCall(call, now) {
    let reading;
    try {
      reading = call();
    } catch (e) {
      this._driverFault(now, `the driver threw: ${e && e.message ? e.message : e}`);
      return null;
    }
    if (!reading || typeof reading !== "object") {
      this._driverFault(now, "the driver returned no reading");
      return null;
    }
    if (typeof reading.then === "function") {
      this._driverFault(now, "the driver returned a Promise: infuse() and loadSyringe() must return a reading at once");
      return null;
    }
    this._standingAlarms.delete("driverFault"); // the link is back; a later fault is raised again
    return reading;
  }

  _driverFault(now, message) {
    if (this._standingAlarms.has("driverFault")) return;
    this._standingAlarms.add("driverFault");
    this._commanded = null;
    this.segment = null;
    this._alarm(now, "driverFault", message);
  }

  // Tell the driver the syringe in the pump: at start() and on every change.
  _loadDriverSyringe(now) {
    const reading = this._driverCall(() => this.driver.loadSyringe(now, {
      volume: this.syringeVolume, concentration: this.trueConcBase, units: this.massUnits, drug: this.drug,
    }), now);
    if (reading) {
      this._absorbTotals(reading, now);
      if (this.started) this._absorbEvents(reading, now);
    }
    // The syringe just loaded is full; the volume since the load counts from here.
    this._volumeAtLoad = this.volumeInfused;
    if (!reading || !isFiniteNumber(reading.syringeRemaining)) this.syringeRemaining = this.syringeVolume;
  }

  // -------------------------------------------------------------------------
  // The physics: the seven-amplitude recurrence, the truth at the mass the
  // pump delivered, the belief at the rate the controller commanded

  _advancePhysics(to) {
    const dt = to - this.t;
    if (dt <= 0) return;
    const dtMin = dt / 60;
    const reading = this._driverCall(() => this.driver.infuse(to, null), to);
    // With no reading the delivery is unknown: nothing is credited to the
    // patient for this step, and the totaliser's next reading brings in all
    // that was delivered meanwhile.
    const massDelivered = reading ? this._absorbTotals(reading, to) : 0;
    this.truth = advance(this.truth, dtMin, massDelivered / dtMin, this.model);
    this.belief = advance(this.belief, dtMin, this._baseRate(this.rate, this.toldConcBase), this.model);
    this.t = to;
    if (to - this.lastSampleAt >= 1 - EPS) this._sample(false);
    if (reading) this._absorbEvents(reading, to);
  }

  // A driver event fell due at the physics time: read the pump without advancing.
  _pollDriver(now) {
    const reading = this._driverCall(() => this.driver.infuse(now, null), now);
    if (!reading) return;
    this._absorbTotals(reading, now);
    this._absorbEvents(reading, now);
  }

  // The reading's totalisers: the volume and mass through the pump, rebased
  // to the case (_rebase), and the syringe left (derived from the volume
  // since the load when the pump cannot tell).  Returns the mass delivered
  // since the previous reading, in base units (through the true
  // concentration when the pump has no drug totaliser).
  _absorbTotals(reading, now) {
    this._lastReading = reading;
    const prevMass = this.trueMassInfused;
    const prevVolume = this.volumeInfused;
    if (isFiniteNumber(reading.volumeInfused)) {
      this.volumeInfused = this._rebase("volume", reading.volumeInfused, prevVolume, now, "mL");
    }
    const factor = this._massFactor(reading.massUnits, now);
    if (isFiniteNumber(reading.massInfused) && factor !== null) {
      this.trueMassInfused = this._rebase("mass", reading.massInfused * factor, prevMass, now, this.massUnits);
    } else {
      // No drug totaliser: the volume through the true concentration.  A
      // totaliser that appears later counts on from here.
      this.trueMassInfused = prevMass + (this.volumeInfused - prevVolume) * this.trueConcBase;
      this._totals.mass.last = null;
    }
    if (isFiniteNumber(reading.syringeRemaining)) this.syringeRemaining = reading.syringeRemaining;
    else this.syringeRemaining = Math.max(0, this.syringeVolume - (this.volumeInfused - this._volumeAtLoad));
    return this.trueMassInfused - prevMass;
  }

  // A pump totaliser rebased to the case: the first reading counts as the
  // controller's current total (0 at the start, whatever the pump's counter
  // says), and a decrease is a reset, after which the new count adds to
  // what was counted before.
  _rebase(which, value, current, now, units) {
    const t = this._totals[which];
    if (t.last === null) {
      t.offset = current - value;
    } else if (value < t.last - 1e-9) {
      t.offset += t.last;
      this._note(now, `the pump's ${which} totaliser went from ${sig(t.last, 6)} to ${sig(value, 6)} ${units}: taken as a reset, counting on from ${sig(current, 6)}`);
    }
    t.last = value;
    return value + t.offset;
  }

  // The factor that takes the reading's massInfused into the drug's unit, or
  // null for a unit the controller does not know (the volume is used then).
  _massFactor(units, now) {
    if (units === null || units === undefined || units === this.massUnits) return 1;
    if (units === "mg" && this.massUnits === "mcg") return 1000;
    if (units === "mcg" && this.massUnits === "mg") return 0.001;
    if (!this._massUnitsWarned) {
      this._massUnitsWarned = true;
      this._note(now, `the pump reports massInfused in ${JSON.stringify(units)}, which is not mg or mcg: using its volume totaliser instead`);
    }
    return null;
  }

  // An event time from the pump, clamped to the case: not before the case
  // started or the last event already recorded (the record stays
  // chronological, which the same-instant rules of _pushInto assume), and
  // not after now.
  _clampEventTime(at, now) {
    if (!isFiniteNumber(at)) return now;
    return Math.min(Math.max(at, this.caseStart, this._lastEventTime()), now);
  }

  _lastEventTime() {
    const e = this.record.length ? this.record[this.record.length - 1] : null;
    if (!e) return this.caseStart;
    const t = parseRfc3339(e.time !== undefined ? e.time : e.to);
    return t === null ? this.caseStart : t;
  }

  // The reading's events.  A notice is noted once.  An alarm the controller
  // has not raised (or has raised and the user has cleared) stops the
  // controller: it commands rate 0 so that the stop is real, records the 0
  // at the alarm's own time when the pump had stopped itself (at the stop
  // command when it was still running), drops its segment and raises the
  // alarm.  A rate running that differs from the record is recorded, as the
  // command it answers (within the pump's rate resolution) or, unasked, as
  // the pump's own doing.  A pump that pauses itself pauses the controller.
  _absorbEvents(reading, now) {
    for (const n of reading.notices || []) {
      if (!n || typeof n.kind !== "string") continue;
      const key = `${n.kind}@${isFiniteNumber(n.at) ? n.at : "?"}`;
      if (this._seenNotices.has(key)) continue;
      this._seenNotices.add(key);
      this._note(this._clampEventTime(n.at, now), `the pump reports: ${n.message || n.kind}`);
    }
    let r = reading;
    const alarms = (r.alarms || []).filter((a) => a && typeof a.kind === "string");
    const fresh = alarms.filter((a) => !this._standingAlarms.has(a.kind));
    if (fresh.length) {
      // The stop is made real: command 0, and read what the pump did with it.
      const wasRunning = j15(isFiniteNumber(r.rate) ? r.rate : 0) !== 0;
      if (wasRunning || this.rate !== 0 || this._commanded) {
        const stopped = this._driverCall(() => this.driver.infuse(now, 0), now);
        if (stopped) {
          this._absorbTotals(stopped, now);
          r = stopped;
        }
      }
      this._commanded = null;
      this.segment = null;
      const stoppedRate = j15(isFiniteNumber(r.rate) ? r.rate : 0);
      for (const a of fresh) {
        const key = `${a.kind}@${isFiniteNumber(a.at) ? a.at : "?"}`;
        const first = !this._raisedAlarms.has(key);
        this._raisedAlarms.add(key);
        this._standingAlarms.add(a.kind);
        // A pump that stopped itself is recorded at the alarm's own time; one
        // the controller had to stop, at the stop.
        const at = first && !wasRunning ? this._clampEventTime(a.at, now) : now;
        if (this.rate !== 0 && stoppedRate === 0) this._recordRate(at, 0, "pump");
        this._alarm(at, a.kind, first ? (a.message || a.kind) : `${a.message || a.kind} (still)`);
      }
      // The kind the API names is the one the request's pump.state carries.
      const named = fresh.find((a) => a.kind === "syringeEmpty" || a.kind === "occlusion");
      if (named) this.alarmKind = named.kind;
    }
    // A kind the pump no longer reports has cleared on the pump.
    for (const kind of [...this._standingAlarms]) {
      if (kind !== "driverFault" && !alarms.some((a) => a.kind === kind)) this._standingAlarms.delete(kind);
    }
    const running = j15(isFiniteNumber(r.rate) ? r.rate : this.rate);
    const c = this._commanded;
    const answers = c !== null && Math.abs(c.value - running) <= this._rateTolerance(c.value);
    if (running !== this.rate) {
      const at = this._clampEventTime(r.acknowledgedAt, now);
      if (answers) {
        this._recordRate(at, running, c.source);
        this._commanded = null;
      } else {
        this._recordRate(at, running, "pump");
        this._note(at, `the pump reports ${sig(running, 6)} mL/hr running, which the controller did not command`);
      }
    } else if (answers) {
      this._commanded = null;
    }
    this._absorbState(r, now);
  }

  // The tolerance within which the pump's running rate answers a command:
  // the pump's rate resolution or 1e-6 relative, the contract's
  // RATE_MISMATCH tolerance.
  _rateTolerance(value) {
    const res = isFiniteNumber(this.limits.rateResolution) ? this.limits.rateResolution : 0;
    return Math.max(res, 1e-6 * Math.abs(value)) + 1e-12;
  }

  // A pump paused from its own panel pauses the controller (the plan is
  // noted, not run, as pause() has it); when the pump runs again the
  // controller resumes and asks at once.
  _absorbState(reading, now) {
    if (reading.state === "paused" && this.state === "running") {
      this._pumpPaused = true;
      this.state = "paused";
      this.segment = null;
      this._commanded = null;
      this._note(now, "the pump reports itself paused: the plan is noted, not run");
    } else if (this._pumpPaused && reading.state !== "paused" && this.state === "paused") {
      this._pumpPaused = false;
      this.state = "running";
      this._note(now, "the pump reports itself running again: asking at once");
      if (this.target.value > 0) this.nextRequestAt = this.lastSentAt === null ? now : Math.max(now, this.lastSentAt + 1);
    }
  }

  _sample(force) {
    if (this.t === null) return;
    const point = {
      time: this.t - this.caseStart, // seconds of case time
      trueCp: cp(this.truth),
      trueCe: ce(this.truth),
      predictedCp: cp(this.belief),
      predictedCe: ce(this.belief),
      rate: this.rate,
      target: this.target.value,
      state: this.state,
    };
    const last = this.series.length ? this.series[this.series.length - 1] : null;
    if (last && Math.abs(last.time - point.time) < EPS) {
      if (force) this.series[this.series.length - 1] = point;
    } else {
      this.series.push(point);
    }
    this.lastSampleAt = this.t;
    if (point.trueCe > this.maxTrueCe) {
      this.maxTrueCe = point.trueCe;
      this.maxTrueCeAt = this.t;
    }
    if (this.series.length > this.maxSeriesPoints) {
      // Thin the older half to every other point; the chart cannot show them anyway.
      const half = Math.floor(this.series.length / 2);
      const kept = [];
      for (let i = 0; i < half; i += 2) kept.push(this.series[i]);
      this.series = kept.concat(this.series.slice(half));
    }
  }

  // -------------------------------------------------------------------------
  // The event loop

  /** Bring the pump up to clock.now(): process every due event in time order and advance the physics. */
  tick() {
    if (!this.started) return;
    this._run(this._now());
  }

  _run(now, holdRequestsAt = Infinity) {
    if (!this.started || this._running) return;
    if (now < this.t) now = this.t; // a clock that steps back reads as standing still
    this._running = true;
    try {
      let waiting = false;
      for (let guard = 0; guard < 1e6; guard++) {
        const ev = this._nextEvent(now, holdRequestsAt);
        if (!ev) break;
        this._advancePhysics(ev.time);
        if (ev.kind === "wait") { waiting = true; break; }
        this._process(ev);
      }
      if (!waiting) this._advancePhysics(now);
    } finally {
      this._running = false;
    }
  }

  // The earliest event due at or before `now`.  At one instant: a response
  // taking effect, then a request falling due, then the end of a hold, the
  // end of a fallback and the emptying of the syringe, so that a command
  // landing exactly as a hold ends supersedes the fallback, as the fixtures'
  // simulator has it.
  _nextEvent(now, holdRequestsAt) {
    let best = null;
    const consider = (time, kind, priority) => {
      if (!(time <= now + EPS)) return;
      if (best === null || time < best.time - EPS || (Math.abs(time - best.time) <= EPS && priority < best.priority)) {
        best = { time, kind, priority };
      }
    };
    const f = this.inFlight;
    if (f && f.applyAt !== null) {
      if (f.result) consider(f.applyAt, "apply", 0);
      else if (this.transport.mode === "local") consider(f.applyAt, "wait", 0);
    }
    if (this.nextRequestAt !== null && this._controllerActive() && this.nextRequestAt < holdRequestsAt - EPS) {
      consider(this.nextRequestAt, "request", 1);
    }
    const s = this.segment;
    if (s) {
      if (s.phase === "hold") consider(s.holdUntil, "holdEnd", 2);
      else if (s.phase === "fallback") consider(s.fallbackUntil, "fallbackEnd", 3);
    }
    // The driver's own next event, only when it is ahead of the physics: a
    // time at or before this.t has been covered by the reading that brought
    // the physics there, and treating it as due would poll for ever.
    let h = null;
    try { h = this.driver.horizon(this.t); } catch (e) { h = null; }
    if (isFiniteNumber(h) && h > this.t + EPS) consider(h, "driver", 4);
    return best;
  }

  _process(ev) {
    switch (ev.kind) {
      case "apply": this._applyResponse(this.inFlight, ev.time); break;
      case "request":
        // The physics on the way here may have put the pump in alarm.
        if (this._controllerActive()) this._sendRequest(ev.time); else this.nextRequestAt = null;
        break;
      case "holdEnd": this._holdEnded(ev.time); break;
      case "fallbackEnd": this._fallbackEnded(ev.time); break;
      case "driver": this._pollDriver(ev.time); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // The request (section 4)

  _formRequest(now) {
    this.requestCounter += 1;
    const body = {
      requestId: `${this.requestIdPrefix}-${String(this.requestCounter).padStart(6, "0")}`,
      drug: this.drug,
      now: fmt(now),
      patient: { ...this.patient },
      infusate: { concentration: this.syringe.concentration, units: this.syringe.units },
      pump: {
        rateUnits: this.rateUnits,
        maxRate: this.limits.maxRate,
      },
      target: { site: this.target.site, value: this.target.value, units: this.concentrationUnits },
      timing: { latency: this.declaredLatency, interval: this.interval },
      history: this.history.map(cloneEvent),
    };
    if (isFiniteNumber(this.limits.minRate)) body.pump.minRate = this.limits.minRate;
    if (isFiniteNumber(this.limits.rateResolution)) body.pump.rateResolution = this.limits.rateResolution;
    body.pump.currentRate = this.rate;
    body.pump.state = this._apiState();
    if (this.volumeInfusedUnits === "mass") {
      body.pump.volumeInfused = { value: this.trueMassInfused, units: this.massUnits };
    } else if (this.volumeInfusedUnits === "mL") {
      body.pump.volumeInfused = { value: this.volumeInfused, units: "mL" };
    }
    if (this.reportSyringeVolume) {
      body.pump.syringeVolumeRemaining = { value: this.syringeRemaining, units: "mL" };
    }
    if (isFiniteNumber(this.lookAhead) && this.lookAhead > 0) body.lookAhead = { concentration: this.lookAhead };
    if (typeof this.adjustToFFM === "boolean") body.options = { adjustToFFM: this.adjustToFFM };
    return body;
  }

  _sendRequest(now) {
    if (this.compaction && now - this.lastCompactionAt >= this.compactEverySeconds - EPS) {
      this._compactHistory(now);
      this.lastCompactionAt = now;
    }
    const body = this._formRequest(now);
    const exchange = {
      id: body.requestId,
      caseTimeSent: now * 1000,
      path: `POST /tci/v1/drugs/${this.drug}/rate`,
      request: body,
      status: null,
      response: null,
      caseTimeReceived: null,
      caseTimeApplied: null,
      outcome: "pending",
      summary: "request sent; waiting for the response",
      roundTripMs: null,
      declaredLatency: this.declaredLatency,
      actualLatency: this.actualLatency,
    };
    // Rule 6 / rule 3: an outstanding response is stale once a newer request is out.
    if (this.inFlight && this.inFlight.exchange.outcome === "pending") {
      this._setOutcome(this.inFlight.exchange, "superseded", "superseded by a newer request before it took effect");
    }
    this._addExchange(exchange);
    const flight = {
      exchange,
      sentAt: now,
      applyAt: this.transport.mode === "local" ? now + this.actualLatency : null,
      result: null,
      arrivedAt: null,
      dropped: false,
    };
    this.inFlight = flight;
    this.lastSentAt = now;
    this.lastRequest = body;
    // Provisional: the cadence if no response comes (rule 5: a new request
    // with the current now and history, never faster than once a second).
    this.nextRequestAt = now + Math.max(1, this.interval);
    this._pending += 1;
    let promise;
    try {
      promise = Promise.resolve(this.transport.send(this.drug, body, { receivedAt: now * 1000 }));
    } catch (e) {
      promise = Promise.resolve({ status: 0, body: null, error: `transport: ${e && e.message ? e.message : e}` });
    }
    promise.then(
      (result) => this._onResult(flight, result || { status: 0, body: null, error: "empty result" }),
      (err) => this._onResult(flight, { status: 0, body: null, error: `transport: ${err && err.message ? err.message : err}` }),
    );
  }

  _onResult(flight, result) {
    this._pending -= 1;
    const arrivedAt = Math.max(this._now(), this.t);
    flight.result = result;
    flight.arrivedAt = arrivedAt;
    const x = flight.exchange;
    x.status = result.status;
    x.response = result.body;
    // For the in-page controller the answer is defined to be there by
    // applyAt (the physics waits for it), so the card never shows it
    // received after it was applied; over HTTP the real arrival stands.
    x.caseTimeReceived = (flight.applyAt !== null ? Math.min(arrivedAt, flight.applyAt) : arrivedAt) * 1000;
    x.roundTripMs = result.roundTripMs === undefined ? null : result.roundTripMs;
    if (this.dropNext) {
      flight.dropped = true;
      this.dropNext = false;
    }
    if (flight.applyAt === null) {
      // Over HTTP the response takes effect when it arrives, and no sooner
      // than the pump's own acknowledgement time.
      flight.applyAt = Math.max(arrivedAt, flight.sentAt + this.actualLatency);
    }
    if (x.outcome === "superseded" && result.status !== 200) {
      x.summary = `${summarizeError(result.status, result.body, result.error)} (already superseded)`;
      this._notifyExchange(x);
    } else if (x.outcome === "superseded") {
      this._notifyExchange(x);
    } else if (x.outcome === "no-response") {
      // Marked while the controller was suspended; the answer came too late to matter.
      x.summary = `${x.summary}; the answer (${result.status}) arrived after the controller woke and was not applied`;
      this._notifyExchange(x);
    }
    this._resolveIdle();
    this._run(this._now());
  }

  // Rule 1: the response must answer this request.
  _mismatch(request, body) {
    if (!body || typeof body !== "object") return "no body";
    if (typeof body.apiVersion !== "string" || !body.apiVersion.startsWith("1.")) return "apiVersion";
    if (body.requestId !== request.requestId) return "requestId";
    if (body.drug !== request.drug) return "drug";
    if (!body.target || body.target.site !== request.target.site || body.target.value !== request.target.value ||
      body.target.units !== request.target.units) return "target";
    if (!body.rate || body.rate.units !== request.pump.rateUnits) return "rate.units";
    if (!body.timing || body.timing.now !== request.now) return "timing.now";
    return null;
  }

  _applyResponse(flight, at) {
    this.inFlight = null;
    const x = flight.exchange;
    const res = flight.result;
    const seg = this.segment;
    if (flight.dropped) {
      // What the pump does instead depends on where its segment stands.
      let tail;
      if (seg && seg.phase === "hold") {
        tail = ` it runs its segment to ${clockText(seg.holdUntil)}, then the fallback ${sig(seg.fallbackRate, 6)} mL/hr`;
      } else if (seg && seg.phase === "fallback") {
        tail = ` the fallback ${sig(seg.fallbackRate, 6)} mL/hr runs to ${clockText(seg.fallbackUntil)}, then the pump stops and alarms`;
      } else {
        tail = " the pump had no command running";
      }
      this._setOutcome(x, "dropped", `dropped by the teaching control: the pump saw no response;${tail}`);
      this._note(at, `response ${x.id} dropped (teaching control)`);
      return;
    }
    if (res.status !== 200 || !res.body || res.body.errors) {
      const outcome = res.status === 0 || res.status === null || res.status === undefined ? "no-response" : "error";
      this._setOutcome(x, outcome, summarizeError(res.status, res.body, res.error));
      this._note(at, `${x.id}: ${x.summary}`);
      return;
    }
    const body = res.body;
    const bad = this._mismatch(x.request, body);
    if (bad !== null) {
      this._setOutcome(x, "error", `discarded: the response's ${bad} does not match the request (section 7, rule 1)`);
      this._note(at, `${x.id}: ${x.summary}`);
      return;
    }
    // Rule 2: late past holdUntil is discarded, and the controller asks again.
    const holdUntil = parseRfc3339(body.timing.holdUntil);
    if (holdUntil !== null && at > holdUntil + EPS) {
      this._setOutcome(x, "late-discarded",
        `arrived at ${clockText(at)}, after its holdUntil ${clockText(holdUntil)}: discarded, asking again`);
      this._note(at, `${x.id}: ${x.summary}`);
      if (this._controllerActive()) this.nextRequestAt = Math.max(at, this.lastSentAt + 1);
      return;
    }
    // Accepted.
    this.lastResponse = body;
    this.lastResponseAt = at;
    this.lastStatus = res.status;
    const sentAt = flight.sentAt;
    const respNext = parseRfc3339(body.timing.nextRequestAt);
    const cadence = sentAt + this.interval;
    const nextRequestAt = Math.max(sentAt + 1, respNext === null ? cadence : Math.min(respNext, cadence));
    const summary = summarizeResponse(body, x.request);
    if (this.state === "running") {
      this.stoppedForTarget = false;
      this.nextRequestAt = nextRequestAt;
      this._setRate(at, body.rate.value, "tci");
      if (this.state !== "running") {
        // The command's own reading raised an alarm or showed the pump
        // paused: the plan is not run and no segment is installed.
        x.caseTimeApplied = at * 1000;
        this._setOutcome(x, "refused", `the pump reported ${this.state === "alarm" ? this.alarmKind : this.state} when commanded: ${summary} not run`);
        return;
      }
      this.segment = {
        rate: j15(body.rate.value), // the commanded rate; this.rate is what the pump has acknowledged
        startsAt: at,
        holdUntil: at + body.segment.holdSeconds,
        fallbackRate: body.fallback.rate,
        fallbackUntil: at + body.segment.holdSeconds + body.fallback.maxSeconds,
        phase: "hold",
        responseNextRequestAt: respNext,
        requestId: body.requestId,
        plan: body.controller.plan,
        phaseCode: body.controller.phase,
      };
      x.caseTimeApplied = at * 1000;
      this._setOutcome(x, "applied", summary);
      // Nothing to control: a stopped pump at target 0 need not keep asking.
      if (this.target.value === 0 && this.rate === 0 && body.fallback.rate === 0) this.nextRequestAt = null;
    } else if (this.state === "paused") {
      // The server computes; the pump decides: paused, the plan is noted, not run.
      this.nextRequestAt = nextRequestAt;
      this.segment = null;
      x.caseTimeApplied = at * 1000;
      this._setOutcome(x, "applied", `${summary} (pump paused: the plan is not run)`);
    } else {
      this._setOutcome(x, "late-discarded", "arrived while the pump was in alarm: not run");
    }
  }

  _holdEnded(at) {
    const s = this.segment;
    if (!s) return; // dropped by an alarm the physics absorbed on the way here
    s.phase = "fallback";
    this._setRate(at, s.fallbackRate, "fallback");
    if (this.segment !== s) return; // the fallback command's own reading raised an alarm
    this._note(at, `hold of ${s.requestId} ended without a newer command: fallback ${sig(s.fallbackRate, 6)} mL/hr for ${sig(s.fallbackUntil - s.holdUntil)} s`);
  }

  _fallbackEnded(at) {
    const s = this.segment;
    if (!s) return; // dropped by an alarm the physics absorbed on the way here
    s.phase = "done";
    // Rule 4: a command of 0 that falls back at 0 is the planned state, not
    // an alarm, when the controller was told to ask later (the effect site
    // rising to its peak), or when the plan was "off" (rule 8: target 0
    // stops the infusion; the API then puts nextRequestAt before the end of
    // the fallback, and _applyResponse() stops asking altogether, so no later
    // command ever supersedes this segment and the stop is what was asked).
    const planned = s.rate === 0 && s.fallbackRate === 0 &&
      (s.plan === "off" || this.target.value === 0 ||
        (s.responseNextRequestAt !== null && s.responseNextRequestAt > at + EPS));
    this._setRate(at, 0, "pump");
    if (this.segment !== s) return; // the stop's own reading raised an alarm, which stands
    this.segment = null;
    if (!planned) this._alarm(at, "fallbackExpired", "no command accepted by the end of the fallback segment: the pump stopped");
  }

  _alarm(at, kind, message) {
    this.state = "alarm";
    this.alarmKind = kind;
    this.alarms.push({ time: at, kind, message });
    this._note(at, `ALARM: ${message}`);
    this.nextRequestAt = null;
    this._sample(true);
  }

  _clearAlarm() {
    if (this.state === "alarm") {
      this.state = "running";
      this.alarmKind = null;
      // A condition the pump still reports is raised again at the next reading.
      this._standingAlarms.clear();
    }
  }

  // -------------------------------------------------------------------------
  // The exchange record

  _addExchange(exchange) {
    this.exchanges.push(exchange);
    const strip = this.exchanges.length - this.fullExchanges - 1;
    if (strip >= 0) {
      const old = this.exchanges[strip];
      if (!old.stripped) {
        old.request = undefined;
        old.response = undefined;
        old.stripped = true;
      }
    }
    this._notifyExchange(exchange);
  }

  _setOutcome(exchange, outcome, summary) {
    exchange.outcome = outcome;
    exchange.summary = summary;
    this._notifyExchange(exchange);
  }

  _notifyExchange(exchange) {
    for (const cb of this._exchangeListeners) {
      try { cb(exchange); } catch (e) { /* a listener's fault is not the pump's */ }
    }
  }

  /** Register a callback for an exchange being added or changing outcome; returns an unsubscribe function. */
  onExchange(callback) {
    this._exchangeListeners.push(callback);
    return () => {
      this._exchangeListeners = this._exchangeListeners.filter((cb) => cb !== callback);
    };
  }

  // -------------------------------------------------------------------------
  // Compaction (section 4.2): segments older than 30 min become one delivered
  // segment per minute, split at any syringe change, with the rate in force
  // re-stated at the boundary so the rate function stays right.

  _compactHistory(now) {
    const cutoff = now - this.compactOlderThanSeconds;
    if (cutoff <= this.compactedUntil + EPS) return;
    const minutes = Math.floor((cutoff - this.caseStart) / 60 + EPS);
    const boundary = this.caseStart + 60 * minutes;
    if (boundary <= this.compactedUntil + EPS) return;
    this.history = compactHistory(this.history, this.compactedUntil, boundary);
    this.compactedUntil = boundary;
    this._note(now, `history compacted up to ${clockText(boundary)}: ${this.history.length} events`);
  }

  // -------------------------------------------------------------------------
  // Local events (section 7, rule 6): the pump is brought up to now first,
  // holding back a request that falls due at this very instant so that the
  // event is in the record the request carries; any outstanding response is
  // then stale and is superseded; then it asks at once.
  //
  // The event is stamped at the PHYSICS time, not the clock's.  They differ
  // when _run() has parked the physics at an in-flight request's applyAt
  // (the in-page controller answers in a later macrotask, so a request that
  // fell due since the last tick is waiting for its answer) and a click
  // lands in that gap, which at 60x is most clicks.  Stamping the event at
  // the clock would put it AHEAD of the physics: the record would stop being
  // chronological, and the superseding request, due at the clock's now,
  // would lose to the parked wait, so the stale answer, planned for the old
  // target, would be applied first.  The face shows the physics time as the
  // case clock, so the stamp is the time the user saw.

  _localEvent(mutate) {
    const now = this._now();
    let at = now;
    if (this.started) {
      this._run(now, now);
      // Rule 6: an outstanding response is stale.  Dropping it here (not only
      // when the new request goes out) also closes the route by which an
      // answer with applyAt before lastSentAt + 1 (an actual latency under
      // the one-second minimum between requests) would still be applied.
      const f = this.inFlight;
      if (f) {
        if (f.exchange.outcome === "pending") {
          this._setOutcome(f.exchange, "superseded", "superseded by a local event before it took effect (section 7, rule 6)");
        }
        this.inFlight = null;
      }
      at = this.t;
    }
    mutate(at);
    if (this.started && this._controllerActive()) {
      this.nextRequestAt = this.lastSentAt === null ? at : Math.max(at, this.lastSentAt + 1);
      this._run(at);
    }
  }

  /** Start the case: the physics clock begins, the initial syringe is recorded, and the loop runs if a target is set. */
  start() {
    if (this.started) return;
    const now = this._now();
    this.started = true;
    this.caseStart = now;
    this.t = now;
    this.state = "running";
    this.history = [];
    this.record = [];
    this._raisedAlarms.clear();
    this._standingAlarms.clear();
    this._seenNotices.clear();
    this._pushEvent({ time: fmt(now), infusate: { concentration: this.syringe.concentration, units: this.syringe.units } });
    this._loadDriverSyringe(now);
    this.compactedUntil = now;
    this.lastCompactionAt = now;
    this._sample(true);
    if (this.target.value > 0) {
      this.nextRequestAt = now;
      this._run(now);
    }
  }

  /**
   * Set the target (in the drug's concentration units; `site` "effect" or
   * "plasma", default the current site) and ask the controller at once.  A
   * new target below the last response's prediction.peakCe stops the pump
   * immediately (rule 6) when stopOnLoweredTarget is on; a target of 0 stops
   * the infusion.  A pump in alarm is restarted by this.
   */
  setTarget(value, site) {
    this._localEvent((now) => {
      const peak = this.lastResponse && this.lastResponse.prediction ? this.lastResponse.prediction.peakCe : null;
      this._setTargetValue(value, site);
      if (!this.started) return;
      if (this.state === "alarm") {
        if (this.target.value === 0) {
          // Nothing to run: the pump is already stopped, and its condition stands.
          this._note(now, "target 0 while in alarm: the pump stays stopped");
          return;
        }
        this._clearAlarm();
        this._note(now, "alarm cleared by a new target");
      }
      if (this.stopOnLoweredTarget && this.state === "running" && this.rate > 0) {
        const below = this.target.value === 0 || (isFiniteNumber(peak) && this.target.value < peak);
        if (below) {
          this._setRate(now, 0, "manual");
          this.segment = null;
          this.stoppedForTarget = true;
          this._note(now, `target ${this.target.value} is below the predicted peak ${sig(peak)}: pump stopped at once (rule 6)`);
        }
      }
    });
  }

  /** Target 0: stop the infusion (the controller confirms with plan "off"). */
  stop() {
    this.setTarget(0);
  }

  /** A hand bolus in the drug's mass unit, given outside the pump: the truth gets it, the record gets a manual bolus event. */
  handBolus(amount) {
    if (!isFiniteNumber(amount) || amount <= 0) throw new Error("a hand bolus must be a positive amount");
    this._localEvent((now) => {
      if (!this.started) throw new Error("start the pump before giving a bolus");
      this.truth = bolus(this.truth, amount, this.model);
      this.belief = bolus(this.belief, amount, this.model);
      this._pushEvent({ time: fmt(now), bolus: amount, units: this.massUnits, source: "manual" });
      this._note(now, `hand bolus ${amount} ${this.massUnits}`);
      this._sample(true);
    });
  }

  /** Pause: rate 0 at once (recorded), pump.state "paused" in the requests, which continue. */
  pause() {
    this._localEvent((now) => {
      if (!this.started || this.state !== "running") return;
      this._setRate(now, 0, "manual");
      this.segment = null;
      this.state = "paused";
      this._note(now, "paused");
    });
  }

  /** Resume from pause or from alarm: the controller asks at once and the response restarts the pump. */
  resume() {
    this._localEvent((now) => {
      if (!this.started || this.state === "running") return;
      if (this.state === "alarm") this._clearAlarm();
      this.state = "running";
      this._note(now, "resumed");
    });
  }

  /** The next response to arrive is lost (teaching control): the pump runs its fallback. */
  dropNextResponse() {
    this.dropNext = true;
  }

  /** How long the simulated pump really takes to acknowledge a command, in seconds. */
  setActualLatency(seconds) {
    if (!isFiniteNumber(seconds) || seconds < 0) throw new Error("actualLatency must be >= 0");
    this.actualLatency = seconds;
  }

  /**
   * Change the syringe: the controller is TOLD `concentrationTold` (recorded
   * as an infusate event and sent as the request's infusate), the syringe
   * really holds `concentrationTrue` (default as told), and it is full
   * (`volume`, default the configured syringe volume).
   */
  changeSyringe(concentrationTold, concentrationTrue = concentrationTold, volume = this.syringeVolume) {
    if (!isFiniteNumber(concentrationTold) || concentrationTold < TCI_API.MIN_INFUSATE) {
      throw new Error(`the concentration told must be at least ${TCI_API.MIN_INFUSATE} ${this.syringe.units}`);
    }
    if (!isFiniteNumber(concentrationTrue) || concentrationTrue <= 0) throw new Error("the true concentration must be > 0");
    if (!isFiniteNumber(volume) || volume <= 0) throw new Error("the syringe volume must be > 0");
    this._localEvent((now) => {
      this.syringe = { concentration: concentrationTold, units: this.syringe.units };
      this.trueConcentration = concentrationTrue;
      this._recomputeConcentrations();
      this.syringeVolume = volume;
      this._loadDriverSyringe(now);
      if (this.started) {
        this._pushEvent({ time: fmt(now), infusate: { concentration: concentrationTold, units: this.syringe.units }, source: "manual" });
        this._note(now, `syringe changed: controller told ${concentrationTold} ${this.syringe.units}, really ${concentrationTrue}`);
        if (this.state === "alarm" && this.alarmKind === "syringeEmpty") this._clearAlarm();
      }
    });
  }

  /**
   * The tab was in the background for `elapsedMs` of simulated time ending
   * now: the controller slept (no requests were sent, no response applied)
   * while the pump behaved as the contract says: it ran its segment to
   * holdUntil, the fallback for maxSeconds, then stopped and alarmed.  After
   * a short gap within a hold the controller simply asks again at once.
   */
  catchUp(elapsedMs) {
    if (!this.started) return;
    const now = this._now();
    const gap = isFiniteNumber(elapsedMs) && elapsedMs > 0 ? elapsedMs / 1000 : 0;
    const gapStart = Math.max(this.t, now - gap);
    this._run(gapStart);
    const f = this.inFlight;
    if (f) {
      this.inFlight = null;
      if (f.exchange.outcome === "pending") {
        this._setOutcome(f.exchange, "no-response", "the controller was suspended (background tab) before the response could take effect");
      }
    }
    this.nextRequestAt = null;
    this._suspended = true;
    try {
      this._run(now);
    } finally {
      this._suspended = false;
    }
    this.backgroundGaps.push({ from: gapStart, to: now });
    this._note(now, `background gap of ${sig(now - gapStart, 6)} s: the controller sent nothing`);
    if (this.state === "running" && this.target.value > 0) {
      this.nextRequestAt = this.lastSentAt === null ? now : Math.max(now, this.lastSentAt + 1);
      this._run(now);
    }
  }

  // -------------------------------------------------------------------------
  // Export

  /**
   * The full record as stanpumpR dose-table rows { Drug, Time, Dose, Units }:
   * Time in minutes from the first event, hand boluses in the drug's mass
   * unit, rate changes in mg/hr (mg drugs) or mcg/min (mcg drugs) through
   * the concentration the controller was told at the time.  The library
   * accepts both infusion units for every drug (infusionUnits in
   * R/constants.R).
   */
  exportDoseTable() {
    const rows = [];
    if (!this.started) return rows;
    const rateUnits = this.massUnits === "mg" ? "mg/hr" : "mcg/min";
    let concBase = this.toldConcBase;
    // The infusate in force is the last infusate event at or before the row.
    const initial = this.record.find((e) => e.infusate !== undefined);
    if (initial) concBase = concentrationInBase(initial.infusate.concentration, initial.infusate.units, this.massUnits);
    const rateRow = (minutes, ml) => {
      const massPerHour = ml * concBase;
      const dose = rateUnits === "mg/hr" ? massPerHour : massPerHour / 60;
      return { Drug: this.drug, Time: minutes, Dose: Number(dose.toPrecision(12)), Units: rateUnits };
    };
    // A bolus in the drug's mass unit; one recorded in mL or the other mass
    // unit (the API accepts mg, mcg and mL) is converted.
    const bolusInMass = (amount, units) => {
      if (units === "mL") return Number((amount * concBase).toPrecision(12));
      if (units === this.massUnits) return amount;
      return Number((units === "mg" ? amount * 1000 : amount / 1000).toPrecision(12));
    };
    let lastRateMl = 0;
    for (let i = 0; i < this.record.length; i++) {
      const e = this.record[i];
      const when = parseRfc3339(e.time !== undefined ? e.time : e.from);
      const minutes = Number(((when - this.caseStart) / 60).toPrecision(12));
      if (e.infusate !== undefined) {
        concBase = concentrationInBase(e.infusate.concentration, e.infusate.units, this.massUnits);
        // A syringe change while the pump runs changes the mass rate at that
        // instant, so the dose table needs a rate row there (unless a rate
        // change at the same instant supplies it); otherwise it would carry
        // the old concentration's mass rate to the next rate change.
        const next = this.record[i + 1];
        const rateAtSameInstant = next && next.rate !== undefined && next.time === e.time;
        if (lastRateMl > 0 && !rateAtSameInstant) rows.push(rateRow(minutes, lastRateMl));
        continue;
      }
      if (e.bolus !== undefined) {
        rows.push({ Drug: this.drug, Time: minutes, Dose: bolusInMass(e.bolus, e.units), Units: this.massUnits });
      } else if (e.rate !== undefined) {
        lastRateMl = e.rate;
        rows.push(rateRow(minutes, e.rate));
      }
    }
    return rows;
  }

  /** exportDoseTable() as CSV text with the stanpumpR column order. */
  exportDoseTableCsv() {
    const lines = ["Drug,Time,Dose,Units"];
    for (const r of this.exportDoseTable()) lines.push(`${r.Drug},${r.Time},${r.Dose},${r.Units}`);
    return lines.join("\n") + "\n";
  }

  // -------------------------------------------------------------------------
  // The snapshot

  /**
   * Everything the page shows, read-only: configuration, state, segment and
   * countdowns, the record, the exchanges, the last request and response,
   * the true and predicted concentrations at the physics time, the phase,
   * the alarms and the chart series (points { time (s of case time), trueCp,
   * trueCe, predictedCp, predictedCe, rate, target, state }, one per tick at
   * most once a second plus one at every event).  Arrays are the pump's own,
   * returned by reference; do not modify them, and read lengths at once.
   */
  snapshot() {
    const now = this.started ? this._now() : null;
    const t = this.t;
    const last = this.lastResponse;
    const seg = this.segment;
    let phaseCode;
    if (!this.started) phaseCode = "standby";
    else if (this.state === "alarm") phaseCode = "alarm";
    else if (this.state === "paused") phaseCode = "paused";
    else if (this.target.value === 0 && this.rate === 0) phaseCode = "stopped";
    else if (this.stoppedForTarget) phaseCode = "aboveTarget";
    else if (seg && seg.phase === "fallback") phaseCode = "fallback";
    else if (last) phaseCode = last.controller.phase;
    else phaseCode = "loading";
    const phaseWord = phaseCode === "alarm" ? "ALARM" : phaseCode === "paused" ? "paused"
      : phaseCode === "standby" ? "standby" : phaseCode === "fallback" ? "fallback"
        : (PHASE_WORDS[phaseCode] || phaseCode);
    const rem = (until) => (until === null || t === null ? null : Math.max(0, until - t));
    return {
      config: {
        drug: this.drug,
        patient: { ...this.patient },
        syringe: { ...this.syringe },
        trueConcentration: this.trueConcentration,
        syringeVolume: this.syringeVolume,
        limits: { ...this.limits },
        rateUnits: this.rateUnits,
        declaredLatency: this.declaredLatency,
        actualLatency: this.actualLatency,
        interval: this.interval,
        transport: this.transport.mode,
        transportLabel: this.transport.label,
        baseUrl: this.transport.baseUrl,
        massUnits: this.massUnits,
        concentrationUnits: this.concentrationUnits,
        stopOnLoweredTarget: this.stopOnLoweredTarget,
        compaction: this.compaction,
      },
      model: {
        tPeak: this.model.params.tPeak,
        ke0: this.model.params.ke0,
        reference: this.model.reference,
        typical: this.model.typical,
        lower: this.model.lower,
        upper: this.model.upper,
      },
      started: this.started,
      caseStart: this.caseStart === null ? null : this.caseStart * 1000,
      clockNow: now === null ? null : now * 1000,
      time: t === null ? null : t * 1000,
      caseSeconds: t === null ? 0 : t - this.caseStart,
      state: this.state,
      apiState: this._apiState(),
      alarmKind: this.alarmKind,
      alarms: this.alarms,
      notes: this.notes,
      phaseCode,
      phase: phaseWord,
      plan: last ? last.controller.plan : null,
      rate: this.rate,
      rateUnits: this.rateUnits,
      massRate: this._baseRate(this.rate, this.toldConcBase),
      trueMassRate: this._baseRate(this.rate, this.trueConcBase),
      target: { ...this.target, units: this.concentrationUnits },
      segment: seg ? { ...seg } : null,
      holdRemaining: seg && seg.phase === "hold" ? rem(seg.holdUntil) : null,
      fallbackRemaining: seg && seg.phase === "fallback" ? rem(seg.fallbackUntil) : null,
      fallbackRate: seg ? seg.fallbackRate : null,
      nextRequestAt: this.nextRequestAt === null ? null : this.nextRequestAt * 1000,
      nextRequestIn: this.nextRequestAt === null ? null : rem(this.nextRequestAt),
      inFlight: this.inFlight ? { id: this.inFlight.exchange.id, sentAt: this.inFlight.sentAt * 1000, applyAt: this.inFlight.applyAt === null ? null : this.inFlight.applyAt * 1000 } : null,
      requestCount: this.requestCounter,
      history: this.history,
      record: this.record,
      volumeInfused: this.volumeInfused,
      trueMassInfused: this.trueMassInfused,
      syringeRemaining: this.syringeRemaining,
      pump: this._lastReading ? {
        state: this._lastReading.state,
        rate: this._lastReading.rate,
        acknowledgedAt: this._lastReading.acknowledgedAt === null ? null : this._lastReading.acknowledgedAt * 1000,
        commanded: this._lastReading.commanded
          ? { rate: this._lastReading.commanded.rate, at: isFiniteNumber(this._lastReading.commanded.at) ? this._lastReading.commanded.at * 1000 : null }
          : null,
        alarms: (this._lastReading.alarms || []).map((a) => ({ ...a, at: isFiniteNumber(a.at) ? a.at * 1000 : null })),
        notices: (this._lastReading.notices || []).map((n) => ({ ...n, at: isFiniteNumber(n.at) ? n.at * 1000 : null })),
      } : null,
      timeToEmpty: this.rate > 0 ? this.syringeRemaining * 3600 / this.rate : null,
      truth: { cp: cp(this.truth), ce: ce(this.truth), p: [...this.truth.p], e: [...this.truth.e] },
      predicted: { cp: cp(this.belief), ce: ce(this.belief), p: [...this.belief.p], e: [...this.belief.e] },
      prediction: last ? {
        peakCe: last.prediction.peakCe,
        peakAt: last.prediction.peakAt,
        onTarget: last.prediction.onTarget,
        deviation: last.prediction.deviation,
        targetReachedAt: last.prediction.targetReachedAt,
        holdUntil: { ...last.state.holdUntil },
        syringeEmptyAt: last.prediction.syringeEmptyAt === undefined ? null : last.prediction.syringeEmptyAt,
      } : null,
      lastRequest: this.lastRequest,
      lastResponse: this.lastResponse,
      lastStatus: this.lastStatus,
      lastExchange: this.exchanges.length ? this.exchanges[this.exchanges.length - 1] : null,
      exchanges: this.exchanges,
      series: this.series,
      maxTrueCe: this.maxTrueCe,
      maxTrueCeAt: this.maxTrueCeAt === null ? null : this.maxTrueCeAt * 1000,
      backgroundGaps: this.backgroundGaps,
      dropNext: this.dropNext,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with the tests

function cloneEvent(e) {
  const out = { ...e };
  if (e.infusate) out.infusate = { ...e.infusate };
  return out;
}

function lastRateEvent(list) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].rate !== undefined) return list[i];
  return null;
}

const eventTime = (e) => parseRfc3339(e.time !== undefined ? e.time : e.from);

/**
 * Merge the rate changes between `from` and `boundary` (seconds since the
 * epoch, `from` a minute mark of the case) into one delivered segment per
 * minute in mL, split at any syringe change and at any large rate step
 * (COMPACTION_LARGE_STEP), and re-state the rate in force at `boundary` as a
 * rate change there, as docs/tci-api.md section 4.2 allows for the part of
 * the record older than 30 minutes.  Boluses, infusate changes and earlier
 * segments are kept.  Returns the new history array, chronological; the
 * input is not modified.
 */
export function compactHistory(history, from, boundary) {
  const events = history.map((e) => ({ e, when: eventTime(e) }));
  const rateChanges = events.filter((x) => x.e.rate !== undefined && x.when < boundary - EPS)
    .sort((a, b) => a.when - b.when);
  const rateAt = (t) => {
    let r = 0;
    for (const x of rateChanges) {
      if (x.when <= t + EPS) r = x.e.rate; else break;
    }
    return r;
  };
  // Segment edges: every minute from `from`, every syringe change inside,
  // and every large rate step inside (a loading infusion starting or ending,
  // a target change), whose timing a whole-minute merge would blur.
  const edges = [];
  for (let t = from; t < boundary - EPS; t += 60) edges.push(t);
  edges.push(boundary);
  for (const x of events) {
    if (x.e.infusate !== undefined && x.when > from + EPS && x.when < boundary - EPS) edges.push(x.when);
  }
  let previous = rateAt(from);
  for (const x of rateChanges) {
    if (x.when <= from + EPS) continue;
    const r = x.e.rate;
    if (Math.abs(r - previous) > COMPACTION_LARGE_STEP * Math.max(Math.abs(r), Math.abs(previous))) edges.push(x.when);
    previous = r;
  }
  const uniqueEdges = [...new Set(edges)].sort((a, b) => a - b);
  const changeTimes = rateChanges.map((x) => x.when);
  const roundMs = (t) => Math.round(t * 1000) / 1000;
  const segments = [];
  for (let j = 0; j + 1 < uniqueEdges.length; j++) {
    const a = uniqueEdges[j];
    const b = uniqueEdges[j + 1];
    // The mass delivered over [a, b) and its mean delivery time, from the
    // piecewise-constant rate.
    const cuts = [a, ...changeTimes.filter((c) => c > a + EPS && c < b - EPS), b];
    let ml = 0;
    let moment = 0;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const piece = rateAt(cuts[k]) * (cuts[k + 1] - cuts[k]) / 3600;
      ml += piece;
      moment += piece * (cuts[k] + cuts[k + 1]) / 2;
    }
    if (ml <= 0) continue;
    // The server reads a segment as uniform over its span.  A segment that
    // spans the window carries the right mass but puts its mean delivery
    // time at the window's midpoint, which for a changing rate is off by
    // slope x T^2 / 12 and is what the plan feels most (the slow
    // eigenvalues weight delivery by its time).  So the segment is the
    // widest span inside the window with the window's own centroid: a
    // constant rate gives the whole window, a staircase a span shorter by a
    // fraction of a second, and only the spread within the window is then
    // approximated.  Edges are rounded to the millisecond inside the window
    // so neighbouring segments never overlap (HISTORY_OVERLAP).
    const centroid = moment / ml;
    const half = Math.min(centroid - a, b - centroid);
    const start = Math.max(a, roundMs(centroid - half));
    const end = Math.min(b, roundMs(centroid + half));
    if (!(end > start)) continue;
    segments.push({ from: fmt(start), to: fmt(end), delivered: j15(ml), units: "mL", source: "compacted" });
  }
  const kept = events.filter((x) => !(x.e.rate !== undefined && x.when < boundary - EPS));
  const atBoundary = kept.some((x) => x.e.rate !== undefined && Math.abs(x.when - boundary) <= EPS);
  const running = rateAt(boundary);
  const marker = !atBoundary && running > 0
    ? [{ e: { time: fmt(boundary), rate: running, units: rateChanges.length ? rateChanges[rateChanges.length - 1].e.units : "mL/hr", source: "compacted" }, when: boundary }]
    : [];
  const out = kept.concat(segments.map((s) => ({ e: s, when: parseRfc3339(s.from) })), marker);
  // Chronological, stable: at one instant an infusate change, then a bolus,
  // then a segment, then a rate change (the server's own order).
  const kindRank = (e) => (e.infusate !== undefined ? 0 : e.bolus !== undefined ? 1 : e.delivered !== undefined ? 2 : 3);
  out.sort((a, b) => (a.when - b.when) || (kindRank(a.e) - kindRank(b.e)));
  return out.map((x) => x.e);
}
