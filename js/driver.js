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
//                           concentration (mass units per mL), units }.
//   horizon(time)           When the pump will next change state by itself
//                           (a syringe about to run out, a command about to
//                           take effect), as a time in seconds, or null when
//                           it cannot predict.  Optional: a driver that
//                           returns null is polled at the controller's own
//                           cadence and its events are seen at the next poll.
//
// infuse() and loadSyringe() return a Reading, the pump's account of itself
// as of `time`:
//
//   time              s, the instant the reading describes
//   rate              mL/hr actually running at `time`
//   acknowledgedAt    s, when the rate running took effect
//   commanded         { rate, at } a command not yet running, or null
//   volumeInfused     mL delivered since the totaliser was reset (the pump's
//                     own volume counter; the controller never integrates
//                     the commanded rate itself)
//   massInfused       drug delivered in massUnits (a drug totaliser), or
//                     null when the pump has none
//   massUnits         "mg" or "mcg", or null
//   syringeRemaining  mL left, or null when the pump cannot tell
//   state             "running" | "stopped" | "paused"
//   alarms            [{ kind, message, at }]: the conditions the pump is in,
//                     with `at` the time each began; "syringeEmpty" is the
//                     one the controller names, any other kind ("occlusion",
//                     "doorOpen", ...) is raised as it comes
//
// The controller (FauxPump) records a rate change only when a reading shows
// it running, at the reading's acknowledgedAt; advances the true patient
// model with the mass the reading says was delivered; sends the reading's
// totaliser and syringe volume in the request's pump block; and, on an alarm,
// records the stop at the alarm's time, drops its segment and raises the
// alarm.  A rate the pump reports that the controller did not command is
// recorded with source "pump".
//
// SimulatedPump is the pump FauxTCI runs: it delivers exactly the commanded
// rate, keeps a syringe of known volume and true concentration, stops and
// alarms when the syringe runs out, refuses to run until a new one is
// loaded, and can be given an acknowledgement delay.  A real pump's driver
// subclasses PumpDriver, speaks the pump's protocol inside these three
// methods, and is passed to FauxPump as the `driver` option.
//
// Drafted by Claude Code, 2026-10-14, at the request of Steven L. Shafer.

const EMPTY_ML = 1e-9; // below this the syringe counts as empty

const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);

/** The interface.  Every method throws until a subclass provides it. */
export class PumpDriver {
  /**
   * Run `rate` mL/hr from `time` (seconds since the epoch on the controller's
   * clock); `rate` null or undefined leaves the running rate alone.  Returns
   * a Reading as of `time`.
   */
  infuse(time, rate) { // eslint-disable-line no-unused-vars
    throw new Error("PumpDriver.infuse(time, rate) is not implemented");
  }

  /** A new syringe loaded at `time`: { volume, concentration, units }.  Returns a Reading. */
  loadSyringe(time, syringe) { // eslint-disable-line no-unused-vars
    throw new Error("PumpDriver.loadSyringe(time, syringe) is not implemented");
  }

  /** The next time the pump will change state on its own, or null. */
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
    this.acknowledgeDelay = o.acknowledgeDelay;
  }

  infuse(time, rate) {
    if (!isFiniteNumber(time)) throw new Error("infuse(): time must be seconds since the epoch");
    this._advance(time);
    if (rate !== null && rate !== undefined) {
      if (!isFiniteNumber(rate) || rate < 0) throw new Error("infuse(): rate must be a finite number of mL/hr >= 0");
      this.commanded = { rate, at: time + this.acknowledgeDelay };
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
    return next;
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
    });
  }

  // -- the physics of the syringe ------------------------------------------

  _emptyAt() {
    if (this.state !== "running" || this.rate <= 0 || !Number.isFinite(this.syringeRemaining)) return null;
    if (this.syringeRemaining <= EMPTY_ML) return this.t;
    return this.t + this.syringeRemaining * 3600 / this.rate;
  }

  _advance(to) {
    if (this.t === null) this.t = to;
    if (to < this.t) return; // a time in the past reads as now
    for (let guard = 0; guard < 1000 && this.t < to; guard++) {
      let next = to;
      if (this.commanded && this.commanded.at > this.t && this.commanded.at < next) next = this.commanded.at;
      const empty = this._emptyAt();
      if (empty !== null && empty < next) next = empty;
      this._deliver(next);
      if (this.state === "running" && this.rate > 0 && this.syringeRemaining <= EMPTY_ML) this._empty();
      if (this.commanded && this.commanded.at <= this.t) this._applyCommand();
    }
    this.t = to;
    if (this.commanded && this.commanded.at <= this.t) this._applyCommand();
  }

  _deliver(to) {
    const dt = to - this.t;
    if (dt > 0 && this.rate > 0 && this.state === "running") {
      let ml = this.rate * dt / 3600;
      if (ml >= this.syringeRemaining - EMPTY_ML) ml = this.syringeRemaining;
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
    this.alarms.push({ kind: "syringeEmpty", message: "syringe empty: the pump stopped", at: this.t });
  }
}
