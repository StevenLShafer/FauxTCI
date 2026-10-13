// FauxTCI: the page.  A thin view over FauxPump (js/pump.js): it reads the
// setup, builds a pump on a simulated clock, ticks it every 250 ms of real
// time, and renders snapshot() into the pump face, the two canvas charts, the
// delivery record, the wire panes and the API conversation panel.  Nothing
// here computes a rate or a concentration; the pump and the in-page port of
// the stanpumpR TCI API (js/tci.js, through js/transport.js) do that.
//
// WHY A SIMULATED CLOCK
// =====================
// The pump is driven by clock.now() so that a case can run at 1x, 5x, 10x or
// 60x real time and the request bodies still carry a consistent RFC 3339
// timeline (the API requires every time in a request to come from one clock,
// docs/tci-api.md section 4.2).  When the tab is hidden the clock is frozen
// and the ticker stopped, which is how the controller "sleeps"; when the tab
// is visible again the clock jumps forward by the simulated time that
// elapsed and pump.catchUp() replays the contract's behaviour over the gap
// (the segment ran to holdUntil, the fallback for maxSeconds, then the pump
// stopped and alarmed), so a background tab shows what a real pump would
// have done without its controller.
//
// WHY THE PANEL IS INCREMENTAL
// ============================
// pump.onExchange() fires when an exchange is added or changes outcome, so
// the API conversation panel appends and patches cards rather than redrawing
// the list; JSON bodies are rendered only when a card is opened (or in "Full
// JSON" mode), and only the newest 200 cards are kept in full (spec section
// 7a), so a long case at 60x stays light.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { FauxPump } from "./pump.js";
import { makeTransport, LOCAL_TRANSPORT_LABEL } from "./transport.js";
import { tciApiDrugs, FAUXTCI_VERSION } from "./tci.js";

const $ = (id) => document.getElementById(id);

/** The real-time tick (ms): how often the pump is brought up to the clock. */
export const TICK_MS = 250;
/** The least interval between chart redraws (ms). */
export const CHART_MS = 1000;

const FULL_CARDS = 200; // cards kept in full in the API panel; older ones become one line
const HISTORY_COLLAPSE = 8; // a request's history is collapsed when longer than this
const LOG_LINES = 300; // lines kept in the exchange log under the wire panes
const SLIDER_MAX_LATENCY = 15; // s, the actual-latency slider's range

// The syringe presets of spec section 7 (the usual dilutions).
const SYRINGE_PRESETS = Object.freeze({
  propofol: Object.freeze({ units: "mg/mL", values: [10, 20], initial: 10 }),
  remifentanil: Object.freeze({ units: "mcg/mL", values: [20, 50, 100], initial: 50 }),
});

const DRUGS = tciApiDrugs().drugs; // the two drugs, their units and typical ranges

// Characters used in the readouts, as escapes so the source stays ASCII.
const MIDDOT = "\u00b7";
const DASH = "\u2014";

const perfNow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// The simulated clock

/**
 * A clock that runs `multiplier` times faster than the wall clock, starting
 * from the wall clock's own epoch time so the request bodies carry
 * believable dates.  freeze() stops it (the tab is hidden); thaw() lets it
 * jump forward by the simulated time that elapsed meanwhile and returns that
 * gap in ms, for pump.catchUp().
 */
export class SimClock {
  constructor(multiplier = 1) {
    this.multiplier = multiplier;
    this.base = Date.now();
    this.anchor = perfNow();
    this.frozen = null;
    this.frozenReal = null;
  }

  /** Milliseconds since the epoch on the simulated clock. */
  now() {
    if (this.frozen !== null) return this.frozen;
    return this.base + (perfNow() - this.anchor) * this.multiplier;
  }

  /** Change the speed without moving the clock. */
  setMultiplier(m) {
    this.base = this.now();
    this.anchor = perfNow();
    this.multiplier = m;
  }

  /** Stop the clock where it stands. */
  freeze() {
    if (this.frozen !== null) return;
    this.frozen = this.now();
    this.frozenReal = perfNow();
  }

  /** Resume, jumping forward by the simulated time the freeze covered; returns that gap in ms. */
  thaw() {
    if (this.frozen === null) return 0;
    const gap = (perfNow() - this.frozenReal) * this.multiplier;
    this.base = this.frozen + gap;
    this.anchor = perfNow();
    this.frozen = null;
    this.frozenReal = null;
    return gap;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers

function sig(x, digits = 3) {
  if (typeof x !== "number" || !Number.isFinite(x)) return DASH;
  if (x === 0) return "0";
  return String(Number(x.toPrecision(digits)));
}

// Decimals for a rate readout: enough to show the pump's resolution.
function rateDecimals(resolution) {
  if (!Number.isFinite(resolution) || resolution <= 0) return 1;
  return Math.max(1, Math.min(4, -Math.floor(Math.log10(resolution) + 1e-9)));
}

// mm:ss (h:mm:ss past an hour) of a number of seconds.
function clockText(seconds, tenths = false) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const sec = tenths ? rest.toFixed(1).padStart(4, "0") : String(Math.floor(rest)).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sec}` : `${mm}:${sec}`;
}

// A duration in words: "8.3 s", "4.2 min", "1 h 12 min".
function durationText(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return DASH;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return `${h} h ${m} min`;
}

const utcClock = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : DASH);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// JSON rendering: pretty-printed with minimal colouring (keys, strings,
// numbers, literals), the request's `history` collapsed behind a "show N
// events" control when it is long, because the rest of the body is what a
// reader needs to see first.

/**
 * HTML for a JSON value, two-space indented, with CSS classes k (key), s
 * (string), n (number), l (literal).  `options.collapseHistory` replaces a
 * top-level `history` array longer than HISTORY_COLLAPSE with a button.
 */
export function jsonHtml(value, options = {}, indent = 0, key = null) {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  if (value === null) return '<span class="l">null</span>';
  if (typeof value === "number") return `<span class="n">${Number.isFinite(value) ? String(value) : "null"}</span>`;
  if (typeof value === "boolean") return `<span class="l">${value}</span>`;
  if (typeof value === "string") return `<span class="s">${escapeHtml(JSON.stringify(value))}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (options.collapseHistory && indent === 1 && key === "history" && value.length > HISTORY_COLLAPSE) {
      return `<button type="button" class="json-expand" data-expand="history">show ${value.length} events</button>`;
    }
    const items = value.map((v) => inner + jsonHtml(v, options, indent + 1, null));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (keys.length === 0) return "{}";
    const items = keys.map((k) =>
      `${inner}<span class="k">${escapeHtml(JSON.stringify(k))}</span>: ${jsonHtml(value[k], options, indent + 1, k)}`);
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  return escapeHtml(String(value));
}

