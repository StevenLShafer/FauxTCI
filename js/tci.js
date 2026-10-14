// FauxTCI: the TCI API server, a port of stanpumpR's R/tci-api.R and R/tci.R.
//
// WHAT IT IS
// ==========
// tciNextRate(request) takes the parsed body of docs/tci-api.md section 4 and
// returns the response body of section 6, or throws a TciApiError carrying
// the HTTP status, the code of section 6.3, a message and the JSON pointer of
// the field at fault.  tciApiDrugs() and tciApiModel() are the bodies of the
// two GET endpoints.  The contract is docs/tci-api.md (version 1.0): the field
// names, unit tokens, bounds, error codes and statuses are the R package's,
// unchanged, so a request the R service accepts this module accepts, and the
// numbers agree with the fixtures in test/fixtures/rate-cases.json to the
// tolerances the fixtures' README asks for.
//
// WHY IT IS STATELESS
// ===================
// As in the R: the model state, seven exponential amplitudes (three for the
// plasma, four for the effect site), is rebuilt from the delivery record on
// every call by superposition (each piece of constant rate and each bolus
// contributes independently; see tciStatesFromHistory() in R/tci-api.R), then
// projected through the declared latency at the running rate, planned with
// tciRate() (Shafer & Gregg 1992, with the hand-off to plasma control within
// 5% of the target), clamped and rounded to the pump's limits, and the
// predictions, the fallback and the timing follow from the commanded rate.
//
// WHAT COULD NOT BE PORTED
// ========================
// DUPLICATE_KEY.  The R walks jsonlite's parsed list, which keeps both copies
// of a duplicated key; JSON.parse() keeps only the last, so a duplicate key
// cannot be seen once the body is parsed.  A browser transport that wants the
// check has to run it on the text before parsing; this module documents the
// gap and raises every other error of section 6.3.
//
// UNITS AND TIME
// ==============
// Inside, as in simCpCe() and the R API: minutes and the drug's base mass
// unit (mg for a drug measured in mcg/mL, mcg for one measured in ng/mL), so
// a rate is base/min and a concentration base/L, and the target in the drug's
// concentration units is numerically the target in base/L.  Times arrive as
// RFC 3339 strings on the controller's clock, are parsed to seconds since the
// epoch (a double, as R's POSIXct), and every piece of arithmetic is then done
// in minutes relative to `now`.  The server's own clock is only reported.
//
// Every function names the R function it ports.  The R's vectorised
// validation (one pass per check over all events, so that the FIRST failure
// in the R's order is the one reported) is kept as a sequence of passes.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { resolveModel, advance, DRUG_LIBRARY } from "./pk.js";
import { md5 } from "./md5.js";

// ---------------------------------------------------------------------------
// Constants (the TCI API block at the end of R/constants.R, plus TCI_INTERVAL
// and TCI_PLASMA_SWITCH from the same file).  Within API version 1 nothing
// here changes meaning: a token, a drug or a bound may only be added.

/** This port's own version, reported in `server.version`. */
export const FAUXTCI_VERSION = "0.3.0";

const RATE_UNITS = Object.freeze(["mL/hr", "mg/hr", "mg/min", "mcg/hr", "mcg/min",
  "mg/kg/hr", "mg/kg/min", "mcg/kg/hr", "mcg/kg/min"]);
const AMOUNT_UNITS = Object.freeze(["mL", "mg", "mcg"]);
const BOLUS_UNITS = Object.freeze([...AMOUNT_UNITS, "mg/kg", "mcg/kg"]);
const INFUSATE_UNITS = Object.freeze(["mg/mL", "mcg/mL"]);
const CONCENTRATION_UNITS = Object.freeze(["mcg/mL", "ng/mL"]);
const VOLUME_UNITS = Object.freeze(["mL"]);
const PUMP_STATES = Object.freeze(["running", "paused", "alarm", "occlusion",
  "syringeEmpty", "purging", "standby"]);
const SEX_VALUES = Object.freeze(["male", "female"]);

// TCI_API_TIME_PATTERN, character for character: date and clock fields within
// their RFC 3339 ranges (the 60th second for a leap second), optional
// fractional seconds, and a mandatory Z or numeric offset.
const TIME_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" +
  "[Tt ]([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?" +
  "([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";
