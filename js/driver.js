// FauxTCI: the pump driver, the one interface between the controller logic
// in FauxPump (js/pump.js) and a syringe pump.
//
// WHAT IT IS
// ==========
// Everything the controller knows about the hardware comes through one
// object with three methods, each called with the controller's clock time
// in seconds since the epoch:
//
//   infuse(time, rate)      Command and read back: run `rate` mL/hr from
//                           `time` (null: change nothing, just read), and
//                           return what the pump has actually done.  This is
//                           STANPUMP's infuse(): set the rate, read the volume
//                           infused, every interval and on every local event.
//   loadSyringe(time, s)    A new syringe at `time`: { volume (mL),
//                           concentration (the drug's base mass unit per mL,
//                           what is really in the syringe), units ("mg" or
//                           "mcg", the drug's base mass unit), drug (its
//                           name) }.  The controller calls it once at
//                           start() for the syringe the case begins with,
//                           and again on every syringe change.
//   horizon(time)           When the pump will next change state by itself
//                           (a syringe about to run out, a command about to
//                           take effect), as a time in seconds STRICTLY
//                           LATER than `time`, or null when it cannot
//                           predict.  Optional: a driver that returns null is
//                           polled at the controller's own cadence and its
//                           events are seen at the next poll.  A time at or
//                           before `time` is ignored.
//
// THE CALLING CONVENTION
// ======================
// The three methods are synchronous: each returns at once, from the driver's
// own cached status, and never throws.  A real driver talks to its pump in
// the background (a serial port, Bluetooth, a socket), keeps the last status
// it received, issues each command when infuse() asks for it, and answers
// infuse() from what it has.  The controller never calls the driver with a
// `time` earlier than a previous call's.  A method that throws, or returns a
// Promise or anything but a reading, is a driver fault: the controller
// raises the alarm "driverFault", stops asking the server, records nothing
// it has not seen, and keeps its own clock running; a reading that then
// arrives normally clears the fault (the alarm stays until the user clears
// it, as every alarm does).
//
// THE READING
// ===========
// infuse() and loadSyringe() return a Reading, the pump's account of itself
// as of `time` (the controller attributes the totaliser's change to the
// interval that ends at `time`):
//
//   time              s, the instant the reading describes (the `time` asked)
//   rate              mL/hr actually running at `time`, 0 when stopped
//   acknowledgedAt    s, when the rate running took effect
//   commanded         { rate, at } a command not yet running, or null
//   volumeInfused     mL, the pump's own volume totaliser.  It need not be 0
//                     at the first call and it may be reset (go backwards):
//                     the controller counts from the first reading and takes
//                     a decrease as a reset, so the request's
//                     pump.volumeInfused is always the volume since the case
//                     started.  The controller never integrates the
//                     commanded rate itself.
//   massInfused       the drug totaliser in massUnits, or null when the pump
//                     has none (the controller then uses the volume at the
//                     syringe's true concentration)
//   massUnits         "mg" or "mcg" (converted to the drug's unit), or null
//                     for the drug's own unit
//   syringeRemaining  mL left, or null when the pump cannot tell (the
//                     controller then derives it: the loaded volume less the
//                     volume totalised since the load)
//   state             "running" | "stopped" | "paused".  "paused" is a pump
//                     paused from its own panel: the controller goes to
//                     paused too (the plan is noted, not run) and resumes
//                     when the pump does.  "stopped" is a pump that will not
//                     run a command until something is done on it; with no
//                     alarm it is reported to the server as "standby".
//   alarms            [{ kind, message, at }]: the conditions the pump is
//                     in, each with the time it began.  An alarm means the
//                     pump has stopped, or must: on the first reading that
//                     shows one the controller commands rate 0, records the
//                     stop (at the alarm's `at` when the pump had stopped
//                     itself, at the stop command when it was still
//                     running), drops its command segment and raises the
//                     alarm; the
//                     pump must keep reporting the alarm until the condition
//                     is cleared on the pump, and the controller raises it
//                     again if the user clears it first.  "syringeEmpty" and
//                     "occlusion" are the kinds the API's pump.state names;
//                     any other ("doorOpen", ...) is raised as it comes.
//   notices           [{ kind, message, at }] optional: conditions that do
//                     not stop the pump (low battery, near end of infusion).
//                     Noted on the pump face once each, never acted on.
//
// SimulatedPump is the pump FauxTCI runs: it delivers exactly the commanded
// rate, keeps a syringe of known volume and true concentration, stops and
// alarms when the syringe runs out, refuses to run until a new one is
// loaded, and can be given an acknowledgement delay.  A real pump's driver
// subclasses PumpDriver, speaks the pump's protocol inside these three
// methods, and is passed to FauxPump as the `driver` option (the page takes
// it from window.FauxTCI.driver).
//
// Drafted by Claude Code, 2026-10-14, at the request of Steven L. Shafer.