function renderJsonInto(pre, value, options = {}) {
  if (value === undefined) {
    pre.textContent = "(body no longer kept: only the newest 200 exchanges are kept in full)";
    return;
  }
  if (value === null) {
    pre.textContent = "(no body)";
    return;
  }
  pre.innerHTML = jsonHtml(value, options);
}

// ---------------------------------------------------------------------------
// Clipboard and download

async function copyText(text, button) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Fallback for a page served over plain http on a LAN: select and copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
  }
  if (button) flashButton(button, ok ? "Copied" : "Copy failed");
}

function flashButton(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  clearTimeout(button._flash);
  button._flash = setTimeout(() => { button.textContent = original; }, 1200);
}

function downloadText(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// The application state

const app = {
  pump: null,
  clock: null,
  unsubscribe: null,
  ticker: null,
  running: false, // a case is in progress (ticking)
  ending: false, // Stop was pressed; waiting for the target-0 response to land
  endDeadline: 0,
  caseStartMs: null,
  lastDraw: 0,
  fullJson: false,
  follow: true,
  programmaticScroll: false,
  cards: new Map(), // requestId -> <li>
  fullCardIds: [], // ids of cards kept in full, oldest first
  logLines: new Map(), // requestId -> <li> in the exchange log
  recordRendered: { length: 0, lastKey: null },
  wireKey: null,
  wireRequestId: null,
  lastPhase: null,
  lastAlarm: null,
};

const el = {
  // setup
  form: $("setup-form"), drug: $("drug"), concentration: $("concentration"),
  weight: $("weight"), height: $("height"), age: $("age"), sex: $("sex"),
  maxRate: $("max-rate"), minRate: $("min-rate"), rateResolution: $("rate-resolution"),
  syringeVolume: $("syringe-volume"), declaredLatency: $("declared-latency"),
  actualLatency: $("actual-latency"), interval: $("interval"), multiplier: $("multiplier"),
  transport: $("transport"), httpFields: $("http-fields"), baseUrl: $("base-url"),
  start: $("start"), stop: $("stop-case"), setupError: $("setup-error"),
  // target
  targetForm: $("target-form"), targetValue: $("target-value"), targetUnits: $("target-units"),
  targetRange: $("target-range"), setTarget: $("set-target"), targetZero: $("target-zero"),
  targetError: $("target-error"),
  // face
  rateValue: $("rate-value"), rateUnits: $("rate-units"), massRate: $("mass-rate"), lamp: $("lamp"),
  phase: $("phase"), plan: $("plan"), alarm: $("alarm"), holdProgress: $("hold-progress"),
  holdFill: $("hold-fill"), holdLabel: $("hold-label"), holdCountdown: $("hold-countdown"),
  fallbackRate: $("fallback-rate"), nextRequest: $("next-request"), caseClock: $("case-clock"),
  syringeRemaining: $("syringe-remaining"), timeToEmpty: $("time-to-empty"), ceReadout: $("ce-readout"),
  cpReadout: $("cp-readout"), targetReadout: $("target-readout"), simClock: $("sim-clock"),
  // teaching
  bolusAmount: $("bolus-amount"), bolusUnits: $("bolus-units"), handBolus: $("hand-bolus"),
  pauseResume: $("pause-resume"), dropNext: $("drop-next"), dropState: $("drop-state"),
  syringeTold: $("syringe-told"), syringeTrue: $("syringe-true"), changeSyringe: $("change-syringe"),
  latencySlider: $("actual-latency-slider"), latencyReadout: $("actual-latency-readout"),
  // charts
  chartCe: $("chart-ce"), chartRate: $("chart-rate"), chartSummary: $("chart-summary"),
  swatchTrue: $("swatch-true"), swatchPredicted: $("swatch-predicted"), swatchCp: $("swatch-cp"),
  swatchTarget: $("swatch-target"),
  // record
  recordBody: $("record-body"), recordEmpty: $("record-empty"), recordCopy: $("record-copy"),
  recordDownload: $("record-download"),
  // wire
  wireStatus: $("wire-status"), wireRequest: $("wire-request"), wireResponse: $("wire-response"),
  wireRequestId: $("wire-request-id"), wireResponseId: $("wire-response-id"),
  wireResponseStatus: $("wire-response-status"), wireCopyRequest: $("wire-copy-request"),
  wireCopyResponse: $("wire-copy-response"), wireLog: $("wire-log"),
  // API panel
  apiPanel: $("api-panel"), apiToggle: $("api-panel-toggle"), apiBody: $("api-panel-body"),
  apiTransport: $("api-transport-label"), apiEndpoint: $("api-endpoint"), apiCount: $("api-count"),
  apiMode: $("api-mode"), apiCopy: $("api-copy"), apiClear: $("api-clear"), apiFollow: $("api-follow"),
  apiCards: $("api-cards"), apiEmpty: $("api-empty"),
  aboutVersion: $("about-version"),
};

const drugInfo = (drug) => DRUGS.find((d) => d.drug === drug);

// ---------------------------------------------------------------------------
// Setup and target cards

function fillDrugDependentFields() {
  const drug = el.drug.value;
  const preset = SYRINGE_PRESETS[drug];
  const info = drugInfo(drug);
  el.concentration.innerHTML = "";
  for (const v of preset.values) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = `${v} ${preset.units}`;
    if (v === preset.initial) opt.selected = true;
    el.concentration.appendChild(opt);
  }
  for (const span of document.querySelectorAll(".syringe-units")) span.textContent = preset.units;
  el.bolusUnits.textContent = info.massUnits;
  el.bolusAmount.value = drug === "propofol" ? "20" : "50";
  el.targetUnits.textContent = info.concentrationUnits;
  el.targetRange.textContent = `Typical ${info.typicalRange.lower} to ${info.typicalRange.upper} ${info.concentrationUnits} ` +
    `(${info.typicalTarget} is typical; above ${info.targetCeiling} the API refuses the target). A target of 0 stops the infusion.`;
  el.targetValue.value = String(info.typicalTarget);
  el.syringeTold.value = String(preset.initial);
  el.syringeTrue.value = String(preset.initial * 2);
  el.apiEndpoint.textContent = `POST /tci/v1/drugs/${drug}/rate`;
}

function numberField(input, name, { min = -Infinity, max = Infinity, openMin = false } = {}) {
  const v = Number(input.value);
  if (input.value.trim() === "" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < min || (openMin && v <= min)) throw new Error(`${name} must be ${openMin ? "greater than" : "at least"} ${min}`);
  if (v > max) throw new Error(`${name} must be at most ${max}`);
  return v;
}