const TIME_RE = new RegExp(TIME_PATTERN);
// The same form with the fields captured, for the parse.
const TIME_FIELDS_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?([Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;

/**
 * The API's constants for the page and the pump: version, unit tokens,
 * bounds, pump states, time pattern, drugs and this port's identity.  The
 * names are the R constants' without their TCI_API_ prefix.
 */
export const TCI_API = Object.freeze({
  VERSION: "1.0",
  PACKAGE: "FauxTCI",
  PACKAGE_VERSION: FAUXTCI_VERSION,
  DRUGS: Object.freeze(["propofol", "remifentanil"]),
  MIN_INTERVAL: 1, // s: the controller's update interval, the time a rate is held
  MAX_INTERVAL: 60, // s; above tPeak / 3 for the drug the response warns INTERVAL_LONG
  MAX_HISTORY: 20000, // events in one request; longer is 413 HISTORY_TOO_LONG
  LOOKAHEAD_MAX: 30000, // s: how far the predictions look, STANPUMP's look_ahead() horizon
  LOOKAHEAD_EXACT_STEPS: 300, // plans targetReachedAt runs at the controller's own interval before ...
  LOOKAHEAD_MAX_STEP: 60, // ... its step grows by a tenth per plan, up to this many seconds
  CLOCK_SKEW: 2, // s a history event may lie after `now` and be clamped to it
  SERVER_SKEW: 30, // s between the controller's clock and the server's before CLOCK_SKEW
  MAX_RATE: 1e5, // ceiling on pump.maxRate, in the pump's own rate units
  TARGET_CEILING: 5, // x the library's Upper: a higher target is refused
  ON_TARGET: 0.01, // within this fraction of the target counts as on target
  DELIVERY_TOLERANCE: 0.02, // the pump's totaliser may differ from the history by this fraction ...
  DELIVERY_TOLERANCE_ML: 0.5, // ... or by this many mL of the syringe, whichever is larger
  MIN_INFUSATE: 1e-3, // least syringe concentration, in its own units
  PK_CACHE_SIZE: 256, // distinct covariate sets whose model is kept
  TCI_INTERVAL: 10 / 60, // minutes between rate changes in the app (10 s, as STANPUMP)
  TCI_PLASMA_SWITCH: 0.05, // effect site this close to target: hold the plasma
  RATE_UNITS,
  AMOUNT_UNITS,
  BOLUS_UNITS,
  INFUSATE_UNITS,
  CONCENTRATION_UNITS,
  VOLUME_UNITS,
  PUMP_STATES,
  SEX_VALUES,
  TIME_PATTERN,
  BOUNDS: Object.freeze({
    weight: Object.freeze({ min: 0.1, max: 500 }), // MIN_WEIGHT, MAX_WEIGHT (kg)
    height: Object.freeze({ min: 10, max: 200 }), // MIN_HEIGHT, MAX_HEIGHT (cm)
    age: Object.freeze({ min: 0, max: 90 }), // MIN_AGE, MAX_AGE (years)
  }),
});

// The stanpumpR library at the fixtures' commit (inst/extdata/drugDefaults_global.csv,
// column Drug), so that an unknown name is 404 UNKNOWN_DRUG and a library drug
// without a TCI in FauxTCI is 422 DRUG_NOT_TCI, as tciApiCheckDrug() answers.
const STANPUMPR_LIBRARY_DRUGS = Object.freeze([
  "propofol", "remifentanil", "fentanyl", "alfentanil", "sufentanil", "morphine", "pethidine",
  "hydromorphone", "methadone", "ketamine", "dexmedetomidine", "midazolam", "etomidate", "lidocaine",
  "bupivacaine", "ropivacaine", "mepivacaine", "rocuronium", "naloxone", "oxytocin", "oxycodone",
  "oliceridine", "remimazolam", "diazepam", "lorazepam", "alprazolam", "clonazepam", "zolpidem",
  "temazepam", "codeine", "hydrocodone", "oxymorphone", "buprenorphine", "tramadol", "desmetramadol",
  "gabapentin", "pregabalin", "acetaminophen", "ibuprofen", "diclofenac", "diclofenacEC", "meloxicam",
  "ketorolac", "naproxen", "celecoxib", "aspirin", "salicylate", "cefazolin", "clindamycin", "cefalexin",
  "ceftriaxone", "vancomycin", "metronidazole", "gentamicin", "hydrocortisone", "methylprednisolone",
  "dexamethasone", "prednisolone", "prednisone", "sugammadex", "neostigmine", "glycopyrrolate",
  "mannitol", "amiodarone", "desethylamiodarone", "amiodaroneIV", "escitalopram", "citalopram",
  "sertraline", "paroxetine", "duloxetine", "mirtazapine", "bupropion", "hydroxybupropion",
  "fluoxetine", "norfluoxetine", "venlafaxine", "desvenlafaxine", "methylphenidate",
  "methylphenidatePediatric", "lisdexamfetamine", "mixedAmphetamineSalts", "ondansetron",
  "aprepitant", "fosaprepitant", "quetiapine", "risperidone", "hydroxyrisperidone", "aripiprazole",
  "dehydroaripiprazole", "olanzapine", "haloperidol", "haloperidolIV", "droperidol", "droperidolIM",
  "air", "oxygen", "nitrousOxide", "sevoflurane", "isoflurane", "desflurane", "ventilation",
  "phenytoin", "carbamazepine", "valproate", "phenobarbital", "pentobarbital", "ethosuximide",
  "topiramate", "lacosamide", "lamotrigine", "zonisamide", "tiagabine", "levetiracetam",
  "eslicarbazepine", "diamorphine",
]);
// The library drugs whose row offers a target unit in stanpumpR (tciApiDrugNames()).
// Oxycodone joined them at stanpumpR 7d2d2f1 (its row gained target units).
const STANPUMPR_TCI_DRUGS = Object.freeze(["propofol", "remifentanil", "fentanyl", "alfentanil",
  "sufentanil", "hydromorphone", "ketamine", "etomidate", "lidocaine", "oxycodone"]);

// ---------------------------------------------------------------------------
// Errors and warnings

/**
 * A refused request: port of the classed condition tci_api_error raised by
 * tciApiStop() in R/tci-api.R.  `status` is the HTTP status, `code` one of
 * the codes of docs/tci-api.md section 6.3, `pointer` the RFC 6901 JSON
 * pointer of the field at fault (null when the fault is the body itself), and
 * `requestId` the body's requestId when it carried a usable one.
 */
export class TciApiError extends Error {
  constructor(status, code, message, pointer = null) {
    super(message);
    this.name = "TciApiError";
    this.status = status;
    this.code = code;
    this.pointer = pointer;
    this.requestId = null;
  }
}

// tciApiStop()
function stop(status, code, message, pointer = null) {
  throw new TciApiError(status, code, message, pointer);
}

// tciApiWarnings() / tciApiWarn(): the warnings of one request accumulate in
// an array, so the validation and the planning can add to it as they go.
function warn(w, code, message, pointer = null) {
  w.push({ code, message, pointer });
}

// ---------------------------------------------------------------------------
// Number formatting for messages: C's %g (sprintf) and R's format(), so that
// the messages read as the R's do.  Not compared by any test.

function formatG(v, precision) {
  if (!Number.isFinite(v)) return v > 0 ? "Inf" : v < 0 ? "-Inf" : "NaN";
  if (v === 0) return "0";
  const [mantissa, exponentPart] = v.toExponential(precision - 1).split("e");
  const e = parseInt(exponentPart, 10);
  const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (e < -4 || e >= precision) {
    const ae = Math.abs(e);
    return `${strip(mantissa)}e${e < 0 ? "-" : "+"}${ae < 10 ? "0" + ae : ae}`;
  }
  return strip(v.toFixed(Math.max(0, precision - 1 - e)));
}

const g = (v) => formatG(v, 6);

// R's format() of one double: seven significant digits, fixed unless the
// scientific form is shorter.
function formatR(v) {
  if (!Number.isFinite(v)) return formatG(v, 7);
  const fixed = formatG(v, 7);
  if (v === 0) return fixed;
  const [mantissa, exponentPart] = v.toExponential(6).split("e");
  const e = parseInt(exponentPart, 10);
  const ae = Math.abs(e);
  const m = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
  const sci = `${m}e${e < 0 ? "-" : "+"}${ae < 10 ? "0" + ae : ae}`;
  return fixed.length <= sci.length ? fixed : sci;
}

// ---------------------------------------------------------------------------
// Time

// Round half to even, as R's round() does (IEC 60559), for the millisecond.
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Seconds since the epoch of one RFC 3339 string the API accepts, or null if
 * the string does not match TCI_API_TIME_PATTERN or names an impossible date
 * (the 30th of February).  The 60th second rolls into the next minute, as
 * lubridate::fast_strptime() reads it; a fraction of a second is added to the
 * whole seconds afterwards, as the R does, so the two agree bit for bit.
 * Port of the parse inside tciApiParseTimes(); the API's errors are raised by
 * the caller.
 */
export function parseRfc3339(str) {
  if (typeof str !== "string" || !TIME_RE.test(str)) return null;
  const m = TIME_FIELDS_RE.exec(str);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  // Date.UTC() rolls an impossible day into the next month; the R gives NA.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day) return null;
  let secs = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  if (m[7]) secs += Number("0" + m[7]);
  if (m[9]) {
    const offset = Number(m[10]) * 3600 + Number(m[11]) * 60;
    secs -= m[9] === "-" ? -offset : offset;
  }
  return secs;
}

/**
 * RFC 3339 in UTC with milliseconds from seconds since the epoch, or null
 * for anything that is not a finite number: port of tciApiFormatTime().  The
 * R rounds to the millisecond (half to even) and then prints; so does this.
 */
export function formatRfc3339(secs) {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return null;
  return new Date(roundHalfEven(secs * 1000)).toISOString();
}

// tciApiParseTimes(): parse several strings at once, each check over all of
// them before the next (so the first failure is the R's), null staying null.
function parseTimes(strs, pointerFor) {
  const n = strs.length;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (strs[i] !== null && !TIME_RE.test(strs[i])) {
      stop(422, "TIME_INVALID",
        `${pointerFor(i)}: '${strs[i]}' is not an RFC 3339 time with a Z or a numeric offset, such as 2026-10-11T14:32:05.250Z`,
        pointerFor(i));
    }
  }
  for (let i = 0; i < n; i++) if (strs[i] !== null) out[i] = parseRfc3339(strs[i]);
  for (let i = 0; i < n; i++) {
    if (strs[i] !== null && out[i] === null) {
      stop(422, "TIME_INVALID", `${pointerFor(i)}: '${strs[i]}' is not a valid time`, pointerFor(i));
    }
  }
  for (let i = 0; i < n; i++) {
    if (out[i] !== null && out[i] < 0) {
      stop(422, "TIME_INVALID", `${pointerFor(i)}: '${strs[i]}' is earlier than 1970`, pointerFor(i));
    }
  }
  return out;
}

// tciApiTimeString(): a time field as a string, before parsing.  A JSON number
// is refused: a seconds-versus-milliseconds mistake would not be survivable.
function timeString(x, pointer, required = true) {
  if (isNull(x)) {
    if (required) stop(400, "MISSING_FIELD", `${pointer} is required`, pointer);
    return null;
  }
  if (typeof x !== "string") {
    stop(400, "INVALID_TYPE",
      `${pointer} must be an RFC 3339 string such as 2026-10-11T14:32:05.250Z; a JSON number is not accepted`,
      pointer);
  }
  return x;
}

// ---------------------------------------------------------------------------
// JSON shapes and scalar checks.  The body is what JSON.parse() gives: an
// object, an array, a number, a string, true/false, or null, which the API
// treats as absent (so does undefined, for a body built in JavaScript).

const isNull = (x) => x === null || x === undefined;
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isArray = Array.isArray;

function missing(pointer) {
  stop(400, "MISSING_FIELD", `${pointer} is required`, pointer);
}

// tciApiObject()
function apiObject(x, pointer, required = true) {
  if (isNull(x)) {
    if (required) missing(pointer);
    return null;
  }
  if (!isObject(x)) stop(400, "INVALID_TYPE", `${pointer} must be a JSON object`, pointer);
  return x;
}

// tciApiNumber(): a finite JSON number within bounds.  `code` is the code of a
// bounds failure (INVALID_VALUE unless the specification names another).
function apiNumber(x, pointer, {
  required = true, min = -Infinity, max = Infinity, openMin = false, openMax = false,
  code = "INVALID_VALUE", maxName = null,
} = {}) {
  if (isNull(x)) {
    if (required) missing(pointer);
    return null;
  }
  if (typeof x !== "number" || Number.isNaN(x)) {
    stop(400, "INVALID_TYPE", `${pointer} must be a JSON number`, pointer);
  }
  if (!Number.isFinite(x)) stop(422, "INVALID_VALUE", `${pointer} must be finite`, pointer);
  const below = openMin ? x <= min : x < min;
  const above = openMax ? x >= max : x > max;
  if (below || above) {
    const parts = [];
    if (Number.isFinite(min)) parts.push(`${openMin ? ">" : ">="} ${g(min)}`);
    if (Number.isFinite(max)) {
      parts.push(`${openMax ? "<" : "<="} ${maxName === null ? formatR(max) : `${maxName} (${g(max)})`}`);
    }
    stop(422, code, `${pointer} must be ${parts.join(" and ")}`, pointer);
  }
  return x;
}

// tciApiString()
function apiString(x, pointer, { required = true, allowed = null, maxLength = null, code = "INVALID_VALUE" } = {}) {
  if (isNull(x)) {
    if (required) missing(pointer);
    return null;
  }
  if (typeof x !== "string") stop(400, "INVALID_TYPE", `${pointer} must be a JSON string`, pointer);
  if (maxLength !== null && [...x].length > maxLength) {
    stop(422, "INVALID_VALUE", `${pointer} must be at most ${maxLength} characters`, pointer);
  }
  if (allowed !== null && !allowed.includes(x)) {
    stop(422, code,
      `${pointer} must be one of ${allowed.map((a) => `'${a}'`).join(", ")} (exactly, case-sensitive)`,
      pointer);
  }
  return x;
}

// tciApiLogical()
function apiLogical(x, pointer, required = true) {
  if (isNull(x)) {
    if (required) missing(pointer);
    return null;
  }
  if (typeof x !== "boolean") stop(400, "INVALID_TYPE", `${pointer} must be true or false`, pointer);
  return x;
}

// Levenshtein distance, utils::adist() with its default costs.
function editDistance(a, b) {
  const s = [...a];
  const t = [...b];
  let previous = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const current = [i];
    for (let j = 1; j <= t.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[t.length];
}

// tciApiNearestToken(): a micro sign (U+00B5) or Greek mu (U+03BC) is read as
// "mc" first, so that a microgram written with either is told "mcg".
function nearestToken(x, tokens) {
  const y = x.replace(/[\u00b5\u03bc]/g, "mc").toLowerCase();
  let best = 0;
  let bestDistance = Infinity;
  tokens.forEach((token, i) => {
    const d = editDistance(y, token.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return tokens[best];
}

// tciApiUnits(): a unit token from one of the closed lists of section 4.4.
function apiUnits(x, pointer, tokens, required = true) {
  const s = apiString(x, pointer, { required });
  if (s === null) return null;
  if (!tokens.includes(s)) {
    stop(422, "UNIT_UNKNOWN",
      `${pointer}: '${s}' is not an accepted unit token; the nearest accepted token is '${nearestToken(s, tokens)}' (accepted here: ${tokens.join(", ")})`,
      pointer);
  }
  return s;
}

// tciApiQuantity(): { value >= 0, units }.
function apiQuantity(x, pointer, tokens) {
  const q = apiObject(x, pointer, false);
  if (q === null) return null;
  return {
    value: apiNumber(q.value, `${pointer}/value`, { min: 0 }),
    units: apiUnits(q.units, `${pointer}/units`, tokens),
  };
}

// tciApiInfusate(): { concentration >= TCI_API_MIN_INFUSATE, units }: the
// syringe.  The floor is a thousandth of a unit per mL, far below any
// syringe a pump is loaded with.
function apiInfusate(x, pointer, required = false) {
  const inf = apiObject(x, pointer, required);
  if (inf === null) return null;
  return {
    concentration: apiNumber(inf.concentration, `${pointer}/concentration`, { min: TCI_API.MIN_INFUSATE }),
    units: apiUnits(inf.units, `${pointer}/units`, INFUSATE_UNITS),
  };
}

// ---------------------------------------------------------------------------
// The body's keys (tciApiSchema() and tciApiCheckKeys()).  Every object in
// the body has a closed set of keys; an unknown key is most likely a typo
// that would otherwise fall back silently to a default, so it is refused
// before any value is read.  The R also refuses a duplicate key here; see the
// header for why this port cannot.

const INFUSATE_NODE = { keys: ["concentration", "units"] };
const QUANTITY_NODE = { keys: ["value", "units"] };
const HISTORY_ITEM_KEYS = ["time", "rate", "units", "from", "to", "delivered", "bolus", "infusate", "source"];
const SCHEMA = {
  keys: ["requestId", "drug", "now", "patient", "infusate", "pump", "target",
    "timing", "history", "lookAhead", "options"],
  children: {
    patient: { keys: ["weight", "height", "age", "sex"] },
    infusate: INFUSATE_NODE,
    pump: {
      keys: ["rateUnits", "maxRate", "minRate", "rateResolution", "currentRate", "state",
        "volumeInfused", "syringeVolumeRemaining"],
      children: { volumeInfused: QUANTITY_NODE, syringeVolumeRemaining: QUANTITY_NODE },
    },
    target: { keys: ["site", "value", "units"] },
    timing: { keys: ["latency", "interval"] },
    history: { array: true, item: { keys: HISTORY_ITEM_KEYS, children: { infusate: INFUSATE_NODE } } },
    lookAhead: { keys: ["concentration"] },
    options: { keys: ["adjustToFFM"] },
  },
};

function unknownField(key, pointer, keys) {
  const where = pointer === "" ? "the body" : pointer;
  stop(400, "UNKNOWN_FIELD",
    `unknown field '${key}' in ${where}; API version ${TCI_API.VERSION} accepts ${keys.join(", ")}`,
    `${pointer}/${key}`);
}

function checkKeys(x, pointer, node) {
  if (node.array) {
    checkArrayKeys(x, pointer, node.item);
    return;
  }
  if (!isObject(x)) return;
  const names = Object.keys(x);
  for (const key of names) if (!node.keys.includes(key)) unknownField(key, pointer, node.keys);
  if (node.children) {
    for (const key of names) {
      if (Object.prototype.hasOwnProperty.call(node.children, key)) {
        checkKeys(x[key], `${pointer}/${key}`, node.children[key]);
      }
    }
  }
}

// tciApiCheckArrayKeys(): every object of the history, unknown keys first
// over all events, then each child object.
function checkArrayKeys(x, pointer, item) {
  if (!isArray(x) || x.length === 0) return;
  for (let i = 0; i < x.length; i++) {
    if (!isObject(x[i])) continue;
    for (const key of Object.keys(x[i])) {
      if (!item.keys.includes(key)) unknownField(key, `${pointer}/${i}`, item.keys);
    }
  }
  for (const key of Object.keys(item.children || {})) {
    for (let i = 0; i < x.length; i++) {
      if (isObject(x[i]) && Object.prototype.hasOwnProperty.call(x[i], key)) {
        checkKeys(x[i][key], `${pointer}/${i}/${key}`, item.children[key]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Units (tciApiBaseUnits(), tciApiMassFactor(), tciApiUnitFactor() ...).
// The drug's base mass unit is mg for a drug measured in mcg/mL and mcg for
// one measured in ng/mL.  A token is taken apart into its mass (or mL), a
// per-kilogram flag and a per-hour flag, so one converter serves amounts and
// rates alike: an amount token converts to base, a rate token to base/min.
// mL goes through the syringe's concentration, in base per mL, which may
// differ from piece to piece of the history when the syringe was changed.

function baseUnitsFor(concentrationToken) {
  const ng = concentrationToken === "ng";
  return { mass: ng ? "mcg" : "mg", concentration: ng ? "ng/mL" : "mcg/mL" };
}

// One unit of a mass token, in base units.
function massFactor(token, base) {
  if (token === base) return 1;
  return token === "mg" ? 1000 : 1 / 1000;
}

// The syringe's concentration in base per mL (tciApiInfusateBase()).
function infusateBase(infusate, base) {
  if (!infusate) return NaN;
  return infusate.concentration * massFactor(infusate.units.replace(/\/mL$/, ""), base);
}

const UNIT_PARTS = new Map();
for (const token of [...RATE_UNITS, ...BOLUS_UNITS]) {
  const parts = token.split("/");
  UNIT_PARTS.set(token, {
    mass: parts[0], perKg: parts.includes("kg"), perHour: parts[parts.length - 1] === "hr",
  });
}

// How many base units (per minute, for a rate token) one unit of a token is.
// `concBase` is the syringe concentration in force, base per mL, needed only
// for the mL tokens.  The arithmetic is the R's, in its order.
function unitFactor(units, base, weight, concBase) {
  const part = UNIT_PARTS.get(units);
  if (!part) return NaN;
  const f = part.mass === "mL" ? concBase : massFactor(part.mass, base);
  return f * (part.perKg ? weight : 1) / (part.perHour ? 60 : 1);
}

const toBase = (value, units, base, weight, concBase) => value * unitFactor(units, base, weight, concBase);

// ---------------------------------------------------------------------------
// The drug and its model

// tciApiCheckDrug(): the drug of the request.  A name the stanpumpR library
// does not know is 404; a library drug this port has no TCI for is 422.
function checkDrug(drug) {
  if (isNull(drug)) {
    stop(400, "MISSING_FIELD", "drug is required: the path's drug, or `drug` in the body", "/drug");
  }
  if (typeof drug !== "string") stop(400, "INVALID_TYPE", "drug must be a string", "/drug");
  if (!STANPUMPR_LIBRARY_DRUGS.includes(drug)) {
    stop(404, "UNKNOWN_DRUG", `'${drug}' is not a drug in the stanpumpR library`, "/drug");
  }
  if (!TCI_API.DRUGS.includes(drug)) {
    const why = STANPUMPR_TCI_DRUGS.includes(drug)
      ? `${drug} has a target-controlled infusion in stanpumpR but not in FauxTCI`
      : `${drug} has no target-controlled infusion in stanpumpR`;
    stop(422, "DRUG_NOT_TCI", `${why}; the TCI drugs here are ${TCI_API.DRUGS.join(", ")}`, "/drug");
  }
  return drug;
}

// tciApiPK(): the model for a covariate set, kept for the next request with
// the same covariates (resolveModel()'s ke0 solve is the expensive step), in
// a Map of at most PK_CACHE_SIZE entries, the oldest evicted.
const modelCache = new Map();

function modelFor(drug, weight, height, age, sex, adjustToFFM, ke0 = null) {
  // An injected ke0 (validation only) bypasses the cache: it is not the model.
  if (ke0 !== null) return resolveModel({ drug, weight, height, age, sex, adjustToFFM, ke0 });
  const key = [drug, weight, height, age, sex, adjustToFFM].join("|");
  const hit = modelCache.get(key);
  if (hit) return hit;
  const model = resolveModel({ drug, weight, height, age, sex, adjustToFFM });
  if (modelCache.size >= TCI_API.PK_CACHE_SIZE) modelCache.delete(modelCache.keys().next().value);
  modelCache.set(key, model);
  return model;
}

// tciKinetics(): the constants the controller needs, laid out as in R/tci.R,
// with `coef`, `lambda3` and `lambda4` so pk.js's advance() reads them too.
function kinetics(model) {
  return {
    lambda3: model.lambda3,
    lambda4: model.lambda4,
    ke0: model.params.ke0,
    tPeak: model.params.tPeak,
    pbolus: model.coef.pbolus,
    pinf: model.coef.pinf,
    ebolus: model.coef.ebolus,
    einf: model.coef.einf,
    coef: model.coef,
  };
}

// jsonlite's number formatting with digits = NA ("%.15g").
function jsonNumber(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  return formatG(v, 15);
}

// tciApiHash(): MD5 of the serialised parameters, rounded to ten significant
// digits first so that the same model hashes identically on every platform
// (libm implementations differ in the last binary digit).  The text hashed
// is jsonlite::toJSON(x, auto_unbox = TRUE, digits = NA) plus the newline
// writeLines() adds; the value may still differ from R's where the two
// serialisers format a number differently.
function apiHash(parameters) {
  const fields = Object.entries(parameters).map(([key, value]) => {
    const text = typeof value === "number" ? jsonNumber(Number(value.toPrecision(10))) : JSON.stringify(value);
    return `"${key}":${text}`;
  });
  return "md5:" + md5(`{${fields.join(",")}}\n`);
}

// tciApiModelBlock(): the `model` block of a response (section 6.1).
function modelBlock(model, adjustToFFM) {
  const k = model.params;
  const parameters = {
    v1: k.v1, v2: k.v2, v3: k.v3, cl1: k.cl1, cl2: k.cl2, cl3: k.cl3,
    k10: k.k10, k12: k.k12, k13: k.k13, k21: k.k21, k31: k.k31,
    lambda_1: k.lambda_1, lambda_2: k.lambda_2, lambda_3: k.lambda_3,
    ke0: k.ke0,
  };
  return {
    drug: model.drug,
    reference: model.reference,
    concentrationUnits: model.concentrationUnits,
    massUnits: model.massUnits,
    tPeak: k.tPeak,
    adjustToFFM,
    parameters,
    hash: apiHash(parameters),
  };
}

// tciApiCoerceNumber(): a number that may have arrived as a query-string
// parameter ("70").  Anything else is left for apiNumber() to refuse.
function coerceNumber(x) {
  if (typeof x === "string" && /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(x)) {
    return Number(x);
  }
  return x;
}

// tciApiCoerceLogical(): the JSON spellings only.
function coerceLogical(x) {
  if (x === "true") return true;
  if (x === "false") return false;
  return x;
}

// ---------------------------------------------------------------------------
// The delivery history (section 4.2): port of tciApiValidateHistory().
//
// Four kinds of event.  A rate change holds from its time to the next rate
// change, or to now.  A delivered segment is what the pump's volume counter
// reports between two times, modelled as a constant rate, and overrides the
// rate changes over its span.  A bolus is drug given outside the pump.  An
// infusate change is a syringe of a different concentration, in force from
// its time.  The R runs every check as one vectorised comparison over all
// events; the passes below are in the same order, so the first failure
// reported is the same.

const KIND_KEYS = ["rate", "delivered", "bolus", "infusate"];
const KIND_NAMES = {
  rate: "rate change", delivered: "delivered segment", bolus: "bolus", infusate: "infusate change",
};
const KIND_FIELDS = {
  rate: ["time", "rate", "units", "source"],
  delivered: ["from", "to", "delivered", "units", "source"],
  bolus: ["time", "bolus", "units", "source"],
  infusate: ["time", "infusate", "source"],
};
const KIND_UNITS = { rate: RATE_UNITS, delivered: AMOUNT_UNITS, bolus: BOLUS_UNITS };

function validateHistory(history, now, w) {
  const n = history.length;
  const ptr = (i, key) => `/history/${i}` + (key ? `/${key}` : "");

  // Every event is an object.
  for (let i = 0; i < n; i++) {
    if (!isObject(history[i])) stop(400, "INVALID_TYPE", `${ptr(i)} must be a JSON object`, ptr(i));
  }

  // One row per field: its event, its key, its value.  A null value is an
  // absent key; an empty object or array is a present value of the wrong
  // type, which the field's own check refuses.
  const rows = [];
  for (let i = 0; i < n; i++) {
    for (const key of Object.keys(history[i])) {
      const value = history[i][key];
      rows.push({ i, key, value, present: !isNull(value) });
    }
  }

  // Exactly one of the four kind keys, and only the keys of that kind.
  const kind = new Array(n).fill(null);
  const kindCount = new Array(n).fill(0);
  for (const r of rows) {
    if (r.present && KIND_KEYS.includes(r.key)) {
      kindCount[r.i] += 1;
      kind[r.i] = r.key;
    }
  }
  for (let i = 0; i < n; i++) {
    if (kindCount[i] !== 1) {
      stop(422, "HISTORY_INVALID",
        `${ptr(i)} must be exactly one of a rate change (rate), a delivered segment (delivered), a bolus (bolus) or an infusate change (infusate)`,
        ptr(i));
    }
  }
  for (const r of rows) {
    if (r.present && !KIND_FIELDS[kind[r.i]].includes(r.key)) {
      stop(422, "HISTORY_INVALID",
        `${ptr(r.i)}: a ${KIND_NAMES[kind[r.i]]} does not take '${r.key}'`, ptr(r.i, r.key));
    }
  }

  // source: any string of at most 32 characters.
  const sources = rows.filter((r) => r.present && r.key === "source");
  for (const r of sources) if (typeof r.value !== "string") apiString(r.value, ptr(r.i, "source"));
  for (const r of sources) {
    if ([...r.value].length > 32) apiString(r.value, ptr(r.i, "source"), { maxLength: 32 });
  }

  // Times: a string each (the parse comes below); `time`, or a segment's
  // `from` and `to`, is required.
  const timeRows = rows.filter((r) => r.present && (r.key === "time" || r.key === "from" || r.key === "to"));
  for (const r of timeRows) if (typeof r.value !== "string") timeString(r.value, ptr(r.i, r.key));
  const tA = new Array(n).fill(null); // time, or a segment's from
  const tB = new Array(n).fill(null); // a segment's to
  for (const r of timeRows) {
    if (r.key === "to") tB[r.i] = r.value; else tA[r.i] = r.value;
  }
  const keyA = (i) => (kind[i] === "delivered" ? "from" : "time");
  for (let i = 0; i < n; i++) if (tA[i] === null) timeString(null, ptr(i, keyA(i)));
  for (let i = 0; i < n; i++) if (kind[i] === "delivered" && tB[i] === null) timeString(null, ptr(i, "to"));

  // The amount: rate, delivered or bolus, a number; and its units, a string.
  const val = new Array(n).fill(null);
  const amounts = rows.filter((r) => r.present && (r.key === "rate" || r.key === "delivered" || r.key === "bolus"));
  for (const r of amounts) {
    if (typeof r.value !== "number") {
      stop(400, "INVALID_TYPE", `${ptr(r.i, r.key)} must be a JSON number`, ptr(r.i, r.key));
    }
  }
  for (const r of amounts) val[r.i] = r.value;
  for (let i = 0; i < n; i++) {
    if (kind[i] !== "infusate" && val[i] === null) {
      stop(400, "INVALID_TYPE", `${ptr(i, kind[i])} must be a JSON number`, ptr(i, kind[i]));
    }
  }
  const unit = new Array(n).fill(null);
  const unitRows = rows.filter((r) => r.present && r.key === "units");
  for (const r of unitRows) if (typeof r.value !== "string") apiString(r.value, ptr(r.i, "units"));
  for (const r of unitRows) unit[r.i] = r.value;
  for (let i = 0; i < n; i++) if (kind[i] !== "infusate" && unit[i] === null) apiString(null, ptr(i, "units"));

  // The syringe of an infusate change, with the request's own infusate check.
  const infConc = new Array(n).fill(null);
  const infUnit = new Array(n).fill(null);
  for (const r of rows) {
    if (r.present && r.key === "infusate") {
      const x = apiInfusate(r.value, ptr(r.i, "infusate"), true);
      infConc[r.i] = x.concentration;
      infUnit[r.i] = x.units;
    }
  }

  for (let i = 0; i < n; i++) {
    if (val[i] !== null && !Number.isFinite(val[i])) {
      stop(422, "INVALID_VALUE", `${ptr(i, kind[i])} must be finite`, ptr(i, kind[i]));
    }
  }
  for (const k of Object.keys(KIND_UNITS)) {
    for (let i = 0; i < n; i++) {
      if (kind[i] === k && !KIND_UNITS[k].includes(unit[i])) apiUnits(unit[i], ptr(i, "units"), KIND_UNITS[k]);
    }
  }
  for (let i = 0; i < n; i++) {
    if ((kind[i] === "rate" || kind[i] === "delivered") && val[i] < 0) {
      stop(422, "INVALID_VALUE", `${ptr(i, kind[i])} must be >= 0`, ptr(i, kind[i]));
    }
  }
  for (let i = 0; i < n; i++) {
    if (kind[i] === "bolus" && val[i] <= 0) {
      stop(422, "INVALID_VALUE", `${ptr(i, "bolus")} must be > 0`, ptr(i, "bolus"));
    }
  }

  const secA = parseTimes(tA, (i) => ptr(i, keyA(i)));
  const secB = parseTimes(tB, (i) => ptr(i, "to"));
  for (let i = 0; i < n; i++) {
    if (kind[i] === "delivered" && secB[i] <= secA[i]) {
      stop(422, "INVALID_VALUE", `${ptr(i, "to")} must be later than ${ptr(i, "from")}`, ptr(i, "to"));
    }
  }

  // The history is the past.  A moment of clock skew is forgiven and clamped
  // to now; more than that is a plan, not a record.
  const relA = pastTimes(secA, now, w, (i) => ptr(i, keyA(i)));
  const relB = pastTimes(secB, now, w, (i) => ptr(i, "to"));

  const byTimeThenIndex = (a, b) => (a.time - b.time) || (a.index - b.index);
  const rates = [];
  const boluses = [];
  const infusates = [];
  const segments = [];
  for (let i = 0; i < n; i++) {
    switch (kind[i]) {
      case "rate": rates.push({ time: relA[i], rate: val[i], units: unit[i], index: i }); break;
      case "bolus": boluses.push({ time: relA[i], amount: val[i], units: unit[i], index: i }); break;
      case "infusate": infusates.push({ time: relA[i], concentration: infConc[i], units: infUnit[i], index: i }); break;
      default: segments.push({ from: relA[i], to: relB[i], delivered: val[i], units: unit[i], index: i });
    }
  }
  rates.sort(byTimeThenIndex);
  boluses.sort(byTimeThenIndex);
  infusates.sort(byTimeThenIndex);
  segments.sort((a, b) => (a.from - b.from) || (a.index - b.index));

  // Two rate changes (or two syringes) at one instant are contradictory: the
  // order of two objects in an array is not evidence of which came later.
  const sameInstant = (frame, what) => {
    for (let j = 1; j < frame.length; j++) {
      if (frame[j].time === frame[j - 1].time) {
        stop(422, "HISTORY_INVALID",
          `two ${what} at the same instant (${ptr(frame[j - 1].index)} and ${ptr(frame[j].index)})`,
          ptr(frame[j].index));
      }
    }
  };
  sameInstant(rates, "rate changes");
  sameInstant(infusates, "infusate changes");
  for (let j = 1; j < segments.length; j++) {
    if (segments[j].from < segments[j - 1].to) {
      stop(422, "HISTORY_OVERLAP",
        `delivered segments ${ptr(segments[j - 1].index)} and ${ptr(segments[j].index)} overlap`,
        ptr(segments[j].index));
    }
  }

  // A millilitre quantity converts with the syringe in force at its time.
  // Once the history records any syringe, a millilitre quantity before the
  // first recorded one has no known concentration (see tciApiValidate()).
  const ml = [];
  for (let i = 0; i < n; i++) if (unit[i] === "mL" || unit[i] === "mL/hr") ml.push(i);
  const mlBeforeInfusate = infusates.length ? ml.filter((i) => relA[i] < infusates[0].time) : [];
  return {
    rates, segments, boluses, infusates,
    mlPointers: ml.map((i) => ptr(i, "units")),
    mlBeforeInfusate,
  };
}

// tciApiPastTimes(): seconds since the epoch to minutes relative to now,
// which must not lie in the future: within CLOCK_SKEW of now is clamped with
// a warning, beyond it refused.  null passes through.
function pastTimes(secs, now, w, pointerFor) {
  const n = secs.length;
  const late = secs.map((s) => (s === null ? null : s - now));
  for (let i = 0; i < n; i++) {
    if (late[i] !== null && late[i] > TCI_API.CLOCK_SKEW) {
      stop(422, "HISTORY_IN_FUTURE",
        `${pointerFor(i)} is ${late[i].toFixed(3)} s after now; the history is the past, not a plan`,
        pointerFor(i));
    }
  }
  for (let i = 0; i < n; i++) {
    if (late[i] !== null && late[i] > 0) {
      warn(w, "HISTORY_CLOCK_SKEW",
        `${pointerFor(i)} is ${late[i].toFixed(3)} s after now and was clamped to now`, pointerFor(i));
      late[i] = 0;
    }
  }
  return late.map((l) => (l === null ? null : l / 60));
}

// findInterval(x, v) for a sorted vector v: how many of its values are <= x.
function findInterval(x, sorted) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// tciApiHistory(): the record in base units: the pieces of the
// piecewise-constant pump rate (start, end in minutes relative to now, rate
// in base/min), the boluses, the rate running at now and the pump's total.
// The syringe in force at any instant is the last infusate change at or
// before it; with none in the history it is the request's throughout.  A
// piece is split at every infusate change, so a mL quantity converts with
// the right syringe even when a segment or a rate spans a syringe change.
function apiHistory(H, base, weight, infusate) {
  const conc0 = infusateBase(infusate, base);
  const inf = H.infusates.map((x) => ({ ...x, concBase: infusateBase(x, base) }));
  const infTimes = inf.map((x) => x.time);
  const concAt = (t) => {
    const k = findInterval(t, infTimes);
    return k > 0 ? inf[k - 1].concBase : conc0;
  };

  const rc = H.rates;
  const rcTimes = rc.map((r) => r.time);
  // A segment clamped to nothing (both ends at now) keeps its amount as an
  // instantaneous pump delivery: the limit of a constant rate over a span
  // shrinking to zero.
  const flat = H.segments.filter((s) => s.to <= s.from);
  const sg = H.segments.filter((s) => s.to > s.from);
  const sgFrom = sg.map((s) => s.from);

  const bounds = [...new Set([...rcTimes, ...sgFrom, ...sg.map((s) => s.to), ...infTimes, 0])]
    .filter((b) => b <= 0)
    .sort((a, b) => a - b);
  const pieces = [];
  for (let j = 0; j + 1 < bounds.length; j++) {
    const start = bounds[j];
    const end = bounds[j + 1];
    let value = 0;
    let units = null;
    const kr = findInterval(start, rcTimes);
    if (kr > 0) {
      value = rc[kr - 1].rate;
      units = rc[kr - 1].units;
    }
    const ks = findInterval(start, sgFrom);
    if (ks > 0 && start < sg[ks - 1].to) {
      const s = sg[ks - 1];
      value = s.delivered / (s.to - s.from);
      units = s.units;
    }
    const rate = units === null ? 0 : toBase(value, units, base, weight, concAt(start));
    pieces.push({ start, end, rate });
  }

  const boluses = [];
  for (const b of H.boluses) {
    boluses.push({ time: b.time, amount: toBase(b.amount, b.units, base, weight, concAt(b.time)) });
  }
  let flatTotal = 0;
  for (const f of flat) {
    const amount = toBase(f.delivered, f.units, base, weight, concAt(f.from));
    boluses.push({ time: f.from, amount });
    flatTotal += amount;
  }

  const last = rc.length ? rc[rc.length - 1] : null;
  const running = last ? toBase(last.rate, last.units, base, weight, conc0) : 0;

  // What passed through the pump: the integral of its rate.  A hand bolus
  // did not, so it is not here; the pump's totaliser cannot know of it.
  let delivered = 0;
  for (const piece of pieces) delivered += piece.rate * (piece.end - piece.start);
  delivered += flatTotal;

  return { pieces, boluses, runningRate: running, delivered, concBase: conc0 };
}

// ---------------------------------------------------------------------------
// The closed form

// tciStatesFromHistory(): the seven amplitudes at now from the record, by
// superposition.  A constant rate R over [a, b] (both at or before now, taken
// as 0) leaves the amplitude of the exponential with eigenvalue lambda at
// coef * R * exp(lambda b) * (1 - exp(-lambda (b - a))), and a bolus A at
// time t leaves coef * A * exp(lambda t).  exp(lambda b) is at most one and
// -expm1() is exact for a short piece.
function statesFromHistory(H, K) {
  const p = [0, 0, 0];
  const e = [0, 0, 0, 0];
  const pc = H.pieces.filter((x) => x.rate !== 0 && x.end > x.start);
  const gainSum = (lambda) => {
    let sum = 0;
    for (const x of pc) {
      sum += Math.exp(lambda * x.end) * (-Math.expm1(-(lambda * (x.end - x.start)))) * x.rate;
    }
    return sum;
  };
  if (pc.length) {
    for (let i = 0; i < 3; i++) p[i] = K.pinf[i] * gainSum(K.lambda3[i]);
    for (let i = 0; i < 4; i++) e[i] = K.einf[i] * gainSum(K.lambda4[i]);
  }
  if (H.boluses.length) {
    const bolusSum = (lambda) => {
      let sum = 0;
      for (const b of H.boluses) sum += Math.exp(lambda * b.time) * b.amount;
      return sum;
    };
    for (let i = 0; i < 3; i++) p[i] += K.pbolus[i] * bolusSum(K.lambda3[i]);
    for (let i = 0; i < 4; i++) e[i] += K.ebolus[i] * bolusSum(K.lambda4[i]);
  }
  return { p, e };
}

// tciAdvance(): the state dt minutes later at a constant rate (base/min),
// tciSchedule()'s advance() through pk.js.
function tciAdvance(S, dt, rate, K) {
  if (dt <= 0) return S;
  return advance(S, dt, rate, K);
}

const sum3 = (v) => v[0] + v[1] + v[2];
const sum4 = (v) => v[0] + v[1] + v[2] + v[3];

// tciConc(): the plasma or effect-site concentration tau minutes after a
// state with the pump off.
function tciConc(S, K, site, tau = 0) {
  if (site === "effect") {
    return S.e[0] * Math.exp(-(K.lambda4[0] * tau)) + S.e[1] * Math.exp(-(K.lambda4[1] * tau)) +
      S.e[2] * Math.exp(-(K.lambda4[2] * tau)) + S.e[3] * Math.exp(-(K.lambda4[3] * tau));
  }
  return S.p[0] * Math.exp(-(K.lambda3[0] * tau)) + S.p[1] * Math.exp(-(K.lambda3[1] * tau)) +
    S.p[2] * Math.exp(-(K.lambda3[2] * tau));
}

// seq(from, to, by) for by > 0: R's seq.default(), fuzz and overshoot
// correction included, so the grids are the R's to the bit.
function seqBy(from, to, by) {
  const del = to - from;
  if (del === 0 && to === 0) return [to];
  const n = Math.trunc(del / by + 1e-10);
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = Math.min(from + i * by, to);
  return out;
}

// seq(from, to, length.out = n): R's seq.default() again.
function seqLength(from, to, n) {
  if (n === 1) return [from];
  if (n === 2) return [from, to];
  if (from === to) return new Array(n).fill(from);
  const n1 = n - 1;
  const by = (to - from) / n1;
  const out = [from];
  for (let i = 1; i < n1; i++) out.push(from + i * by);
  out.push(to);
  return out;
}

// R_zeroin2() from R's src/library/stats/src/zeroin.c, as stats::uniroot()
// calls it: Brent's root finder on [ax, bx] with fa, fb already evaluated.
function zeroin(f, ax, bx, fa, fb, tol, maxit = 1000) {
  const EPSILON = Number.EPSILON;
  let a = ax;
  let b = bx;
  let c = a;
  let fc = fa;
  if (fa === 0) return a;
  if (fb === 0) return b;
  let remaining = maxit + 1;
  while (remaining--) {
    const prevStep = b - a;
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a;
      fa = fb; fb = fc; fc = fa;
    }
    const tolAct = 2 * EPSILON * Math.abs(b) + tol / 2;
    let newStep = (c - b) / 2;
    if (Math.abs(newStep) <= tolAct || fb === 0) return b;
    if (Math.abs(prevStep) >= tolAct && Math.abs(fa) > Math.abs(fb)) {
      let p;
      let q;
      const cb = c - b;
      if (a === c) {
        const t1 = fb / fa;
        p = cb * t1;
        q = 1 - t1;
      } else {
        const qq = fa / fc;
        const t1 = fb / fc;
        const t2 = fb / fa;
        p = t2 * (cb * qq * (qq - t1) - (b - a) * (t1 - 1));
        q = (qq - 1) * (t1 - 1) * (t2 - 1);
      }
      if (p > 0) q = -q; else p = -p;
      if (p < (0.75 * cb * q - Math.abs(tolAct * q) / 2) && p < Math.abs(prevStep * q / 2)) newStep = p / q;
    }
    if (Math.abs(newStep) < tolAct) newStep = newStep > 0 ? tolAct : -tolAct;
    a = b; fa = fb;
    b += newStep;
    fb = f(b);
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) {
      c = a; fc = fa;
    }
  }
  return b;
}

// stats::uniroot(f, c(lower, upper), tol = tol)$root
function uniroot(f, lower, upper, tol) {
  const fLower = f(lower);
  const fUpper = f(upper);
  if (fLower * fUpper > 0) throw new Error("uniroot: f() values at end points not of opposite sign");
  return zeroin(f, lower, upper, fLower, fUpper, tol);
}

// tciApiDecrement(): the time for the controlled concentration to fall to
// `level` with the pump off from the state: STANPUMP's look_ahead().  Zero if
// already there; null with beyond = true if not within the horizon.  The
// crossing is bracketed on a coarse grid and solved on the closed form.
function apiDecrement(S, K, site, level, horizonSeconds = TCI_API.LOOKAHEAD_MAX) {
  if (tciConc(S, K, site) <= level) return { seconds: 0, beyond: false };
  const horizon = horizonSeconds / 60;
  const grid = seqLength(0, horizon, Math.max(3, Math.min(3001, Math.ceil(horizonSeconds / 10) + 1)));
  let k = -1;
  for (let j = 0; j < grid.length; j++) {
    if (tciConc(S, K, site, grid[j]) <= level) {
      k = j;
      break;
    }
  }
  if (k < 0) return { seconds: null, beyond: true };
  const root = uniroot((tau) => tciConc(S, K, site, tau) - level, grid[k - 1], grid[k], 1e-10);
  return { seconds: root * 60, beyond: false };
}

// tciApiPeak(): the effect-site peak with the pump off from the state: the
// maximum of Ce over the next tPeak + 10 s on a 1 s grid, the grid tciRate()
// searched.
function apiPeak(S, K) {
  if (K.ke0 <= 0) return null;
  const tau = seqBy(0, K.tPeak + 10 / 60, 1 / 60);
  let best = 0;
  let bestCe = -Infinity;
  for (let j = 0; j < tau.length; j++) {
    const ce = tciConc(S, K, "effect", tau[j]);
    if (ce > bestCe) {
      bestCe = ce;
      best = j;
    }
  }
  return { ce: bestCe, tau: tau[best] };
}

// ---------------------------------------------------------------------------
// The controller: tciRate() from R/tci.R.
//
// Plasma target: decay the plasma states through one interval with the pump
// off; the rate is the remaining deficit divided by the plasma concentration
// that a unit rate produces by the end of the interval (Bailey & Shafer
// 1991).  Effect-site target: the largest rate that reaches the target
// without overshoot, R = min over tau of (CT - B(tau)) / E(tau), B the decay
// of the current effect-site states with the pump off and E the response to
// a unit-rate infusion lasting one interval (Shafer & Gregg 1992, Appendix
// A).  The search grid runs from dt to dt + tPeak + 10 s one second apart,
// because the peak after an infusion lasting dt lies up to tPeak after the
// infusion ENDS.  Within TCI_PLASMA_SWITCH of the target the plasma is held
// instead (the hand-off; at steady state Cp == Ce).

/**
 * The rate the pump should run for the coming interval, in base/min, and
 * whether the effect-site mode was used: port of tciRate() in R/tci.R.
 * `p` and `e` are the three plasma and four effect-site amplitudes (base/L),
 * `CT` the target (base/L), `site` "effect" or "plasma", `dt` the coming
 * interval in minutes and `K` the kinetic constants (tciKinetics()).
 */
export function tciRate(p, e, CT, site, dt, K) {
  if (CT <= 0) return { rate: 0, effectMode: false };
  const Ce = sum4(e);
  const effectMode = site === "effect" && K.ke0 > 0 &&
    Math.abs(Ce - CT) >= TCI_API.TCI_PLASMA_SWITCH * CT;
  let rate;
  if (!effectMode) {
    let Pd = 0;
    let Pu = 0;
    for (let i = 0; i < 3; i++) {
      const decay = Math.exp(-K.lambda3[i] * dt);
      Pd += p[i] * decay;
      Pu += K.pinf[i] * (1 - decay);
    }
    rate = (CT - Pd) / Pu;
  } else {
    // tau from the end of the coming interval out to dt + tPeak (plus a 10 s
    // margin), one second apart, dt itself first.
    const tau = seqBy(dt, dt + K.tPeak + 10 / 60, 1 / 60);
    const c = [0, 1, 2, 3].map((i) => K.einf[i] * (Math.exp(K.lambda4[i] * dt) - 1));
    rate = Infinity;
    let any = false;
    for (let j = 0; j < tau.length; j++) {
      let B = 0;
      let E = 0;
      for (let i = 0; i < 4; i++) {
        const M = Math.exp(-(K.lambda4[i] * tau[j]));
        B += e[i] * M;
        E += c[i] * M;
      }
      if (E > 0) {
        any = true;
        const candidate = (CT - B) / E;
        if (candidate < rate) rate = candidate;
      }
    }
    if (!any) rate = 0;
  }
  return { rate: Math.max(0, rate), effectMode };
}

// ---------------------------------------------------------------------------
// The plan (sections 5.3 and 5.4)

// tciApiLimit(): the pump's limits, in order: clamp to maxRate, send 0 below
// minRate, round DOWN to a multiple of rateResolution.  The rounding is done
// with a hair of tolerance: 24.6 / 0.1 is 245.99999999999997, and a multiple
// that lands a few ulps above the rate is the rate itself as the pump typed
// it.  The result is never above the rate that came in.
function apiLimit(ideal, pump) {
  let value = ideal;
  const limited = [];
  if (value > pump.maxRate) {
    value = pump.maxRate;
    limited.push("maxRate");
  }
  if (pump.minRate !== null && value > 0 && value < pump.minRate) {
    value = 0;
    limited.push("minRate");
  }
  if (pump.rateResolution !== null && value > 0) {
    const res = pump.rateResolution;
    const k = Math.floor(value / res + 1e-9);
    let rounded = k * res;
    if (rounded > value) {
      rounded = rounded - value <= 1e-9 * Math.max(value, res) ? value : (k - 1) * res;
    }
    if (Math.abs(rounded - value) > 1e-12 * Math.max(value, res)) limited.push("rateResolution");
    value = rounded;
  }
  return { value, limitedBy: limited };
}

// tciApiPlan(): tciRate() on a state, then the pump's limits.  `conv`
// carries base, weight, concBase and rateFactor (how many base/min one unit
// of the pump's rate is).  A rate whose steady-state plasma would be a
// millionth of the target is zero: the effect-site search leaves a rounding
// residual rather than an exact zero when the pump is meant to be off.
function apiPlan(S, CT, site, interval, K, pump, conv) {
  const x = tciRate(S.p, S.e, CT, site, interval / 60, K);
  if (x.rate * sum3(K.pinf) <= 1e-6 * CT) x.rate = 0;
  const ideal = x.rate / conv.rateFactor;
  const lim = apiLimit(ideal, pump);
  return {
    plan: CT <= 0 ? "off" : x.effectMode ? "effectSite" : "plasma",
    idealBase: x.rate,
    ideal,
    value: lim.value,
    limitedBy: lim.limitedBy,
    base: lim.value * conv.rateFactor,
  };
}

// tciStepConc(): the concentration at the controlled site that a rate of one
// base unit per minute, run from now on from an empty body, has built tau
// minutes later: the unit step response.
function stepConc(K, site, tau) {
  if (site === "effect") {
    let s = 0;
    for (let i = 0; i < 4; i++) s += K.einf[i] * (1 - Math.exp(-(K.lambda4[i] * tau)));
    return s;
  }
  let s = 0;
  for (let i = 0; i < 3; i++) s += K.pinf[i] * (1 - Math.exp(-(K.lambda3[i] * tau)));
  return s;
}

// tciApiTargetReached(): when the controlled concentration first comes
// within ON_TARGET of the target, running the same controller forward from
// the state in closed loop (same interval and limits, no latency), as minutes
// from the state, or null if not within LOOKAHEAD_MAX.  Three shortcuts keep
// this to a few plans: the pump at its ceiling bounds every closed loop from
// above (never in the band: null at once); while the controller itself
// chooses rate 0 the pump-off trajectory is followed in closed form to the
// step before anything the plan reads changes; and after LOOKAHEAD_EXACT_STEPS
// plans the step grows by a tenth per plan, up to LOOKAHEAD_MAX_STEP.
function targetReached(S0, CT, site, interval, K, pump, conv) {
  if (CT <= 0) return null;
  const band = TCI_API.ON_TARGET * CT;
  const within = (x) => Math.abs(x - CT) <= band;
  const controlled = (S) => (site === "effect" ? sum4(S.e) : sum3(S.p));
  const horizon = TCI_API.LOOKAHEAD_MAX / 60;
  let S = S0;
  let c0 = controlled(S);
  if (within(c0)) return 0;
  if (c0 < CT - band) {
    const capBase = apiLimit(pump.maxRate, pump).value * conv.rateFactor;
    const grid = seqBy(0, horizon, 10 / 60);
    let anyReach = false;
    for (const tau of grid) {
      if (!(tciConc(S, K, site, tau) + capBase * stepConc(K, site, tau) < CT - band)) {
        anyReach = true;
        break;
      }
    }
    if (!anyReach) return null;
  }
  const effectMode = (ce) => site === "effect" && Math.abs(ce - CT) >= TCI_API.TCI_PLASMA_SWITCH * CT;
  let dt = interval / 60;
  let t = 0;
  let plans = 0;
  while (t < horizon - 1e-9) {
    c0 = controlled(S);
    if (within(c0)) return t;
    const plan = apiPlan(S, CT, site, dt * 60, K, pump, conv);
    plans += 1;
    if (plan.idealBase === 0) {
      // Off by choice: follow the pump-off trajectory to the first step at
      // which the plan could change, at most 3000 steps at a time.
      const m = Math.min(Math.ceil((horizon - t) / dt - 1e-9), 3000);
      const mode0 = effectMode(sum4(S.e));
      const sign0 = Math.sign(c0 - CT);
      let k = -1;
      let tauK = 0;
      let concK = 0;
      for (let j = 1; j <= m; j++) {
        const tau = dt * j;
        const cp = tciConc(S, K, "plasma", tau);
        const ce = tciConc(S, K, "effect", tau);
        const conc = site === "effect" ? ce : cp;
        const change = within(conc) || Math.sign(conc - CT) !== sign0 ||
          effectMode(ce) !== mode0 || (!mode0 && cp < CT);
        if (change) {
          k = j;
          tauK = tau;
          concK = conc;
          break;
        }
      }
      const tauM = dt * m;
      if (k < 0 && t + tauM >= horizon - 1e-9) return null;
      if (k > 0 && within(concK)) return t + tauK;
      const jump = k < 0 ? m : k - 1;
      if (jump >= 1) {
        const tauJ = dt * jump;
        S = {
          p: S.p.map((v, i) => v * Math.exp(-K.lambda3[i] * tauJ)),
          e: S.e.map((v, i) => v * Math.exp(-K.lambda4[i] * tauJ)),
        };
        t += tauJ;
        continue;
      }
    }
    S = tciAdvance(S, dt, plan.base, K);
    t += dt;
    if (plans >= TCI_API.LOOKAHEAD_EXACT_STEPS) dt = Math.min(dt * 1.1, TCI_API.LOOKAHEAD_MAX_STEP / 60);
  }
  if (within(controlled(S))) return t;
  return null;
}

// ---------------------------------------------------------------------------
// The request (section 4): port of tciApiValidate().  Returns the request in
// normalised form: times in seconds since the epoch, defaults filled in, the
// history parsed.  Throws TciApiError at the first failure; adds warnings.

function validate(request, pathDrug, w) {
  if (!isObject(request)) stop(400, "INVALID_TYPE", "the request body must be a JSON object", "");
  checkKeys(request, "", SCHEMA);

  const requestId = apiString(request.requestId, "/requestId", { required: false, maxLength: 128 });
  if (requestId !== null && !/^[ -~]*$/.test(requestId)) {
    stop(422, "INVALID_VALUE", "/requestId must be printable ASCII", "/requestId");
  }

  const drug = checkDrug(pathDrug);
  if (!isNull(request.drug)) {
    const bodyDrug = apiString(request.drug, "/drug");
    if (bodyDrug !== drug) {
      stop(400, "DRUG_MISMATCH", `the body's drug '${bodyDrug}' is not the path's drug '${drug}'`, "/drug");
    }
  }
  const row = DRUG_LIBRARY[drug];
  const units = baseUnitsFor(row.concentrationUnits);

  const nowText = timeString(request.now, "/now");
  const now = parseTimes([nowText], () => "/now")[0];

  const patient = apiObject(request.patient, "/patient");
  const B = TCI_API.BOUNDS;
  const weight = apiNumber(patient.weight, "/patient/weight", { min: B.weight.min, max: B.weight.max });
  const height = apiNumber(patient.height, "/patient/height", { min: B.height.min, max: B.height.max });
  const age = apiNumber(patient.age, "/patient/age", { min: B.age.min, max: B.age.max });
  const sex = apiString(patient.sex, "/patient/sex", { allowed: SEX_VALUES });

  const target = apiObject(request.target, "/target");
  const site = apiString(target.site, "/target/site", { allowed: ["effect", "plasma"] });
  const value = apiNumber(target.value, "/target/value", { min: 0 });
  const tunits = apiUnits(target.units, "/target/units", CONCENTRATION_UNITS);
  if (tunits !== units.concentration) {
    stop(422, "UNIT_MISMATCH", `target.units must be ${units.concentration} for ${drug}`, "/target/units");
  }
  const upper = row.upper;
  if (value > TCI_API.TARGET_CEILING * upper) {
    stop(422, "TARGET_OUT_OF_RANGE",
      `target.value ${g(value)} ${tunits} is above ${g(TCI_API.TARGET_CEILING)} x the upper typical target of ${drug} (${g(upper)} ${tunits})`,
      "/target/value");
  }
  if (value > upper) {
    warn(w, "TARGET_HIGH",
      `target.value ${g(value)} ${tunits} is above the upper typical target of ${drug} (${g(upper)} ${tunits})`,
      "/target/value");
  }

  const timing = apiObject(request.timing, "/timing");
  const interval = apiNumber(timing.interval, "/timing/interval",
    { min: TCI_API.MIN_INTERVAL, max: TCI_API.MAX_INTERVAL });
  const latency = apiNumber(timing.latency, "/timing/latency", { min: 0 });
  if (latency >= interval) {
    stop(422, "LATENCY_INVALID",
      `timing.latency (${g(latency)} s) must be less than timing.interval (${g(interval)} s)`, "/timing/latency");
  }
  if (latency > interval / 2) {
    warn(w, "LATENCY_LONG",
      `timing.latency (${g(latency)} s) is more than half the interval (${g(interval)} s)`, "/timing/latency");
  }

  const pump = apiObject(request.pump, "/pump");
  const rateUnits = apiUnits(pump.rateUnits, "/pump/rateUnits", RATE_UNITS);
  const maxRate = apiNumber(pump.maxRate, "/pump/maxRate", { min: 0, openMin: true, max: TCI_API.MAX_RATE });
  const minRate = apiNumber(pump.minRate, "/pump/minRate",
    { required: false, min: 0, max: maxRate, openMax: true, maxName: "maxRate" });
  const rateResolution = apiNumber(pump.rateResolution, "/pump/rateResolution",
    { required: false, min: 0, openMin: true, max: maxRate / 10, maxName: "maxRate / 10" });
  const currentRate = apiNumber(pump.currentRate, "/pump/currentRate", { required: false, min: 0 });
  let state = apiString(pump.state, "/pump/state", { required: false, allowed: PUMP_STATES });
  if (state === null) state = "running";
  const volumeInfused = apiQuantity(pump.volumeInfused, "/pump/volumeInfused", AMOUNT_UNITS);
  const syringe = apiQuantity(pump.syringeVolumeRemaining, "/pump/syringeVolumeRemaining", VOLUME_UNITS);

  const infusate = apiInfusate(request.infusate, "/infusate");

  const history = request.history;
  if (isNull(history)) missing("/history");
  if (!isArray(history)) stop(400, "INVALID_TYPE", "/history must be a JSON array (it may be empty)", "/history");
  if (history.length > TCI_API.MAX_HISTORY) {
    stop(413, "HISTORY_TOO_LONG",
      `/history has ${history.length} events; at most ${TCI_API.MAX_HISTORY} are accepted (merge old segments)`,
      "/history");
  }
  const H = validateHistory(history, now, w);

  const lookAhead = apiObject(request.lookAhead, "/lookAhead", false);
  const lookAheadConcentration = lookAhead === null ? null
    : apiNumber(lookAhead.concentration, "/lookAhead/concentration", { min: 0, openMin: true });

  const options = apiObject(request.options, "/options", false);
  let adjustToFFM = options === null ? null : apiLogical(options.adjustToFFM, "/options/adjustToFFM", false);
  if (adjustToFFM === null) adjustToFFM = true;

  // Anything in millilitres needs the syringe, which must be the syringe the
  // history last reported.
  const ml = [];
  if (rateUnits === "mL/hr") ml.push("/pump/rateUnits");
  if (volumeInfused !== null && volumeInfused.units === "mL") ml.push("/pump/volumeInfused/units");
  if (syringe !== null) ml.push("/pump/syringeVolumeRemaining/units");
  ml.push(...H.mlPointers);
  if (ml.length && infusate === null) {
    stop(422, "INFUSATE_REQUIRED", `infusate is required because ${ml[0]} is in millilitres`, "/infusate");
  }
  if (H.mlBeforeInfusate.length) {
    const i = H.mlBeforeInfusate[0];
    stop(422, "INFUSATE_REQUIRED",
      `the syringe in force before /history/${i} is unknown: record the initial syringe as an infusate event (the request's infusate is the syringe on the pump now, which must equal the last infusate event)`,
      `/history/${i}/units`);
  }
  if (infusate !== null && H.infusates.length) {
    const last = H.infusates[H.infusates.length - 1];
    if (last.concentration !== infusate.concentration || last.units !== infusate.units) {
      stop(422, "INFUSATE_MISMATCH",
        `infusate (${g(infusate.concentration)} ${infusate.units}) must equal the last infusate change in the history (${g(last.concentration)} ${last.units} at /history/${last.index})`,
        "/infusate");
    }
  }

  return {
    requestId, drug, now, nowText,
    patient: { weight, height, age, sex },
    infusate,
    pump: { rateUnits, maxRate, minRate, rateResolution, currentRate, state, volumeInfused, syringeVolumeRemaining: syringe },
    target: { site, value, units: tunits },
    timing: { latency, interval },
    history: H,
    lookAhead: lookAheadConcentration,
    adjustToFFM,
    units,
    row,
  };
}

// ---------------------------------------------------------------------------
// The response (sections 5 and 6)

// tciApiServerBlock(): this port's identity and clock.
function serverBlock(receivedSeconds, respondedSeconds, compute = true) {
  const out = {
    package: TCI_API.PACKAGE,
    version: FAUXTCI_VERSION,
    commit: null,
    receivedAt: formatRfc3339(receivedSeconds),
    respondedAt: formatRfc3339(respondedSeconds),
  };
  if (compute) out.computeSeconds = respondedSeconds - receivedSeconds;
  return out;
}

// Seconds since the epoch of a Date, a number of milliseconds, or an RFC 3339
// string; the current clock for anything else.
function toSeconds(when) {
  if (when instanceof Date && Number.isFinite(when.getTime())) return when.getTime() / 1000;
  if (typeof when === "number" && Number.isFinite(when)) return when / 1000;
  if (typeof when === "string") {
    const secs = parseRfc3339(when);
    if (secs !== null) return secs;
  }
  return Date.now() / 1000;
}

// tciApiLenientRequestId(): the request id for an error body, read leniently
// before validation so that a refused request is still answered by name.
function lenientRequestId(request) {
  const id = isObject(request) ? request.requestId : null;
  return typeof id === "string" ? id : null;
}

// tciApiCheckFinite(): every number in the parts of a response a pump acts
// on must be finite; a NaN or an Inf is a fault of the arithmetic, refused as
// 500 INTERNAL rather than handed to a pump.
function checkFinite(x, pointer = "") {
  if (isArray(x)) {
    x.forEach((v, i) => checkFinite(v, `${pointer}/${i}`));
  } else if (isObject(x)) {
    for (const key of Object.keys(x)) checkFinite(x[key], `${pointer}/${key}`);
  } else if (typeof x === "number" && !Number.isFinite(x)) {
    stop(500, "INTERNAL", `the server computed a number that is not finite at ${pointer}`, pointer);
  }
}

// tciApiCompute(): the whole computation, sections 5.1 to 5.7.
function compute(request, pathDrug, receivedSeconds, ke0) {
  const w = [];
  if (!isObject(request)) stop(400, "INVALID_TYPE", "the request body must be a JSON object", "");
  const req = validate(request, pathDrug, w);

  const model = modelFor(req.drug, req.patient.weight, req.patient.height, req.patient.age,
    req.patient.sex, req.adjustToFFM, ke0);
  const K = kinetics(model);
  const base = req.units.mass;
  const tunits = req.target.units;
  const CT = req.target.value;
  const site = req.target.site;
  const L = req.timing.latency;
  const I = req.timing.interval;
  const dt = I / 60;
  const pump = req.pump;

  if (K.tPeak > 0 && I > K.tPeak * 60 / 3) {
    warn(w, "INTERVAL_LONG",
      `timing.interval (${g(I)} s) is more than a third of ${req.drug}'s time to peak effect (${(K.tPeak * 60).toFixed(1)} s)`,
      "/timing/interval");
  }
  if (Math.abs(receivedSeconds - req.now) > TCI_API.SERVER_SKEW) {
    warn(w, "CLOCK_SKEW",
      `now is ${(req.now - receivedSeconds).toFixed(1)} s from the server's clock; the computation uses the controller's clock`,
      "/now");
  }

  // 5.1  The state at now from the record
  const H = apiHistory(req.history, base, req.patient.weight, req.infusate);
  const conv = {
    base,
    weight: req.patient.weight,
    concBase: H.concBase,
    rateFactor: unitFactor(pump.rateUnits, base, req.patient.weight, H.concBase),
  };
  const S0 = statesFromHistory(H, K);

  if (pump.state !== "running") {
    warn(w, "PUMP_NOT_RUNNING",
      `pump.state is '${pump.state}': the latency projection runs at rate 0 and the plan assumes the pump will run it`,
      "/pump/state");
  }
  if (pump.state === "running" && pump.currentRate !== null) {
    const runningPump = H.runningRate / conv.rateFactor;
    const tol = Math.max(pump.rateResolution === null ? 0 : pump.rateResolution, 1e-6 * runningPump);
    if (Math.abs(pump.currentRate - runningPump) > tol) {
      warn(w, "RATE_MISMATCH",
        `pump.currentRate (${g(pump.currentRate)} ${pump.rateUnits}) differs from the rate the history says is running (${g(runningPump)} ${pump.rateUnits}); the history is authoritative`,
        "/pump/currentRate");
    }
  }

  // 5.2  The latency projection: the old rate runs until the command lands
  const running = pump.state === "running" ? H.runningRate : 0;
  const S1 = tciAdvance(S0, L / 60, running, K);

  // 5.3, 5.4  The plan and the pump's limits
  const plan = apiPlan(S1, CT, site, I, K, pump, conv);

  // 5.7  The hold and the fallback
  const S2 = tciAdvance(S1, dt, plan.base, K);
  const fallback = apiPlan(S2, CT, site, I, K, pump, conv);

  // 5.5  Timing
  const t0 = req.now;
  const t1 = t0 + L;
  const t2 = t1 + I;
  const controlled = (S) => (site === "effect" ? sum4(S.e) : sum3(S.p));
  const C1 = controlled(S1);
  let nextAt = t2 - L;
  if (plan.value === 0 && CT > 0) {
    // STANPUMP's rule: with the pump off, ask again when the concentration
    // reaches the target, so the maintenance starts at the peak.  A peak
    // that stays below the band does not reach the target, and a peak at
    // effectiveAt itself is nothing to wait for; both keep the usual time.
    let reach = null;
    if (site === "effect" && C1 < CT) {
      const pk = apiPeak(S1, K);
      if (pk !== null && pk.ce >= (1 - TCI_API.ON_TARGET) * CT && pk.tau > 0) reach = t1 + pk.tau * 60;
    } else if (C1 > CT) {
      const d = apiDecrement(S1, K, site, CT, 2 * I);
      if (!d.beyond && d.seconds > 0) reach = t1 + d.seconds;
    }
    if (reach !== null && reach < t2 + I) nextAt = Math.max(t0, reach - L);
  }

  let phase;
  if (CT <= 0) phase = "stopped";
  else if (plan.value === 0) phase = C1 > CT ? "aboveTarget" : "waitingForPeak";
  else if (C1 < (1 - TCI_API.TCI_PLASMA_SWITCH) * CT) phase = "loading";
  else phase = "maintenance";

  // 5.6  Predictions, all from the commanded rate
  const C2 = controlled(S2);
  const pk2 = apiPeak(S2, K);
  const reached = targetReached(S2, CT, site, I, K, pump, conv);
  const prediction = {
    units: tunits,
    peakCe: pk2 === null ? null : pk2.ce,
    peakAt: pk2 === null ? null : formatRfc3339(t2 + pk2.tau * 60),
    onTarget: CT > 0 ? Math.abs(C2 - CT) <= TCI_API.ON_TARGET * CT : false,
    deviation: CT > 0 ? (C2 - CT) / CT : null,
    targetReachedAt: reached === null ? null : formatRfc3339(t2 + reached * 60),
  };
  if (req.lookAhead !== null) {
    const d = apiDecrement(S0, K, site, req.lookAhead);
    prediction.lookAhead = {
      site,
      concentration: req.lookAhead,
      units: tunits,
      decrementSeconds: d.seconds,
      horizonSeconds: TCI_API.LOOKAHEAD_MAX,
      beyondHorizon: d.beyond,
    };
  }

  const hasInfusate = req.infusate !== null;
  const mlPerMin = (baseRate) => baseRate / conv.concBase;
  const syringe = pump.syringeVolumeRemaining;
  if (syringe !== null) {
    const remaining = syringe.value;
    const usedInLatency = mlPerMin(running) * L / 60;
    let emptyAt = null;
    if (usedInLatency >= remaining && running > 0) {
      emptyAt = t0 + remaining / mlPerMin(running) * 60;
    } else if (plan.base > 0) {
      emptyAt = t1 + (remaining - usedInLatency) / mlPerMin(plan.base) * 60;
    }
    prediction.syringeEmptyAt = emptyAt === null ? null : formatRfc3339(emptyAt);
    const needed = (plan.base + fallback.base) * dt / conv.concBase;
    if (needed > remaining) {
      warn(w, "SYRINGE_LOW",
        `the planned segment and the fallback segment need ${needed.toFixed(2)} mL and ${remaining.toFixed(2)} mL remain`,
        "/pump/syringeVolumeRemaining");
    }
  }

  let reported = null;
  if (pump.volumeInfused !== null) {
    reported = toBase(pump.volumeInfused.value, pump.volumeInfused.units, base, conv.weight, conv.concBase);
    const tol = Math.max(TCI_API.DELIVERY_TOLERANCE * H.delivered,
      hasInfusate ? TCI_API.DELIVERY_TOLERANCE_ML * conv.concBase : 0);
    if (Math.abs(reported - H.delivered) > tol) {
      warn(w, "DELIVERY_MISMATCH",
        `pump.volumeInfused is ${g(reported)} ${base} and the history integrates to ${g(H.delivered)} ${base}`,
        "/pump/volumeInfused");
    }
  }

  const amount = plan.base * dt;
  const rate = { value: plan.value, units: pump.rateUnits };
  if (hasInfusate) rate.mlPerHour = mlPerMin(plan.base) * 60;
  rate.massPerMinute = plan.base;
  rate.massUnits = base;
  rate.ideal = plan.ideal;
  rate.limitedBy = plan.limitedBy;
  const segment = { holdSeconds: I, amount, amountUnits: base };
  if (hasInfusate) segment.volumeMl = amount / conv.concBase;

  const out = {
    apiVersion: TCI_API.VERSION,
    requestId: req.requestId,
    drug: req.drug,
    target: { site, value: CT, units: tunits },
    controller: { plan: plan.plan, phase },
    rate,
    segment,
    fallback: { rate: fallback.value, units: pump.rateUnits, maxSeconds: I },
    // `now` is the request's own string, verbatim, so that a controller can
    // match the response to its request by comparing the two (section 7,
    // rule 1); the times the server computes are formatted in UTC.
    timing: {
      now: req.nowText,
      effectiveAt: formatRfc3339(t1),
      holdUntil: formatRfc3339(t2),
      nextRequestAt: formatRfc3339(nextAt),
      latency: L,
      interval: I,
    },
    state: {
      units: tunits,
      now: { cp: sum3(S0.p), ce: sum4(S0.e), p: [...S0.p], e: [...S0.e] },
      effectiveAt: { cp: sum3(S1.p), ce: sum4(S1.e) },
      holdUntil: { cp: sum3(S2.p), ce: sum4(S2.e) },
    },
    prediction,
    delivered: { fromHistory: H.delivered, reported, units: base },
    model: modelBlock(model, req.adjustToFFM),
    algorithm: { name: "shafer-gregg-1992", plasmaSwitch: TCI_API.TCI_PLASMA_SWITCH, tauGridSeconds: 1 },
    warnings: w,
    server: serverBlock(receivedSeconds, Date.now() / 1000),
  };
  // The belt: nothing a pump acts on may be NaN or infinite.
  for (const key of ["rate", "segment", "fallback", "state", "prediction", "delivered"]) {
    checkFinite(out[key], `/${key}`);
  }
  return out;
}

/**
 * The next infusion rate for a TCI pump: port of tciNextRate() in
 * R/tci-api.R, the controller of the stanpumpR TCI API (version 1).
 * `request` is the parsed body of docs/tci-api.md section 4 (what
 * JSON.parse() gives); `receivedAt` (a Date, milliseconds since the epoch,
 * or an RFC 3339 string; default now) is reported in `server` and compared
 * with the request's `now` for the CLOCK_SKEW warning.  `options.pathDrug`,
 * when given, is the drug of the request path, which the body's `drug` must
 * equal (it defaults to the body's); `options.ke0` injects a known ke0 in
 * place of the solve (validation only: the fixtures' R value, so that the
 * API arithmetic is checked independently of the optimizer, as the fixtures'
 * README prescribes).  Returns the response body of section 6; throws a
 * TciApiError for a refused request, with `requestId` set when the body
 * carried a usable one.  Deterministic apart from `server.*`.
 */
export function tciNextRate(request, receivedAt = new Date(), { pathDrug, ke0 = null } = {}) {
  const rid = lenientRequestId(request);
  const drug = pathDrug === undefined ? (isObject(request) ? request.drug : undefined) : pathDrug;
  try {
    return compute(request, drug, toSeconds(receivedAt), ke0);
  } catch (e) {
    if (e instanceof TciApiError) e.requestId = rid;
    throw e;
  }
}

/**
 * The body of an error response, exactly the shape of docs/tci-api.md
 * section 6.3: port of tciApiErrorBody().  A TciApiError gives its own code,
 * message and pointer; any other error is reported as INTERNAL without its
 * message, as the Plumber router does.  The HTTP status is not part of the
 * body: a transport reads it from the error (`err.status`, or 500).
 */
export function errorBody(err, receivedAt = new Date(), respondedAt = new Date()) {
  const api = err instanceof TciApiError;
  return {
    apiVersion: TCI_API.VERSION,
    requestId: api && typeof err.requestId === "string" ? err.requestId : null,
    errors: [api
      ? { code: err.code, message: err.message, pointer: err.pointer }
      : { code: "INTERNAL", message: "the server failed to compute a response", pointer: null }],
    server: serverBlock(toSeconds(receivedAt), toSeconds(respondedAt), false),
  };
}

/**
 * The body of GET /tci/v1/drugs: port of tciApiDrugs().  The drugs this port
 * knows with their units, typical target range, hard target ceiling, time
 * to peak effect (for the reference patient named in the body) and
 * citation; the accepted unit tokens; and the API's limits.
 */
export function tciApiDrugs() {
  const reference = { weight: 70, height: 170, age: 50, sex: "male" };
  const drugs = TCI_API.DRUGS.map((d) => {
    const row = DRUG_LIBRARY[d];
    const model = modelFor(d, reference.weight, reference.height, reference.age, reference.sex, true);
    const units = baseUnitsFor(row.concentrationUnits);
    return {
      drug: d,
      concentrationUnits: units.concentration,
      massUnits: units.mass,
      sites: ["effect", "plasma"],
      typicalTarget: row.typical,
      typicalRange: { lower: row.lower, upper: row.upper },
      targetCeiling: TCI_API.TARGET_CEILING * row.upper,
      tPeak: model.params.tPeak,
      reference: model.reference,
    };
  });
  return {
    apiVersion: TCI_API.VERSION,
    drugs,
    referencePatient: reference,
    units: {
      rate: [...RATE_UNITS],
      amount: [...AMOUNT_UNITS],
      bolus: [...BOLUS_UNITS],
      concentration: [...CONCENTRATION_UNITS],
      infusate: [...INFUSATE_UNITS],
      volume: [...VOLUME_UNITS],
    },
    limits: {
      minInterval: TCI_API.MIN_INTERVAL,
      maxInterval: TCI_API.MAX_INTERVAL,
      maxHistory: TCI_API.MAX_HISTORY,
      lookAheadMax: TCI_API.LOOKAHEAD_MAX,
      historyClockSkew: TCI_API.CLOCK_SKEW,
      serverClockSkew: TCI_API.SERVER_SKEW,
      maxRate: TCI_API.MAX_RATE,
      minInfusate: TCI_API.MIN_INFUSATE,
      targetCeiling: TCI_API.TARGET_CEILING,
      onTarget: TCI_API.ON_TARGET,
      deliveryTolerance: TCI_API.DELIVERY_TOLERANCE,
      deliveryToleranceMl: TCI_API.DELIVERY_TOLERANCE_ML,
      plasmaSwitch: TCI_API.TCI_PLASMA_SWITCH,
      weight: { ...TCI_API.BOUNDS.weight },
      height: { ...TCI_API.BOUNDS.height },
      age: { ...TCI_API.BOUNDS.age },
      sex: [...SEX_VALUES],
      pumpStates: [...PUMP_STATES],
    },
  };
}

/**
 * The `model` block for a patient, the body of
 * GET /tci/v1/drugs/{drug}/model: port of tciApiModel().  Query-string
 * spellings ("70", "true") are accepted for the numbers and the switch.
 * Throws TciApiError for an unknown or non-TCI drug or a covariate out of
 * range, with pointers /weight, /height, /age, /sex, /adjustToFFM.
 */
export function tciApiModel(drug, weight, height, age, sex, adjustToFFM = true) {
  const d = checkDrug(drug);
  const B = TCI_API.BOUNDS;
  const wt = apiNumber(coerceNumber(weight), "/weight", { min: B.weight.min, max: B.weight.max });
  const ht = apiNumber(coerceNumber(height), "/height", { min: B.height.min, max: B.height.max });
  const ag = apiNumber(coerceNumber(age), "/age", { min: B.age.min, max: B.age.max });
  const sx = apiString(sex, "/sex", { allowed: SEX_VALUES });
  let adjust = apiLogical(coerceLogical(adjustToFFM), "/adjustToFFM", false);
  if (adjust === null) adjust = true;
  return modelBlock(modelFor(d, wt, ht, ag, sx, adjust), adjust);
}

/**
 * The body of GET /tci/v1/health: port of tciApiHealth(), for a transport
 * that answers the liveness probe locally.
 */
export function tciApiHealth(now = new Date()) {
  return {
    apiVersion: TCI_API.VERSION,
    status: "ok",
    package: TCI_API.PACKAGE,
    version: FAUXTCI_VERSION,
    commit: null,
    serverTime: formatRfc3339(toSeconds(now)),
    tciDrugs: TCI_API.DRUGS.length,
  };
}