const EMPTY_ML = 1e-9; // below this the syringe counts as empty

const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);

/** The interface.  Every method throws until a subclass provides it. */
export class PumpDriver {
  /**
   * Run `rate` mL/hr from `time` (seconds since the epoch on the controller's
   * clock); `rate` null or undefined leaves the running rate alone.  Returns
   * a Reading as of `time`, at once.
   */
  infuse(time, rate) { // eslint-disable-line no-unused-vars
    throw new Error("PumpDriver.infuse(time, rate) is not implemented");
  }

  /** A new syringe loaded at `time`: { volume, concentration, units, drug }.  Returns a Reading. */
  loadSyringe(time, syringe) { // eslint-disable-line no-unused-vars
    throw new Error("PumpDriver.loadSyringe(time, syringe) is not implemented");
  }

  /** The next time, later than `time`, at which the pump will change state on its own, or null. */
  horizon(time) { // eslint-disable-line no-unused-vars
    return null;
  }
}

/** A Reading with every field present (a driver may build its readings with this). */
export function makeReading(fields) {
  return {
    time: null,
    rate: 0,
    acknowledgedAt: null,
    commanded: null,
    volumeInfused: 0,
    massInfused: null,
    massUnits: null,
    syringeRemaining: null,
    state: "running",
    alarms: [],
    notices: [],
    ...fields,
  };
}

/**
 * The simulated syringe pump FauxTCI runs.
 *
 * Options: syringeVolume (mL, default 50), concentration (mass units per mL
 * really in the syringe, default 1), massUnits ("mg" or "mcg", default
 * "mg"), acknowledgeDelay (s, default 0: a command takes effect at the time
 * it is given; a positive delay runs the old rate until then).
 *
 * A call with a `time` earlier than the pump's own time reads as now: the
 * pump never goes back, and a command given then takes effect from the
 * pump's time.
 */
export class SimulatedPump extends PumpDriver {
  constructor(options = {}) {
    super();
    const o = { syringeVolume: 50, concentration: 1, massUnits: "mg", acknowledgeDelay: 0, ...options };
    if (!isFiniteNumber(o.syringeVolume) || o.syringeVolume <= 0) throw new Error("syringeVolume must be > 0");
    if (!isFiniteNumber(o.concentration) || o.concentration <= 0) throw new Error("concentration must be > 0");
    if (!isFiniteNumber(o.acknowledgeDelay) || o.acknowledgeDelay < 0) throw new Error("acknowledgeDelay must be >= 0");
    this.t = null; // s, the time the pump has been advanced to; null until the first call
    this.rate = 0; // mL/hr running
    this.acknowledgedAt = null;
    this.commanded = null; // { rate, at } awaiting its acknowledgement
    this.volumeInfused = 0; // mL, the totaliser
    this.massInfused = 0; // mass units, the drug totaliser
    this.massUnits = o.massUnits;
    this.concentration = o.concentration; // what is really in the syringe
    this.syringeVolume = o.syringeVolume;
    this.syringeRemaining = o.syringeVolume;
    this.state = "running";
    this.alarms = [];
    this.notices = [];
    this.acknowledgeDelay = o.acknowledgeDelay;
  }

  infuse(time, rate) {
    if (!isFiniteNumber(time)) throw new Error("infuse(): time must be seconds since the epoch");
    this._advance(time);
    if (rate !== null && rate !== undefined) {
      if (!isFiniteNumber(rate) || rate < 0) throw new Error("infuse(): rate must be a finite number of mL/hr >= 0");
      this.commanded = { rate, at: this.t + this.acknowledgeDelay };
      if (this.acknowledgeDelay <= 0) this._applyCommand();
    }
    return this.reading();
  }