function readSetup() {
  const drug = el.drug.value;
  const preset = SYRINGE_PRESETS[drug];
  const s = {
    drug,
    patient: {
      weight: numberField(el.weight, "Weight", { min: 0.1, max: 500 }),
      height: numberField(el.height, "Height", { min: 10, max: 200 }),
      age: numberField(el.age, "Age", { min: 0, max: 90 }),
      sex: el.sex.value,
    },
    syringe: { concentration: Number(el.concentration.value), units: preset.units },
    syringeVolume: numberField(el.syringeVolume, "Syringe volume", { min: 0, openMin: true }),
    limits: {
      maxRate: numberField(el.maxRate, "Maximum rate", { min: 0, openMin: true, max: 1e5 }),
      minRate: numberField(el.minRate, "Minimum rate", { min: 0 }),
      rateResolution: numberField(el.rateResolution, "Rate resolution", { min: 0, openMin: true }),
    },
    declaredLatency: numberField(el.declaredLatency, "Declared latency", { min: 0 }),
    actualLatency: numberField(el.actualLatency, "Actual latency", { min: 0 }),
    interval: numberField(el.interval, "Interval", { min: 1, max: 60 }),
    multiplier: Number(el.multiplier.value) || 1,
    transport: el.transport.value,
    baseUrl: el.baseUrl.value.trim(),
  };
  if (s.limits.minRate >= s.limits.maxRate) throw new Error("Minimum rate must be below the maximum rate");
  if (s.limits.rateResolution > s.limits.maxRate / 10) throw new Error("Rate resolution must be at most a tenth of the maximum rate");
  if (s.declaredLatency >= s.interval) throw new Error("Declared latency must be less than the interval (the API's LATENCY_INVALID)");
  if (s.transport === "http" && !/^https?:\/\//.test(s.baseUrl)) throw new Error("Enter the server URL, beginning with http:// or https://");
  return s;
}

function readTarget() {
  const site = el.targetForm.elements.site.value;
  const value = numberField(el.targetValue, "Target", { min: 0 });
  const info = drugInfo(el.drug.value);
  if (value > info.targetCeiling) {
    throw new Error(`${value} ${info.concentrationUnits} is above the API's ceiling of ${info.targetCeiling} ` +
      `(five times the library's upper typical target): the server would refuse it (TARGET_OUT_OF_RANGE)`);
  }
  return { site, value };
}

function showError(node, message) {
  node.textContent = message || "";
}

function setRunningUi(running) {
  const lock = [el.drug, el.concentration, el.weight, el.height, el.age, el.sex, el.maxRate, el.minRate,
    el.rateResolution, el.syringeVolume, el.declaredLatency, el.actualLatency, el.interval, el.transport, el.baseUrl];
  for (const input of lock) input.disabled = running;
  el.start.disabled = running;
  el.stop.disabled = !running;
  const teaching = [el.handBolus, el.pauseResume, el.dropNext, el.changeSyringe, el.latencySlider];
  for (const b of teaching) b.disabled = !running;
}

// ---------------------------------------------------------------------------
// Starting and stopping a case

function startCase(event) {
  if (event) event.preventDefault();
  showError(el.setupError, "");
  showError(el.targetError, "");
  let settings;
  try {
    settings = readSetup();
  } catch (e) {
    showError(el.setupError, e.message);
    return;
  }
  let target = null;
  try {
    target = readTarget();
  } catch (e) {
    showError(el.targetError, `${e.message}. The case starts without a target; set one to begin.`);
  }
  if (app.pump) teardownPump();

  const clock = new SimClock(settings.multiplier);
  const transport = makeTransport({ mode: settings.transport, baseUrl: settings.baseUrl });
  let pump;
  try {
    pump = new FauxPump({
      drug: settings.drug,
      patient: settings.patient,
      syringe: settings.syringe,
      syringeVolume: settings.syringeVolume,
      limits: settings.limits,
      declaredLatency: settings.declaredLatency,
      actualLatency: settings.actualLatency,
      interval: settings.interval,
      target: target && target.value > 0 ? target : { site: target ? target.site : "effect", value: 0 },
      clock,
      transport,
      requestIdPrefix: "fauxtci",
    });
  } catch (e) {
    showError(el.setupError, e.message);
    return;
  }
  app.pump = pump;
  app.clock = clock;
  app.running = true;
  app.ending = false;
  resetViews();
  el.apiTransport.textContent = transport.label;
  el.apiEndpoint.textContent = `POST /tci/v1/drugs/${settings.drug}/rate`;
  el.latencySlider.value = String(Math.min(SLIDER_MAX_LATENCY, settings.actualLatency));
  el.latencyReadout.textContent = `${settings.actualLatency} s`;
  app.unsubscribe = pump.onExchange(onExchange);
  app.caseStartMs = clock.now();
  pump.start();
  app.caseStartMs = pump.snapshot().caseStart;
  setRunningUi(true);
  startTicker();
  refresh(true);
}

function stopCase() {
  if (!app.pump || !app.running || app.ending) return;
  app.ending = true;
  app.endDeadline = perfNow() + 5000;
  el.stop.disabled = true;
  try {
    app.pump.stop();
  } catch (e) {
    showError(el.setupError, `Stop failed: ${e.message}`);
    finishEnding();
    return;
  }
  refresh(true);
  // The ticker finishes the ending once the target-0 response has landed.
}

function finishEnding() {
  app.ending = false;
  app.running = false;
  stopTicker();
  if (app.clock) app.clock.freeze();
  setRunningUi(false);
  refresh(true);
}

function teardownPump() {
  stopTicker();
  if (app.unsubscribe) app.unsubscribe();
  app.unsubscribe = null;
  app.pump = null;
  app.clock = null;
  app.running = false;
  app.ending = false;
}

function startTicker() {
  stopTicker();
  app.ticker = setInterval(onTick, TICK_MS);
}

function stopTicker() {
  if (app.ticker !== null) clearInterval(app.ticker);
  app.ticker = null;
}

function onTick() {
  const pump = app.pump;
  if (!pump || !app.running) return;
  try {
    pump.tick();
  } catch (e) {
    showError(el.setupError, `The pump raised an error: ${e.message}`);
  }
  refresh(false);
  if (app.ending) {
    const snap = pump.snapshot();
    if (!snap.inFlight || perfNow() > app.endDeadline) finishEnding();
  }
}

// Render everything from one snapshot; the charts at most once a second
// unless forced.
function refresh(force) {
  const pump = app.pump;
  if (!pump) {
    drawCharts(null);
    return;
  }
  const snap = pump.snapshot();
  updateFace(snap);
  updateTeaching(snap);
  updateRecord(snap);
  updateWire(snap);
  const now = perfNow();
  if (force || now - app.lastDraw >= CHART_MS) {
    app.lastDraw = now;
    drawCharts(snap);
  }
}

function resetViews() {
  app.cards.clear();
  app.fullCardIds = [];
  app.logLines.clear();
  el.apiCards.innerHTML = "";
  el.wireLog.innerHTML = "";
  el.apiEmpty.hidden = false;
  el.apiCount.textContent = "0 exchanges";
  app.recordRendered = { length: 0, lastKey: null };
  el.recordBody.innerHTML = "";
  el.recordEmpty.hidden = false;
  app.wireKey = null;
  app.wireRequestId = null;
  el.wireRequest.textContent = "(none)";
  el.wireResponse.textContent = "(none)";
  el.wireRequestId.textContent = "";
  el.wireResponseId.textContent = "";
  el.wireResponseStatus.textContent = "";
  el.wireStatus.textContent = "No request yet.";
  app.lastPhase = null;
  app.lastAlarm = null;
  el.alarm.textContent = "";
  app.lastDraw = 0;
}

// ---------------------------------------------------------------------------
// The pump face

function updateFace(snap) {
  const decimals = rateDecimals(snap.config.limits.rateResolution);
  el.rateValue.textContent = snap.rate.toFixed(decimals);
  el.rateUnits.textContent = snap.rateUnits;
  // The mass rate beneath: mg/hr for a mg drug, mcg/min for a mcg drug (the
  // library's infusion units), and mcg/kg/min for both.
  const base = snap.massRate; // base units per minute
  const weight = snap.config.patient.weight;
  const massUnits = snap.config.massUnits;
  const perKg = massUnits === "mg" ? base * 1000 / weight : base / weight;
  const massText = massUnits === "mg" ? `${sig(base * 60, 4)} mg/hr` : `${sig(base, 4)} mcg/min`;
  el.massRate.textContent = `${massText} ${MIDDOT} ${sig(perKg, 3)} mcg/kg/min`;

  const lampState = snap.state === "running" && snap.rate === 0 && snap.phaseCode !== "loading" ? "running" : snap.state;
  el.lamp.dataset.state = snap.started ? lampState : "standby";
  if (snap.phase !== app.lastPhase) {
    el.phase.textContent = snap.phase;
    el.phase.classList.toggle("is-alarm", snap.phaseCode === "alarm");
    el.phase.classList.toggle("is-paused", snap.phaseCode === "paused");
    app.lastPhase = snap.phase;
  }
  const planWord = snap.plan === "effectSite" ? "effect-site plan" : snap.plan === "plasma" ? "plasma hold" : snap.plan === "off" ? "plan: off" : "";
  el.plan.textContent = snap.started && snap.plan ? `(${planWord})` : "";

  let alarmText = "";
  if (snap.state === "alarm" && snap.alarms.length) {
    alarmText = `ALARM: ${snap.alarms[snap.alarms.length - 1].message}. Set a target or press Resume to restart.`;
  }
  if (alarmText !== app.lastAlarm) {
    el.alarm.textContent = alarmText;
    app.lastAlarm = alarmText;
  }

  const seg = snap.segment;
  if (seg && seg.phase === "hold") {
    const total = seg.holdUntil - seg.startsAt;
    const left = snap.holdRemaining === null ? 0 : snap.holdRemaining;
    const frac = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 1;
    el.holdFill.style.width = `${(frac * 100).toFixed(1)}%`;
    el.holdProgress.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
    el.holdProgress.classList.remove("is-fallback");
    el.holdLabel.textContent = "Hold";
    el.holdCountdown.textContent = `${left.toFixed(1)} s of ${sig(total, 3)} s left`;
  } else if (seg && seg.phase === "fallback") {
    const total = seg.fallbackUntil - seg.holdUntil;
    const left = snap.fallbackRemaining === null ? 0 : snap.fallbackRemaining;
    const frac = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 1;
    el.holdFill.style.width = `${(frac * 100).toFixed(1)}%`;
    el.holdProgress.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
    el.holdProgress.classList.add("is-fallback");
    el.holdLabel.textContent = "Fallback";
    el.holdCountdown.textContent = `${left.toFixed(1)} s left, then the pump stops and alarms`;
  } else {
    el.holdFill.style.width = "0%";
    el.holdProgress.setAttribute("aria-valuenow", "0");
    el.holdProgress.classList.remove("is-fallback");
    el.holdLabel.textContent = "Segment";
    el.holdCountdown.textContent = snap.state === "paused" ? "paused" : snap.started ? "no command running" : "not started";
  }
  el.fallbackRate.textContent = snap.fallbackRate === null ? DASH : `${snap.fallbackRate.toFixed(decimals)} ${snap.rateUnits}`;

  if (snap.inFlight) {
    el.nextRequest.textContent = `awaiting ${snap.inFlight.id}`;
  } else if (snap.nextRequestIn === null) {
    el.nextRequest.textContent = snap.started ? "not scheduled" : DASH;
  } else {
    el.nextRequest.textContent = `${snap.nextRequestIn.toFixed(1)} s`;
  }
  el.caseClock.textContent = clockText(snap.caseSeconds);
  el.simClock.textContent = snap.time === null ? DASH : utcClock(snap.time);
  el.syringeRemaining.textContent = `${snap.syringeRemaining.toFixed(1)} of ${snap.config.syringeVolume} mL`;
  el.timeToEmpty.textContent = snap.timeToEmpty === null ? (snap.rate === 0 ? "pump off" : DASH) : durationText(snap.timeToEmpty);
  const cu = snap.config.concentrationUnits;
  el.ceReadout.textContent = `${sig(snap.truth.ce, 3)} / ${sig(snap.predicted.ce, 3)} ${cu}`;
  el.cpReadout.textContent = `${sig(snap.truth.cp, 3)} ${cu}`;
  el.targetReadout.textContent = `${snap.target.value} ${cu} (${snap.target.site === "effect" ? "effect site" : "plasma"})`;
}

function updateTeaching(snap) {
  el.pauseResume.textContent = snap.state === "running" ? "Pause" : "Resume";
  el.dropNext.setAttribute("aria-pressed", snap.dropNext ? "true" : "false");
  el.dropState.textContent = snap.dropNext ? "armed: the next response will be lost" : "";
}

// ---------------------------------------------------------------------------
// The delivery record

function recordRow(e, caseStartMs) {
  const whenMs = Date.parse(e.time !== undefined ? e.time : e.from);
  const t = clockText((whenMs - caseStartMs) / 1000, true);
  if (e.rate !== undefined) return [t, "rate change", String(e.rate), e.units, e.source || ""];
  if (e.bolus !== undefined) return [t, "hand bolus", String(e.bolus), e.units, e.source || ""];
  if (e.infusate !== undefined) return [t, "syringe", String(e.infusate.concentration), e.infusate.units, e.source || "initial"];
  if (e.delivered !== undefined) return [t, "delivered segment", String(e.delivered), e.units, e.source || ""];
  return [t, "event", "", "", ""];
}

function rowKey(e) {
  return JSON.stringify(e);
}

function updateRecord(snap) {
  const record = snap.record;
  const n = record.length;
  el.recordEmpty.hidden = n > 0;
  const lastKey = n ? rowKey(record[n - 1]) : null;
  if (n === app.recordRendered.length && lastKey === app.recordRendered.lastKey) return;
  const tbody = el.recordBody;
  // The pump may rewrite or remove its last rate event (two changes at one
  // instant), so the tail is re-rendered; the rest is appended.
  if (n < app.recordRendered.length || (n === app.recordRendered.length)) {
    tbody.innerHTML = "";
    app.recordRendered.length = 0;
  } else if (app.recordRendered.length > 0 && tbody.lastElementChild) {
    tbody.removeChild(tbody.lastElementChild);
    app.recordRendered.length -= 1;
  }
  const frag = document.createDocumentFragment();
  for (let i = app.recordRendered.length; i < n; i++) {
    const tr = document.createElement("tr");
    for (const cell of recordRow(record[i], app.caseStartMs)) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  app.recordRendered = { length: n, lastKey };
}

// ---------------------------------------------------------------------------
// The wire panes

// The newest exchange that has an answer (status set), or null.  The newest
// exchange of all is usually still pending at speed (at 60x a request is
// sent every 167 ms of wall time and answered a macrotask later), so a
// response pane keyed to it would read "(no body)" most of the time.
function lastAnswered(exchanges) {
  for (let i = exchanges.length - 1; i >= 0 && i >= exchanges.length - 50; i--) {
    if (exchanges[i].status !== null) return exchanges[i];
  }
  return null;
}

function updateWire(snap) {
  const x = snap.lastExchange;
  if (!x) return;
  const answered = lastAnswered(snap.exchanges);
  const key = `${x.id}|${x.outcome}|${x.status}|${answered ? `${answered.id}|${answered.outcome}` : ""}`;
  if (key === app.wireKey) return;
  app.wireKey = key;
  if (x.id !== app.wireRequestId) {
    renderJsonInto(el.wireRequest, x.request, { collapseHistory: false });
    el.wireRequestId.textContent = x.id;
    app.wireRequestId = x.id;
  }
  // The response pane shows the newest answer, labelled with its own
  // requestId so the two panes are never mistaken for one pair.
  renderJsonInto(el.wireResponse, answered ? answered.response : null, {});
  el.wireResponseId.textContent = answered ? answered.id : "";
  const answeredStatus = answered ? String(answered.status) : "";
  el.wireResponseStatus.textContent = answeredStatus;
  el.wireResponseStatus.classList.toggle("is-error", answered !== null && answered.status !== 200);
  const statusText = x.status === null ? "pending" : String(x.status);
  const rt = snap.config.transport === "http"
    ? (x.roundTripMs === null ? "round trip pending" : `round trip ${Math.round(x.roundTripMs)} ms`)
    : "in page, no network";
  el.wireStatus.textContent = `${snap.config.transportLabel} ${MIDDOT} ${x.path} ${MIDDOT} ${x.id} ` +
    `sent at ${clockText((x.caseTimeSent - app.caseStartMs) / 1000, true)} ${MIDDOT} status ${statusText} ${MIDDOT} ${x.outcome} ${MIDDOT} ${rt}`;
}

// ---------------------------------------------------------------------------
// The API conversation panel

const OUTCOME_WORDS = Object.freeze({
  applied: "applied", pending: "pending", dropped: "dropped", "late-discarded": "late",
  superseded: "superseded", error: "error", "no-response": "no response",
});

const caseTime = (ms) => clockText((ms - app.caseStartMs) / 1000, true);

function onExchange(x) {
  if (!app.pump) return;
  const card = app.cards.get(x.id);
  if (card) {
    if (card.dataset.compact === "1") fillCompactCard(card, x);
    else patchCard(card, x);
    // A patched card grows (the response and its reading arrive after the
    // request), so following means re-scrolling here too, or at 1x the
    // newest card's response sits below the fold until the next card.
    if (app.follow) scrollCardsToEnd();
  } else {
    const li = buildCard(x);
    app.cards.set(x.id, li);
    app.fullCardIds.push(x.id);
    el.apiCards.appendChild(li);
    el.apiEmpty.hidden = true;
    trimCards();
    if (app.follow) scrollCardsToEnd();
  }
  el.apiCount.textContent = `${app.pump.snapshot().requestCount} exchanges`;
  updateLog(x);
}

function buildCard(x) {
  const li = document.createElement("li");
  li.className = "xcard";
  li.dataset.id = x.id;
  li._exchange = x;
  li.innerHTML =
    '<div class="xcard-head"><span class="xcard-id"></span> <span class="xcard-time"></span> ' +
    '<span class="badge"></span> <span class="xcard-status"></span></div>' +
    '<div class="xcard-path"></div>' +
    '<details class="xcard-request"><summary>Request body</summary><pre class="json" tabindex="0"></pre></details>' +
    '<div class="xcard-response"><details class="xcard-response-details"><summary>Response body</summary><pre class="json" tabindex="0"></pre></details>' +
    '<p class="xcard-summary"></p><ul class="xcard-warnings" hidden></ul><ul class="xcard-errors" hidden></ul></div>' +
    '<p class="xcard-timing"></p>';
  li.querySelector(".xcard-id").textContent = x.id;
  li.querySelector(".xcard-time").textContent = caseTime(x.caseTimeSent);
  li.querySelector(".xcard-path").textContent = x.path;
  const req = li.querySelector(".xcard-request");
  if (app.fullJson) {
    req.open = true;
    renderJsonInto(req.querySelector("pre"), x.request, { collapseHistory: true });
  }
  patchCard(li, x);
  return li;
}

// Bring a full card up to date with the exchange's outcome and response.
function patchCard(li, x) {
  li._exchange = x;
  const badge = li.querySelector(".badge");
  badge.textContent = OUTCOME_WORDS[x.outcome] || x.outcome;
  badge.className = `badge badge-${x.outcome}`;
  const status = li.querySelector(".xcard-status");
  status.textContent = x.status === null ? "" : String(x.status);
  status.classList.toggle("is-error", x.status !== null && x.status !== 200);
  const isError = x.outcome === "error" || x.outcome === "no-response" || (x.status !== null && x.status !== 200);
  const summary = li.querySelector(".xcard-summary");
  summary.textContent = x.summary;
  summary.classList.toggle("is-error", isError);
  const details = li.querySelector(".xcard-response-details");
  const summaryLabel = details.querySelector("summary");
  summaryLabel.textContent = x.status === null ? "Response body (pending)" : `Response body (${x.status})`;
  details.hidden = x.status === null;
  if (x.status !== null && (app.fullJson || details.open)) {
    details.open = true;
    renderJsonInto(details.querySelector("pre"), x.response, {});
    details.dataset.rendered = x.outcome;
  }
  const warnings = li.querySelector(".xcard-warnings");
  const errors = li.querySelector(".xcard-errors");
  warnings.innerHTML = "";
  errors.innerHTML = "";
  const body = x.response;
  if (body && Array.isArray(body.warnings) && body.warnings.length) {
    for (const w of body.warnings) {
      const item = document.createElement("li");
      item.textContent = `${w.code}: ${w.message}`;
      warnings.appendChild(item);
    }
  }
  if (body && Array.isArray(body.errors) && body.errors.length) {
    for (const e of body.errors) {
      const item = document.createElement("li");
      item.textContent = `${e.code}${e.pointer ? ` at ${e.pointer}` : ""}: ${e.message}`;
      errors.appendChild(item);
    }
  }
  warnings.hidden = warnings.childElementCount === 0;
  errors.hidden = errors.childElementCount === 0;
  li.querySelector(".xcard-timing").textContent = timingText(x);
}

function timingText(x) {
  const parts = [`sent ${caseTime(x.caseTimeSent)}`];
  if (x.caseTimeReceived !== null) parts.push(`received ${caseTime(x.caseTimeReceived)}`);
  if (x.caseTimeApplied !== null) parts.push(`applied to the pump ${caseTime(x.caseTimeApplied)}`);
  if (x.declaredLatency !== x.actualLatency) parts.push(`declared ${x.declaredLatency} s, actual ${x.actualLatency} s`);
  if (x.roundTripMs !== null && x.roundTripMs !== undefined && x.roundTripMs > 0) parts.push(`round trip ${Math.round(x.roundTripMs)} ms`);
  return parts.join(` ${MIDDOT} `);
}

// Older cards become a single line each.
function trimCards() {
  while (app.fullCardIds.length > FULL_CARDS) {
    const id = app.fullCardIds.shift();
    const li = app.cards.get(id);
    if (!li) continue;
    const x = li._exchange;
    li.className = "xline";
    li.dataset.compact = "1";
    li.innerHTML = "";
    fillCompactCard(li, x);
  }
}

function fillCompactCard(li, x) {
  li._exchange = x;
  li.textContent = `${x.id} ${caseTime(x.caseTimeSent)} ${OUTCOME_WORDS[x.outcome] || x.outcome} ` +
    `${x.status === null ? "" : x.status} ${x.summary}`;
}

function scrollCardsToEnd() {
  app.programmaticScroll = true;
  el.apiCards.scrollTop = el.apiCards.scrollHeight;
  requestAnimationFrame(() => { app.programmaticScroll = false; });
}

function setJsonMode(full) {
  app.fullJson = full;
  el.apiMode.setAttribute("aria-pressed", full ? "true" : "false");
  el.apiMode.textContent = full ? "Summaries only" : "Full JSON";
  el.apiMode.title = full ? "Collapse the request and response bodies" : "Show every request and response body expanded";
  for (const li of app.cards.values()) {
    if (li.dataset.compact === "1") continue;
    const x = li._exchange;
    const req = li.querySelector(".xcard-request");
    const res = li.querySelector(".xcard-response-details");
    if (full) {
      if (!req.open) { req.open = true; renderJsonInto(req.querySelector("pre"), x.request, { collapseHistory: true }); }
      if (x.status !== null && !res.open) { res.open = true; renderJsonInto(res.querySelector("pre"), x.response, {}); }
    } else {
      req.open = false;
      res.open = false;
    }
  }
}

// Lazy rendering: a block is rendered when its <details> opens (toggle does
// not bubble, so it is caught in the capture phase).
el.apiCards.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  const li = details.closest(".xcard");
  if (!li || !li._exchange) return;
  const x = li._exchange;
  const pre = details.querySelector("pre");
  if (details.classList.contains("xcard-request")) {
    if (!pre.innerHTML) renderJsonInto(pre, x.request, { collapseHistory: true });
  } else if (details.dataset.rendered !== x.outcome || !pre.innerHTML) {
    renderJsonInto(pre, x.response, {});
    details.dataset.rendered = x.outcome;
  }
}, true);

el.apiCards.addEventListener("click", (event) => {
  const button = event.target.closest(".json-expand");
  if (!button) return;
  const li = button.closest(".xcard");
  const pre = button.closest("pre");
  if (!li || !li._exchange || !pre) return;
  renderJsonInto(pre, li._exchange.request, { collapseHistory: false });
});

// Scrolling up pauses following; scrolling back to the bottom resumes it.
// Only a decrease in scrollTop counts as scrolling up: a card growing (a
// body expanded) also fires a scroll event, and must not stop the follow.
let lastScrollTop = 0;
el.apiCards.addEventListener("scroll", () => {
  const list = el.apiCards;
  const top = list.scrollTop;
  const fromBottom = list.scrollHeight - top - list.clientHeight;
  const atBottom = fromBottom < 40;
  const scrolledUp = top < lastScrollTop - 2;
  lastScrollTop = top;
  if (app.programmaticScroll) return;
  if (scrolledUp && !atBottom && app.follow) {
    app.follow = false;
    el.apiFollow.checked = false;
  } else if (atBottom && !app.follow) {
    app.follow = true;
    el.apiFollow.checked = true;
  }
});

el.apiFollow.addEventListener("change", () => {
  app.follow = el.apiFollow.checked;
  if (app.follow) scrollCardsToEnd();
});