  loadSyringe(time, syringe = {}) {
    if (!isFiniteNumber(time)) throw new Error("loadSyringe(): time must be seconds since the epoch");
    this._advance(time);
    if (syringe.volume !== undefined) {
      if (!isFiniteNumber(syringe.volume) || syringe.volume <= 0) throw new Error("loadSyringe(): volume must be > 0");
      this.syringeVolume = syringe.volume;
    }
    if (syringe.concentration !== undefined) {
      if (!isFiniteNumber(syringe.concentration) || syringe.concentration <= 0) throw new Error("loadSyringe(): concentration must be > 0");
      this.concentration = syringe.concentration;
    }
    if (syringe.units) this.massUnits = syringe.units;
    this.syringeRemaining = this.syringeVolume;
    this.alarms = this.alarms.filter((a) => a.kind !== "syringeEmpty");
    if (this.state === "stopped" && this.alarms.length === 0) this.state = "running";
    return this.reading();
  }

  horizon(time) {
    if (this.t === null) return null;
    let next = null;
    if (this.commanded && this.commanded.at > this.t) next = this.commanded.at;
    const empty = this._emptyAt();
    if (empty !== null && (next === null || empty < next)) next = empty;
    // The contract: strictly later than the time asked, or null.
    return next !== null && next > Math.max(time, this.t) ? next : null;
  }

  /** The pump's account of itself at its own time. */
  reading() {
    return makeReading({
      time: this.t,
      rate: this.rate,
      acknowledgedAt: this.acknowledgedAt,
      commanded: this.commanded ? { ...this.commanded } : null,
      volumeInfused: this.volumeInfused,
      massInfused: this.massInfused,
      massUnits: this.massUnits,
      syringeRemaining: this.syringeRemaining,
      state: this.state,
      alarms: this.alarms.map((a) => ({ ...a })),
      notices: this.notices.map((n) => ({ ...n })),
    });
  }

  // -- the physics of the syringe ------------------------------------------

  // The time the syringe runs out at the running rate, or null when the
  // pump is not running.  Never earlier than the pump's own time.
  _emptyAt() {
    if (this.state !== "running" || this.rate <= 0 || !Number.isFinite(this.syringeRemaining)) return null;
    if (this.syringeRemaining <= EMPTY_ML) return this.t;
    return this.t + this.syringeRemaining * 3600 / this.rate;
  }

  // Bring the pump to `to`, splitting the interval at a command taking effect
  // and at the syringe running out.  Emptiness is decided by TIME: when the
  // computed empty time falls within the step, the whole remainder is
  // delivered and the pump stops, whatever residual the floating-point
  // arithmetic would have left (at epoch-scale times one ulp of the clock is
  // ~2.4e-7 s, which at 500 mL/hr is 30x the volume tolerance, so deciding
  // by residual volume could leave nanolitres in a pump that never empties).
  _advance(to) {
    if (this.t === null) this.t = to;
    if (to < this.t) return; // a time in the past reads as now
    for (let guard = 0; guard < 1000; guard++) {
      if (this.commanded && this.commanded.at <= this.t) this._applyCommand();
      let next = to;
      if (this.commanded && this.commanded.at > this.t && this.commanded.at < next) next = this.commanded.at;
      const empty = this._emptyAt();
      const emptying = empty !== null && empty <= next;
      if (emptying) next = empty;
      this._deliver(next, emptying);
      if (emptying) this._empty();
      if (this.commanded && this.commanded.at <= this.t) this._applyCommand();
      if (this.t >= to) break;
    }
    this.t = to;
  }

  _deliver(to, toEmpty = false) {
    const dt = to - this.t;
    if (this.rate > 0 && this.state === "running" && (dt > 0 || toEmpty)) {
      let ml = this.rate * dt / 3600;
      if (toEmpty || ml >= this.syringeRemaining - EMPTY_ML) ml = this.syringeRemaining;
      this.volumeInfused += ml;
      this.massInfused += ml * this.concentration;
      this.syringeRemaining = Math.max(0, this.syringeRemaining - ml);
    }
    this.t = to;
  }

  _applyCommand() {
    const c = this.commanded;
    this.commanded = null;
    this.acknowledgedAt = c.at;
    // A stopped pump (syringe empty) refuses to run until a syringe is loaded.
    this.rate = this.state === "running" ? c.rate : 0;
  }

  _empty() {
    this.syringeRemaining = 0;
    this.rate = 0;
    this.state = "stopped";
    if (!this.alarms.some((a) => a.kind === "syringeEmpty")) {
      this.alarms.push({ kind: "syringeEmpty", message: "syringe empty: the pump stopped", at: this.t });
    }
  }
}