el.apiMode.addEventListener("click", () => setJsonMode(!app.fullJson));

el.apiCopy.addEventListener("click", () => {
  const exchanges = app.pump ? app.pump.snapshot().exchanges : [];
  copyText(JSON.stringify(exchanges, null, 2), el.apiCopy);
});

el.apiClear.addEventListener("click", () => {
  app.cards.clear();
  app.fullCardIds = [];
  el.apiCards.innerHTML = "";
  el.apiEmpty.hidden = false;
  el.apiEmpty.textContent = "Cleared. New exchanges will appear here.";
});

// The narrow-screen collapse of the panel.
el.apiToggle.addEventListener("click", () => {
  const open = el.apiToggle.getAttribute("aria-expanded") === "true";
  el.apiToggle.setAttribute("aria-expanded", open ? "false" : "true");
  el.apiToggle.textContent = open ? "Show" : "Hide";
  el.apiBody.hidden = open;
});
const wideQuery = window.matchMedia("(min-width: 1100px)");
const onWideChange = () => {
  if (wideQuery.matches && el.apiBody.hidden) {
    el.apiBody.hidden = false;
    el.apiToggle.setAttribute("aria-expanded", "true");
    el.apiToggle.textContent = "Hide";
  }
};
if (wideQuery.addEventListener) wideQuery.addEventListener("change", onWideChange);

// The exchange log under the wire panes: one line per exchange.
function updateLog(x) {
  let li = app.logLines.get(x.id);
  if (!li) {
    li = document.createElement("li");
    app.logLines.set(x.id, li);
    el.wireLog.appendChild(li);
    while (el.wireLog.childElementCount > LOG_LINES) {
      const first = el.wireLog.firstElementChild;
      for (const [id, node] of app.logLines) if (node === first) { app.logLines.delete(id); break; }
      el.wireLog.removeChild(first);
    }
  }
  li.textContent = `${x.id} ${caseTime(x.caseTimeSent)} ${OUTCOME_WORDS[x.outcome] || x.outcome}` +
    `${x.status === null ? "" : ` ${x.status}`} ${MIDDOT} ${x.summary}`;
  el.wireLog.scrollTop = el.wireLog.scrollHeight;
}

// ---------------------------------------------------------------------------
// The charts

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme(drug) {
  return {
    drug: cssVar(drug === "remifentanil" ? "--series-remifentanil" : "--series-propofol") || "#ffcc00",
    target: cssVar("--series-target") || "#6b7580",
    rate: cssVar("--series-rate") || "#2f6fd1",
    ceiling: cssVar("--series-ceiling") || "#9aa3ad",
    grid: cssVar("--grid") || "#e4e8ee",
    axis: cssVar("--axis") || "#5b6470",
    text: cssVar("--text") || "#1b1f24",
    surface: cssVar("--surface") || "#ffffff",
  };
}

// 1, 2, 2.5, 5 or 10 times a power of ten, at or above v.
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * Math.pow(10, exp);
}

function xStep(maxMinutes) {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 240]) if (maxMinutes / step <= 8) return step;
  return 480;
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(rect.width));
  const h = Math.max(10, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const PAD = Object.freeze({ left: 46, right: 12, top: 10, bottom: 24 });

// Axes, grid and tick labels; returns the mapping functions.
function axes(ctx, w, h, xMax, yMax, yLabel, colours, yFormat) {
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  const X = (minutes) => PAD.left + (minutes / xMax) * plotW;
  const Y = (v) => PAD.top + plotH - (v / yMax) * plotH;
  ctx.font = "11px system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.strokeStyle = colours.grid;
  ctx.fillStyle = colours.axis;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax * i) / yTicks;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(w - PAD.right, y);
    ctx.stroke();
    ctx.fillText(yFormat(v), PAD.left - 6, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = xStep(xMax);
  for (let m = 0; m <= xMax + 1e-9; m += step) {
    const x = X(m);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.fillText(Number(m.toFixed(2)).toString(), x, PAD.top + plotH + 5);
  }
  ctx.strokeStyle = colours.axis;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + plotH);
  ctx.lineTo(w - PAD.right, PAD.top + plotH);
  ctx.stroke();
  ctx.save();
  ctx.translate(12, PAD.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("minutes", w - PAD.right, h - 2);
  return { X, Y, plotW, plotH };
}

// A polyline through the series, skipping points that land on the same
// pixel; with `step` true a horizontal run precedes each change (a rate).
function polyline(ctx, series, X, Y, field, step = false) {
  let started = false;
  let lastPx = NaN;
  let lastPy = NaN;
  let lastY = NaN;
  ctx.beginPath();
  for (const p of series) {
    const v = p[field];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const x = X(p.time / 60);
    const y = Y(v);
    const px = Math.round(x * 2) / 2;
    const py = Math.round(y * 2) / 2;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      if (px === lastPx && py === lastPy) continue;
      if (step && py !== lastPy) ctx.lineTo(x, lastY);
      ctx.lineTo(x, y);
    }
    lastPx = px;
    lastPy = py;
    lastY = y;
  }
  ctx.stroke();
}

function drawCharts(snap) {
  const colours = theme(snap ? snap.config.drug : el.drug.value);
  el.swatchTrue.style.color = colours.drug;
  el.swatchPredicted.style.color = colours.drug;
  el.swatchCp.style.color = colours.drug;
  el.swatchTarget.style.color = colours.target;
  const series = snap ? snap.series : [];
  const lastTime = series.length ? series[series.length - 1].time : 0;
  const xMax = Math.max(2, niceCeil(lastTime / 60 + 1e-9));
  drawCe(snap, series, xMax, colours);
  drawRate(snap, series, xMax, colours);
  if (snap) {
    el.chartSummary.textContent = `Time axis in minutes of case time. True Ce ${sig(snap.truth.ce, 3)}, predicted ${sig(snap.predicted.ce, 3)} ` +
      `${snap.config.concentrationUnits}; peak true Ce so far ${sig(snap.maxTrueCe, 4)} at ${clockText((snap.maxTrueCeAt - snap.caseStart) / 1000)}. The charts redraw once a second.`;
  }
}

function drawCe(snap, series, xMax, colours) {
  const { ctx, w, h } = prepareCanvas(el.chartCe);
  let maxCe = 0;
  let maxTarget = 0;
  for (const p of series) {
    if (p.trueCe > maxCe) maxCe = p.trueCe;
    if (p.predictedCe > maxCe) maxCe = p.predictedCe;
    if (p.target > maxTarget) maxTarget = p.target;
  }
  const target = snap ? snap.target.value : 0;
  const units = snap ? snap.config.concentrationUnits : drugInfo(el.drug.value).concentrationUnits;
  const yMax = niceCeil(Math.max(maxCe * 1.15, Math.max(maxTarget, target) * 1.25, 0.1));
  const { X, Y, plotW, plotH } = axes(ctx, w, h, xMax, yMax, units, colours, (v) => sig(v, 3));
  if (!series.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();
  // The target, a thin step line (it changes when the target is re-set).
  ctx.strokeStyle = colours.target;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  polyline(ctx, series, X, Y, "target", true);
  // True plasma, lighter.
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = colours.drug;
  ctx.lineWidth = 1.5;
  polyline(ctx, series, X, Y, "trueCp");
  ctx.globalAlpha = 1;
  // Predicted effect site, dashed.
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  polyline(ctx, series, X, Y, "predictedCe");
  // True effect site, solid.
  ctx.setLineDash([]);
  ctx.lineWidth = 2.5;
  polyline(ctx, series, X, Y, "trueCe");
  ctx.restore();
}

function drawRate(snap, series, xMax, colours) {
  const { ctx, w, h } = prepareCanvas(el.chartRate);
  let maxRate = 0;
  for (const p of series) if (p.rate > maxRate) maxRate = p.rate;
  const ceiling = snap ? snap.config.limits.maxRate : Number(el.maxRate.value) || 0;
  const yMax = niceCeil(Math.max(maxRate * 1.08, 10));
  const { X, Y, plotW, plotH } = axes(ctx, w, h, xMax, yMax, "mL/hr", colours, (v) => String(Number(v.toFixed(1))));
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();
  if (ceiling > 0 && ceiling <= yMax) {
    ctx.strokeStyle = colours.ceiling;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, Y(ceiling));
    ctx.lineTo(w - PAD.right, Y(ceiling));
    ctx.stroke();
  }
  if (series.length) {
    ctx.setLineDash([]);
    ctx.strokeStyle = colours.rate;
    ctx.lineWidth = 2;
    polyline(ctx, series, X, Y, "rate", true);
  }
  ctx.restore();
  if (ceiling > yMax) {
    ctx.fillStyle = colours.axis;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`maximum rate ${ceiling} mL/hr, above the chart`, w - PAD.right - 4, PAD.top + 2);
  }
}

// ---------------------------------------------------------------------------
// Wiring

el.drug.addEventListener("change", fillDrugDependentFields);
el.transport.addEventListener("change", () => {
  el.httpFields.hidden = el.transport.value !== "http";
  el.apiTransport.textContent = el.transport.value === "http"
    ? `HTTP: ${el.baseUrl.value.trim() || "(URL not set)"}` : LOCAL_TRANSPORT_LABEL;
});
el.baseUrl.addEventListener("input", () => {
  if (el.transport.value === "http") el.apiTransport.textContent = `HTTP: ${el.baseUrl.value.trim() || "(URL not set)"}`;
});
el.multiplier.addEventListener("change", () => {
  if (app.clock) app.clock.setMultiplier(Number(el.multiplier.value) || 1);
});
el.form.addEventListener("submit", startCase);
el.stop.addEventListener("click", stopCase);

el.targetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showError(el.targetError, "");
  let t;
  try {
    t = readTarget();
  } catch (e) {
    showError(el.targetError, e.message);
    return;
  }
  if (!app.pump || !app.running) {
    showError(el.targetError, "The target will be used when the case starts. Press Start.");
    return;
  }
  try {
    app.pump.setTarget(t.value, t.site);
  } catch (e) {
    showError(el.targetError, e.message);
    return;
  }
  refresh(true);
});
el.targetZero.addEventListener("click", () => {
  el.targetValue.value = "0";
  el.setTarget.click();
});

el.handBolus.addEventListener("click", () => {
  if (!app.pump || !app.running) return;
  showError(el.targetError, "");
  try {
    app.pump.handBolus(numberField(el.bolusAmount, "Bolus", { min: 0, openMin: true }));
  } catch (e) {
    showError(el.setupError, e.message);
  }
  refresh(true);
});
el.pauseResume.addEventListener("click", () => {
  if (!app.pump || !app.running) return;
  const state = app.pump.snapshot().state;
  if (state === "running") app.pump.pause(); else app.pump.resume();
  refresh(true);
});
el.dropNext.addEventListener("click", () => {
  if (!app.pump || !app.running) return;
  app.pump.dropNextResponse();
  refresh(true);
});
el.changeSyringe.addEventListener("click", () => {
  if (!app.pump || !app.running) return;
  try {
    const told = numberField(el.syringeTold, "Told concentration", { min: 0, openMin: true });
    const actual = numberField(el.syringeTrue, "Actual concentration", { min: 0, openMin: true });
    app.pump.changeSyringe(told, actual);
  } catch (e) {
    showError(el.setupError, e.message);
  }
  refresh(true);
});
el.latencySlider.max = String(SLIDER_MAX_LATENCY);
el.latencySlider.addEventListener("input", () => {
  const v = Number(el.latencySlider.value);
  el.latencyReadout.textContent = `${v.toFixed(1)} s`;
  el.actualLatency.value = String(v);
  if (app.pump && app.running) app.pump.setActualLatency(v);
});

el.recordCopy.addEventListener("click", () => {
  const record = app.pump ? app.pump.snapshot().record : [];
  copyText(JSON.stringify(record, null, 2), el.recordCopy);
});
el.recordDownload.addEventListener("click", () => {
  if (!app.pump) { flashButton(el.recordDownload, "No case yet"); return; }
  const csv = app.pump.exportDoseTableCsv();
  downloadText(`fauxtci-${app.pump.drug}-dose-table.csv`, csv, "text/csv");
});
el.wireCopyRequest.addEventListener("click", () => {
  const x = app.pump ? app.pump.snapshot().lastExchange : null;
  copyText(x && x.request ? JSON.stringify(x.request, null, 2) : "", el.wireCopyRequest);
});
el.wireCopyResponse.addEventListener("click", () => {
  const x = app.pump ? lastAnswered(app.pump.snapshot().exchanges) : null;
  copyText(x && x.response ? JSON.stringify(x.response, null, 2) : "", el.wireCopyResponse);
});

// A hidden tab: the controller sleeps and the clock stands still; back in
// view, the clock jumps and the pump replays the contract over the gap.
document.addEventListener("visibilitychange", () => {
  if (!app.pump || !app.clock || !app.running) return;
  if (document.visibilityState === "hidden") {
    app.clock.freeze();
    stopTicker();
  } else {
    const gap = app.clock.thaw();
    startTicker();
    try {
      app.pump.catchUp(gap);
    } catch (e) {
      showError(el.setupError, `catchUp failed: ${e.message}`);
    }
    refresh(true);
  }
});

// Redraw on resize and on a colour-scheme change.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { app.lastDraw = 0; refresh(true); }, 100);
});
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
if (darkQuery.addEventListener) darkQuery.addEventListener("change", () => refresh(true));

// ---------------------------------------------------------------------------
// Boot

el.aboutVersion.textContent = FAUXTCI_VERSION;
fillDrugDependentFields();
el.httpFields.hidden = el.transport.value !== "http";
setRunningUi(false);
setJsonMode(false);
el.latencyReadout.textContent = `${Number(el.latencySlider.value).toFixed(1)} s`;
drawCharts(null);
