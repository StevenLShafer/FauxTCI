// Conformance tests for js/pk.js against the stanpumpR golden fixtures
// (test/fixtures/models.json and test/fixtures/ke0-solve.json), plus an
// independent numerical check of the closed-form recurrence against the
// compartment differential equations.  Each tolerance test reports the
// maximum discrepancy it measured as a TAP diagnostic line, so the figures
// in the README can be read off a test run.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveModel, buildKinetics, advance, bolus, cp, ce, emptyState,
  brentFmin, cube, CE, effectSitePeak, effectSitePeakTime, ke0Bracket, ke0FromTPeakBolus,
  separateEigenvalues, sumR, uniroot, zeroin2, pkSizeFactors, ffmAlSallami, FFM_REFERENCE,
  validateCovariates, baseUnits, OPTIMIZE_TOL, UNIROOT_TOL, DRUG_LIBRARY, DRUG_FUNCTIONS,
} from "../js/pk.js";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const models = await fixture("models.json");
const ke0Solve = await fixture("ke0-solve.json");
const manifest = await fixture("manifest.json");

// Tolerances.  The first two are the figures the fixtures' README asks a port
// to meet; the ke0 figure is the README's aim (its hard bound is 2.5e-4).
const TOL_ARITHMETIC = 1e-10; // relative: parameters, eigenvalues, coefficients with R's ke0 injected
const TOL_KE0 = 1e-9; // relative: the JavaScript ke0 against R's
const TOL_PEAK_MINUTES = 0.01; // the effect-site peak recomputed from the JavaScript ke0
const TOL_INNER_MINUTES = 1e-8; // effectSitePeakTime() against the fixture's, at the same ke0

// 1200 mL/hr of each drug's FauxTCI syringe, in base units per minute: a
// loading rate of the right order for the ODE check.
const LOADING_RATE = { propofol: 200, remifentanil: 1000, sufentanil: 100, remimazolam: 20 };
const TOL_ODE = 1e-9; // relative, advance() against an RK4 integration of the compartment ODEs

// R wrote the fixtures with 15 significant digits: a number computed here
// equals a fixture's when it prints the same at that precision.
const asFixture = (x) => Number(x.toPrecision(15));

const relativeError = (value, reference) =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), Number.MIN_VALUE);

const PARAMETER_NAMES = [
  "v1", "v2", "v3", "cl1", "cl2", "cl3",
  "k10", "k12", "k13", "k21", "k31",
  "lambda_1", "lambda_2", "lambda_3",
];

// The fixture's coefficient names in the order of the coef vectors.
const COEFFICIENT_NAMES = {
  pbolus: ["p_coef_bolus_l1", "p_coef_bolus_l2", "p_coef_bolus_l3"],
  pinf: ["p_coef_infusion_l1", "p_coef_infusion_l2", "p_coef_infusion_l3"],
  ebolus: ["e_coef_bolus_l1", "e_coef_bolus_l2", "e_coef_bolus_l3", "e_coef_bolus_ke0"],
  einf: ["e_coef_infusion_l1", "e_coef_infusion_l2", "e_coef_infusion_l3", "e_coef_infusion_ke0"],
};

const modelFor = (entry, extra = {}) =>
  resolveModel({ drug: entry.drug, ...entry.patient, adjustToFFM: entry.adjustToFFM, ...extra });

test("fixtures are what the README describes", () => {
  // 8 patients: propofol and remifentanil at adjustToFFM TRUE, which they
  // ignore; sufentanil and remimazolam at TRUE and FALSE.
  assert.equal(models.entries.length, 48);
  assert.equal(ke0Solve.entries.length, 48);
  assert.equal(manifest.modelEntries, 48);
  assert.equal(models.stanpumpRCommit, manifest.commit);
  assert.equal(ke0Solve.stanpumpRCommit, manifest.commit);
  assert.deepEqual([...new Set(models.entries.map((e) => e.drug))], Object.keys(DRUG_FUNCTIONS));
  assert.equal(ke0Solve.solver.root.tol, asFixture(UNIROOT_TOL));
  assert.equal(ke0Solve.solver.peak.tol, asFixture(OPTIMIZE_TOL));
  assert.deepEqual(ke0Solve.solver.root.bracketStart, [1e-3, 1]);
});

test("parameters, eigenvalues and every coefficient match models.json with R's ke0 injected", (t) => {
  let worst = { value: 0 };
  let worstCoefficient = { value: 0 };
  for (const entry of models.entries) {
    const model = modelFor(entry, { ke0: entry.pk.ke0 });
    assert.equal(model.params.ke0, entry.pk.ke0);
    for (const name of PARAMETER_NAMES) {
      const err = relativeError(model.params[name], entry.pk[name]);
      if (err > worst.value) worst = { value: err, name, entry: `${entry.drug}/${entry.patientId}` };
      assert.ok(err <= TOL_ARITHMETIC,
        `${entry.drug} ${entry.patientId} ${name}: ${model.params[name]} vs ${entry.pk[name]} (rel ${err})`);
    }
    for (const [vector, names] of Object.entries(COEFFICIENT_NAMES)) {
      names.forEach((name, i) => {
        const err = relativeError(model.coef[vector][i], entry.pk[name]);
        if (err > worstCoefficient.value) {
          worstCoefficient = { value: err, name, entry: `${entry.drug}/${entry.patientId}` };
        }
        assert.ok(err <= TOL_ARITHMETIC,
          `${entry.drug} ${entry.patientId} ${name}: ${model.coef[vector][i]} vs ${entry.pk[name]} (rel ${err})`);
      });
    }
    // lambda4 is tciKinetics()'s c(lambda3, ke0).
    assert.deepEqual(model.lambda4.slice(0, 3), [model.params.lambda_1, model.params.lambda_2, model.params.lambda_3]);
    assert.equal(model.lambda4[3], entry.pk.ke0);
    assert.deepEqual(model.lambda3, model.lambda4.slice(0, 3));
    // The lambdas are sorted decreasing, as cube() returns them.
    assert.ok(model.params.lambda_1 > model.params.lambda_2 && model.params.lambda_2 > model.params.lambda_3);
    // Every other coefficient in the fixture (oral, IM, IN, SL, RA, PO2) is
    // zero for these IV drugs, so the IV-only port is the whole model.
    const ported = new Set(Object.values(COEFFICIENT_NAMES).flat());
    for (const [name, value] of Object.entries(entry.pk)) {
      if (/coef/.test(name) && !ported.has(name)) assert.equal(value, 0, `${name} should be 0`);
    }
  }
  t.diagnostic(`max relative error, parameters and eigenvalues: ${worst.value.toExponential(3)} ` +
    `(${worst.name}, ${worst.entry}; tolerance ${TOL_ARITHMETIC})`);
  t.diagnostic(`max relative error, coefficients: ${worstCoefficient.value.toExponential(3)} ` +
    `(${worstCoefficient.name}, ${worstCoefficient.entry}; tolerance ${TOL_ARITHMETIC})`);
});

test("the solved ke0, and remimazolam's solved tPeak, match R's for all 48 models", (t) => {
  let worst = { value: 0 };
  for (const entry of models.entries) {
    const model = modelFor(entry);
    const err = relativeError(model.params.ke0, entry.pk.ke0);
    if (err > worst.value) worst = { value: err, entry: `${entry.drug}/${entry.patientId}` };
    assert.ok(err <= TOL_KE0,
      `${entry.drug} ${entry.patientId} ke0 ${model.params.ke0} vs ${entry.pk.ke0} (rel ${err})`);
    // With its own ke0 the model's effect-site coefficients are still within
    // the arithmetic tolerance of the fixture's, since ke0 itself is.
    COEFFICIENT_NAMES.ebolus.forEach((name, i) => {
      assert.ok(relativeError(model.coef.ebolus[i], entry.pk[name]) <= 1e-9, name);
    });
    assert.ok(Math.abs(model.params.tPeak - entry.tPeak) <= 1e-9,
      `${entry.drug} ${entry.patientId} tPeak ${model.params.tPeak} vs ${entry.tPeak}`);
  }
  t.diagnostic(`max relative error, ke0 from the covariates: ${worst.value.toExponential(3)} ` +
    `(${worst.entry}; tolerance ${TOL_KE0}, README hard bound 2.5e-4)`);
});

test("the solve from ke0-solve.json's inputs reproduces R's bracket, ke0, tPeak and peak times", (t) => {
  let worstKe0 = 0;
  let worstTPeak = 0;
  let worstPeak = 0;
  for (const entry of ke0Solve.entries) {
    const { p_coef_bolus: p, lambda } = entry.inputs;
    const label = `${entry.drug} ${entry.patientId} adjustToFFM=${entry.adjustToFFM}`;
    if (entry.solve === "ke0FromTPeak") {
      // The bracket is decided by comparisons, so it must be R's exactly.
      const bracket = ke0Bracket(entry.tPeak, p, lambda);
      assert.equal(bracket.lower, entry.bracket.lower, `${label} bracket lower`);
      assert.equal(bracket.upper, entry.bracket.upper, `${label} bracket upper`);
      const ke0 = ke0FromTPeakBolus(entry.tPeak, p, lambda);
      worstKe0 = Math.max(worstKe0, relativeError(ke0, entry.ke0BeforeSeparation));
      assert.ok(relativeError(ke0, entry.ke0BeforeSeparation) <= TOL_KE0, `${label} ke0 ${ke0} vs ${entry.ke0BeforeSeparation}`);
      // separateEigenvalues() leaves a ke0 that ties with no eigenvalue alone.
      assert.equal(separateEigenvalues(entry.ke0BeforeSeparation, lambda), entry.ke0);
    } else {
      assert.equal(entry.solve, "tPeakFromKe0");
      assert.equal(entry.modelKe0, asFixture(Math.exp(-1.20976)));
      const tPeak = effectSitePeakTime(p, lambda, entry.modelKe0);
      worstTPeak = Math.max(worstTPeak, Math.abs(tPeak - entry.tPeakResolved));
      assert.ok(Math.abs(tPeak - entry.tPeakResolved) <= TOL_INNER_MINUTES, `${label} tPeak ${tPeak} vs ${entry.tPeakResolved}`);
    }

    // The effect-site coefficients getDrugPK() builds at R's ke0.
    const e = p.map((pi, i) => pi / (entry.ke0 - lambda[i]) * entry.ke0);
    e.push(-e[0] - e[1] - e[2]);
    e.forEach((value, i) => assert.ok(relativeError(value, entry.e_coef_bolus[i]) <= TOL_ARITHMETIC));

    // effectSitePeakTime() at R's ke0, and at the sample points around it.
    const peak = effectSitePeak(p, lambda, entry.ke0);
    // 20 / the slowest rate, from 15-digit inputs: equal to the last digit or so.
    assert.ok(relativeError(peak.window, entry.roundTrip.window) <= 1e-13, `${label} search window`);
    worstPeak = Math.max(worstPeak, Math.abs(peak.time - entry.roundTrip.peakTime));
    assert.ok(Math.abs(peak.time - entry.roundTrip.peakTime) <= TOL_INNER_MINUTES, `${label} peak ${peak.time}`);
    assert.ok(relativeError(CE(peak.time, ...e, ...lambda, entry.ke0), entry.roundTrip.ceAtPeak) <= 1e-12);
    for (const sample of entry.peakSamples) {
      const at = effectSitePeak(p, lambda, sample.ke0);
      assert.ok(relativeError(at.window, sample.window) <= 1e-13, `${label} window at ke0 ${sample.ke0}`);
      worstPeak = Math.max(worstPeak, Math.abs(at.time - sample.peakTime));
      assert.ok(Math.abs(at.time - sample.peakTime) <= TOL_INNER_MINUTES,
        `${label} peak at ke0 ${sample.ke0}: ${at.time} vs ${sample.peakTime}`);
    }
  }
  t.diagnostic(`max relative error, ke0 from the fixture's own inputs: ${worstKe0.toExponential(3)} (tolerance ${TOL_KE0})`);
  t.diagnostic(`max |remimazolam tPeak - fixture| (min): ${worstTPeak.toExponential(3)} (tolerance ${TOL_INNER_MINUTES})`);
  t.diagnostic(`max |effectSitePeakTime - fixture| (min): ${worstPeak.toExponential(3)} (tolerance ${TOL_INNER_MINUTES})`);
});

test("the effect site after a unit bolus peaks at tPeak with the JavaScript ke0", (t) => {
  let worst = { value: 0 };
  for (const entry of models.entries) {
    const model = modelFor(entry);
    // The inner optimizer's answer, and a fine grid as a second opinion that
    // does not share the optimizer's code.
    const peak = effectSitePeakTime(model.coef.pbolus, model.lambda3, model.params.ke0);
    const unit = bolus(emptyState(), 1, model);
    let gridPeak = 0;
    let gridMax = -Infinity;
    const steps = Math.ceil((entry.tPeak + 2) * 1000);
    for (let step = 0; step <= steps; step++) {
      const time = step * 0.001; // 0 .. tPeak + 2 min by 0.001
      const value = ce(advance(unit, time, 0, model));
      if (value > gridMax) { gridMax = value; gridPeak = time; }
    }
    const miss = Math.abs(peak - entry.tPeak);
    if (miss > worst.value) worst = { value: miss, entry: `${entry.drug}/${entry.patientId}` };
    assert.ok(miss <= TOL_PEAK_MINUTES, `${entry.drug} ${entry.patientId}: peak ${peak} vs tPeak ${entry.tPeak}`);
    assert.ok(Math.abs(gridPeak - entry.tPeak) <= TOL_PEAK_MINUTES, `grid peak ${gridPeak}`);
    // ...and the concentration there is the fixture's (1 / vdPeakEffect).
    const ceAtPeak = ce(advance(unit, peak, 0, model));
    const reference = ke0Solve.entries.find((k) => k.drug === entry.drug && k.patientId === entry.patientId &&
      k.adjustToFFM === entry.adjustToFFM);
    assert.ok(relativeError(ceAtPeak, reference.roundTrip.ceAtPeak) <= 1e-9);
  }
  t.diagnostic(`max |peak time - tPeak| (min) with the JavaScript ke0: ${worst.value.toExponential(3)} ` +
    `(tolerance ${TOL_PEAK_MINUTES})`);
});

// Classical fourth-order Runge-Kutta on the three-compartment amounts and the
// effect site, the textbook model the closed form solves: an independent
// check of the eigenvalues, coefficients and recurrence together.
function integrateCompartments(model, dtMinutes, rateBasePerMin, initialAmounts, steps = 2000) {
  const { v1, k10, k12, k13, k21, k31, ke0 } = model.params;
  const derivative = ([a1, a2, a3, effect]) => [
    rateBasePerMin - (k10 + k12 + k13) * a1 + k21 * a2 + k31 * a3,
    k12 * a1 - k21 * a2,
    k13 * a1 - k31 * a3,
    ke0 * (a1 / v1 - effect),
  ];
  const h = dtMinutes / steps;
  let y = [...initialAmounts, 0];
  for (let step = 0; step < steps; step++) {
    const k1 = derivative(y);
    const k2 = derivative(y.map((v, i) => v + 0.5 * h * k1[i]));
    const k3 = derivative(y.map((v, i) => v + 0.5 * h * k2[i]));
    const k4 = derivative(y.map((v, i) => v + h * k3[i]));
    y = y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }
  return { cp: y[0] / v1, ce: y[3] };
}

test("advance() over one 10 s step at a constant rate agrees with the compartment ODEs", (t) => {
  let worst = 0;
  for (const entry of models.entries) {
    const model = modelFor(entry, { ke0: entry.pk.ke0 });
    const dt = 10 / 60;
    const rate = LOADING_RATE[entry.drug];

    // From nothing on board.
    const closed = advance(emptyState(), dt, rate, model);
    const ode = integrateCompartments(model, dt, rate, [0, 0, 0]);
    worst = Math.max(worst, relativeError(cp(closed), ode.cp), relativeError(ce(closed), ode.ce));
    assert.ok(relativeError(cp(closed), ode.cp) <= TOL_ODE, `${entry.drug} ${entry.patientId} Cp ${cp(closed)} vs ${ode.cp}`);
    assert.ok(relativeError(ce(closed), ode.ce) <= TOL_ODE, `${entry.drug} ${entry.patientId} Ce ${ce(closed)} vs ${ode.ce}`);

    // From a bolus of 100 base units just given, so the bolus coefficients
    // and the homogeneous part of the recurrence are exercised too.
    const afterBolus = advance(bolus(emptyState(), 100, model), dt, rate, model);
    const odeBolus = integrateCompartments(model, dt, rate, [100, 0, 0]);
    worst = Math.max(worst, relativeError(cp(afterBolus), odeBolus.cp), relativeError(ce(afterBolus), odeBolus.ce));
    assert.ok(relativeError(cp(afterBolus), odeBolus.cp) <= TOL_ODE);
    assert.ok(relativeError(ce(afterBolus), odeBolus.ce) <= TOL_ODE);

    // The semigroup property of the exact solution: one 10 s step equals
    // ten 1 s steps.
    let stepped = bolus(emptyState(), 100, model);
    for (let i = 0; i < 10; i++) stepped = advance(stepped, 1 / 60, rate, model);
    assert.ok(relativeError(cp(stepped), cp(afterBolus)) <= 1e-12);
    assert.ok(relativeError(ce(stepped), ce(afterBolus)) <= 1e-12);

    // The one-step closed form, written out: the sum of pinf R (1 - exp(-lambda dt)).
    const analytic = model.coef.pinf.reduce((sum, c, i) => sum + c * rate * (1 - Math.exp(-model.lambda3[i] * dt)), 0);
    assert.ok(relativeError(cp(closed), analytic) <= 1e-14);
  }
  t.diagnostic(`max relative error, advance() against RK4 on the compartment ODEs: ${worst.toExponential(3)} (tolerance ${TOL_ODE})`);
});

test("advance() and bolus() return new states and leave the input alone", () => {
  const model = resolveModel({ drug: "propofol", weight: 70, height: 170, age: 50, sex: "male" });
  const start = emptyState();
  const next = advance(start, 1, 10, model);
  assert.deepEqual(start, emptyState());
  assert.notEqual(next, start);
  assert.ok(cp(next) > 0 && ce(next) > 0 && ce(next) < cp(next));
  const dosed = bolus(start, 20, model);
  assert.deepEqual(start, emptyState());
  // Cp(0+) = dose / v1 (the plasma bolus coefficients sum to 1/v1) and Ce(0+) = 0.
  assert.ok(relativeError(cp(dosed), 20 / model.params.v1) <= 1e-12);
  assert.ok(Math.abs(ce(dosed)) <= 1e-12);
  // Nothing happens at rate 0 from an empty state, and a zero-length step is the identity.
  assert.deepEqual(advance(start, 1, 0, model), emptyState());
  assert.deepEqual(advance(dosed, 0, 50, model), dosed);
});

test("units, library row, reference and branch are the fixtures'", () => {
  for (const entry of models.entries) {
    const model = modelFor(entry);
    assert.equal(model.drug, entry.drug);
    assert.equal(model.concentrationUnits, entry.model.concentrationUnits);
    assert.equal(model.massUnits, entry.model.massUnits);
    assert.equal(model.reference, entry.reference);
    assert.equal(model.reference, entry.model.reference);
    assert.equal(model.branch, entry.branch);
    assert.ok(Math.abs(model.params.tPeak - entry.tPeak) <= 1e-9, `${entry.drug} tPeak`);
    assert.equal(model.typical, entry.typical);
    assert.equal(model.upper, entry.upperTypical);
    assert.equal(model.lower, entry.lowerTypical);
    assert.equal(model.adjustToFFM, entry.adjustToFFM);
    assert.equal(DRUG_LIBRARY[entry.drug].concentrationUnits, entry["Concentration.Units"]);
    assert.equal(DRUG_LIBRARY[entry.drug].bolusUnits, entry["Bolus.Units"]);
  }
  const propofol = resolveModel({ drug: "propofol", weight: 70, height: 170, age: 50, sex: "male" });
  assert.equal(propofol.concentrationUnits, "mcg/mL");
  assert.equal(propofol.massUnits, "mg");
  const remifentanil = resolveModel({ drug: "remifentanil", weight: 70, height: 170, age: 50, sex: "male" });
  assert.equal(remifentanil.concentrationUnits, "ng/mL");
  assert.equal(remifentanil.massUnits, "mcg");
  const sufentanil = resolveModel({ drug: "sufentanil", weight: 70, height: 170, age: 50, sex: "male" });
  assert.equal(sufentanil.concentrationUnits, "ng/mL");
  assert.equal(sufentanil.massUnits, "mcg");
  const remimazolam = resolveModel({ drug: "remimazolam", weight: 70, height: 170, age: 50, sex: "male" });
  assert.equal(remimazolam.concentrationUnits, "mcg/mL");
  assert.equal(remimazolam.massUnits, "mg");
  assert.deepEqual(baseUnits("ng"), { massUnits: "mcg", concentrationUnits: "ng/mL" });
  assert.deepEqual(baseUnits("mcg"), { massUnits: "mg", concentrationUnits: "mcg/mL" });
});

test("remifentanil switches from Eleveld 2017 to Kim 2017 at a BMI of 30 in adults", () => {
  // 97.2 kg at 180 cm is a BMI of exactly 30.
  const below = resolveModel({ drug: "remifentanil", weight: 97.1, height: 180, age: 40, sex: "male" });
  const at = resolveModel({ drug: "remifentanil", weight: 97.2, height: 180, age: 40, sex: "male" });
  assert.equal(below.branch, "eleveld2017");
  assert.equal(at.branch, "kim2017");
  assert.match(below.reference, /Eleveld DJ et al., Anesthesiology 2017/);
  assert.match(at.reference, /Kim TK et al., Anesthesiology 2017/);
  // Kim: cl3 is the fixed 0.197 L/min and v3 is linear in age.
  assert.equal(at.params.cl3, 0.197);
  assert.equal(at.params.v3, 4 - 0.0477 * (40 - 37));
  // Kim was fitted in adults: a 17-year-old at BMI 30 gets Eleveld.
  const teen = resolveModel({ drug: "remifentanil", weight: 97.2, height: 180, age: 17, sex: "male" });
  assert.equal(teen.branch, "eleveld2017");
  assert.equal(resolveModel({ drug: "remifentanil", weight: 97.2, height: 180, age: 18, sex: "male" }).branch, "kim2017");
  // Kim's linear age terms can make a parameter non-positive (V2 here, in a
  // short, old, obese patient): Eleveld is used and the citation says why.
  const fallback = resolveModel({ drug: "remifentanil", weight: 25, height: 90, age: 90, sex: "male" });
  assert.equal(fallback.branch, "eleveld2017");
  assert.match(fallback.reference,
    /^Eleveld DJ et al., Anesthesiology 2017.* \(Kim's model for obesity gives a non-positive V2 for this patient, so Eleveld's is used\)$/);
  // adjustToFFM is accepted and ignored by both drugs, as in the R.
  for (const drug of ["propofol", "remifentanil"]) {
    const on = resolveModel({ drug, weight: 60, height: 165, age: 35, sex: "female", adjustToFFM: true });
    const off = resolveModel({ drug, weight: 60, height: 165, age: 35, sex: "female", adjustToFFM: false });
    assert.deepEqual(on.params, off.params);
    assert.equal(on.adjustToFFM, true);
    assert.equal(off.adjustToFFM, false);
  }
});

test("sufentanil and remimazolam scale with fat-free mass, and adjustToFFM selects the legacy factors", () => {
  // The reference man: fat-free mass is the reference's, so the factors are 1.
  const reference = pkSizeFactors(70, 170, 35, "male");
  assert.equal(reference.volume, 1);
  assert.equal(reference.clearance, 1);
  assert.equal(FFM_REFERENCE, ffmAlSallami(70, 170, 35, "male"));
  assert.ok(Math.abs(FFM_REFERENCE - 54.48) < 0.01);
  // The fixtures' own pkSizeFactors() for every scaled entry.
  for (const entry of models.entries.filter((e) => e.drugFunction.size)) {
    const { weight, height, age, sex } = entry.patient;
    const size = pkSizeFactors(weight, height, age, sex, entry.adjustToFFM,
      ...(entry.drug === "sufentanil" ? [1] : [undefined, Math.pow(weight / 70, 0.75)]));
    for (const name of ["volume", "clearance", "ffm", "ffmReference", "pkWeight"]) {
      assert.ok(relativeError(size[name], entry.drugFunction.size[name]) <= TOL_ARITHMETIC,
        `${entry.drug} ${entry.patientId} ${entry.adjustToFFM} ${name}`);
    }
  }
  // adjustToFFM false: sufentanil is Gepts' 70 kg parameters as printed.
  const gepts = resolveModel({ drug: "sufentanil", weight: 120, height: 175, age: 45, sex: "female", adjustToFFM: false });
  assert.deepEqual([gepts.params.v1, gepts.params.v2, gepts.params.v3, gepts.params.cl1, gepts.params.cl2, gepts.params.cl3],
    [14.3, 63.1, 261.6, 0.92, 1.55, 0.33]);
  const scaled = resolveModel({ drug: "sufentanil", weight: 120, height: 175, age: 45, sex: "female" });
  assert.notEqual(scaled.params.v1, 14.3);
  // Remimazolam: ke0 is the model's at both positions; only tPeak moves.
  for (const adjustToFFM of [true, false]) {
    const r = resolveModel({ drug: "remimazolam", weight: 120, height: 175, age: 45, sex: "female", adjustToFFM });
    assert.equal(r.params.ke0, Math.exp(-1.20976));
    assert.ok(r.params.tPeak > 1.5 && r.params.tPeak < 4, `${r.params.tPeak}`);
  }
});

test("covariates are validated and unknown drugs refused", () => {
  const good = { drug: "propofol", weight: 70, height: 170, age: 50, sex: "male" };
  assert.doesNotThrow(() => resolveModel(good));
  // The bounds are inclusive, as the API's.
  assert.doesNotThrow(() => resolveModel({ ...good, weight: 0.1, height: 10, age: 0 }));
  assert.doesNotThrow(() => resolveModel({ ...good, weight: 500, height: 200, age: 90, sex: "female" }));
  assert.throws(() => resolveModel({ ...good, weight: 0 }), /patient\.weight/);
  assert.throws(() => resolveModel({ ...good, weight: 500.1 }), /patient\.weight/);
  assert.throws(() => resolveModel({ ...good, height: 9.9 }), /patient\.height/);
  assert.throws(() => resolveModel({ ...good, height: 201 }), /patient\.height/);
  assert.throws(() => resolveModel({ ...good, age: -0.1 }), /patient\.age/);
  assert.throws(() => resolveModel({ ...good, age: 91 }), /patient\.age/);
  assert.throws(() => resolveModel({ ...good, weight: "70" }), /patient\.weight/);
  assert.throws(() => resolveModel({ ...good, weight: NaN }), /patient\.weight/);
  assert.throws(() => resolveModel({ ...good, weight: Infinity }), /patient\.weight/);
  assert.throws(() => resolveModel({ ...good, sex: "Male" }), /patient\.sex/);
  assert.throws(() => resolveModel({ ...good, sex: "M" }), /patient\.sex/);
  assert.throws(() => resolveModel({ ...good, sex: undefined }), /patient\.sex/);
  assert.throws(() => resolveModel({ ...good, drug: "midazolam" }), /unknown drug/);
  assert.throws(() => resolveModel({ ...good, drug: "Propofol" }), /unknown drug/);
  assert.throws(() => resolveModel({ ...good, drug: "toString" }), /unknown drug/);
  assert.throws(() => resolveModel({ ...good, drug: undefined }), /unknown drug/);
  assert.throws(() => resolveModel(), /unknown drug/);
  assert.throws(() => resolveModel({ ...good, ke0: -1 }), /ke0/);
  for (const bad of [{}, { weight: 70 }, { weight: 70, height: 170, age: 50, sex: "other" }]) {
    assert.throws(() => validateCovariates(bad), Error);
  }
  // A plain Error, nothing fancier, so a caller can show the message as is.
  try { resolveModel({ ...good, age: 200 }); assert.fail("should throw"); } catch (err) {
    assert.equal(err.constructor, Error);
    assert.match(err.message, /between 0 and 90/);
  }
});

test("cube() returns the eigenvalues of the three-compartment model, sorted decreasing", () => {
  for (const entry of models.entries) {
    const { k10, k12, k13, k21, k31 } = entry.pk;
    const roots = cube(k10, k12, k13, k21, k31);
    assert.ok(roots[0] > roots[1] && roots[1] > roots[2] && roots[2] > 0);
    // Vieta: the lambdas solve x^3 - a2 x^2 + a1 x - a0 = 0.
    const a0 = k10 * k21 * k31;
    const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
    const a2 = k10 + k12 + k13 + k21 + k31;
    assert.ok(relativeError(roots[0] + roots[1] + roots[2], a2) <= 1e-12);
    assert.ok(relativeError(roots[0] * roots[1] + roots[0] * roots[2] + roots[1] * roots[2], a1) <= 1e-12);
    assert.ok(relativeError(roots[0] * roots[1] * roots[2], a0) <= 1e-12);
    assert.ok(relativeError(roots[0], entry.pk.lambda_1) <= TOL_ARITHMETIC);
    assert.ok(relativeError(roots[1], entry.pk.lambda_2) <= TOL_ARITHMETIC);
    assert.ok(relativeError(roots[2], entry.pk.lambda_3) <= TOL_ARITHMETIC);
  }
  // The two-compartment branch (k31 = 0): roots of x^2 - (k10 + k12 + k21) x + k10 k21.
  const two = cube(0.2, 0.1, 0, 0.05, 0);
  assert.ok(relativeError(two[0] + two[1], 0.35) <= 1e-14);
  assert.ok(relativeError(two[0] * two[1], 0.01) <= 1e-14);
  assert.equal(two[2], 0);
  // The one-compartment branch: k10 alone.
  assert.deepEqual(cube(0.2, 0, 0, 0, 0), [0.2, 0, 0]);
});

test("buildKinetics() is the coefficient builder on its own", () => {
  for (const entry of models.entries) {
    const kinetics = buildKinetics(entry.drugFunction.PK, entry.tPeak, entry.pk.ke0);
    for (const [vector, names] of Object.entries(COEFFICIENT_NAMES)) {
      names.forEach((name, i) => assert.ok(relativeError(kinetics.coef[vector][i], entry.pk[name]) <= TOL_ARITHMETIC, name));
    }
    assert.equal(kinetics.params.ke0, entry.pk.ke0);
    assert.equal(kinetics.params.tPeak, entry.tPeak);
    assert.deepEqual(kinetics.lambda3, kinetics.lambda4.slice(0, 3));
  }
  // A model that gives ke0 and no tPeak gets its tPeak solved from the ke0.
  const remi = models.entries.find((e) => e.drug === "remimazolam");
  const fromKe0 = buildKinetics(remi.drugFunction.PK, null, null, remi.drugFunction.ke0);
  assert.equal(fromKe0.params.ke0, remi.pk.ke0);
  assert.ok(Math.abs(fromKe0.params.tPeak - remi.tPeak) <= 1e-9);
  // Without a time to peak effect there is no effect site: ke0 and every e coefficient are 0.
  const none = buildKinetics(models.entries[0].drugFunction.PK, 0);
  assert.equal(none.params.ke0, 0);
  assert.equal(none.params.tPeak, 0);
  assert.deepEqual(none.coef.ebolus, [0, 0, 0, 0]);
  assert.deepEqual(none.coef.einf, [0, 0, 0, 0]);
  assert.throws(() => buildKinetics({ v1: 1, v2: 1, v3: 1, cl1: 1, cl2: 1, cl3: "x" }, 1.6), /cl3/);
});

test("brentFmin() is R's Brent_fmin", () => {
  // A parabola: the parabolic step lands on the minimum.
  const x = brentFmin((z) => (z - 2) * (z - 2) + 1, 0, 5, OPTIMIZE_TOL);
  assert.ok(Math.abs(x - 2) <= 1e-6, `${x}`);
  // Maximise by negating, as optimize(maximum = TRUE) does.
  const peak = brentFmin((z) => -Math.sin(z), 0, 3, OPTIMIZE_TOL);
  assert.ok(Math.abs(peak - Math.PI / 2) <= 1e-4, `${peak}`);
  // The stopping width is 2 (sqrt(eps) |x| + tol / 3): a tighter tol gets closer.
  const tight = brentFmin((z) => -Math.sin(z), 0, 3, 1e-10);
  assert.ok(Math.abs(tight - Math.PI / 2) <= 1e-7, `${tight}`);
  // Non-finite values are replaced by the largest double, so the search
  // steps away from a pole instead of failing.
  const guarded = brentFmin((z) => (z < 1 ? Infinity : (z - 3) * (z - 3)), 0, 10, OPTIMIZE_TOL);
  assert.ok(Number.isFinite(guarded) && Math.abs(guarded - 3) <= 1e-6, `${guarded}`);
  // R's default tolerance is 2^-13.
  assert.equal(OPTIMIZE_TOL, 2 ** -13);
  assert.throws(() => brentFmin((z) => z, 1, 1), /interval/);
  assert.throws(() => brentFmin((z) => z, 0, 1, 0), /tol/);
});

test("uniroot() and zeroin2() are R's", () => {
  // A root at an end point is returned as is.
  assert.equal(zeroin2((x) => x, 0, 1, 0, 1, 1e-8), 0);
  // sqrt(2) to the tolerance asked for.
  const root = uniroot((x) => x * x - 2, 0, 2, 1e-12);
  assert.ok(Math.abs(root - Math.SQRT2) <= 1e-12, `${root}`);
  // A monotone decreasing function, as effectSitePeakTime(ke0) - tPeak is.
  const down = uniroot((x) => Math.exp(-x) - 0.5, 0, 5, UNIROOT_TOL);
  assert.ok(Math.abs(down - Math.LN2) <= 1e-7, `${down}`);
  assert.throws(() => uniroot((x) => x * x + 1, -1, 1), /opposite sign/);
  assert.throws(() => uniroot((x) => x, 1, 1), /lower < upper/);
  assert.equal(UNIROOT_TOL, Math.sqrt(Number.EPSILON));
});

test("sumR() adds as R's long-double sum() does", () => {
  // R: sum(c(0.1, 0.2, 0.3)) == 0.6, where a double left-to-right sum is not.
  assert.equal(sumR([0.1, 0.2, 0.3]), 0.6);
  assert.notEqual(0.1 + 0.2 + 0.3, 0.6);
  // R: sum(c(1e16, 1, -1e16)) is 1 (the long double holds the 1).
  assert.equal(sumR([1e16, 1, -1e16]), 1);
  // R: sum(c(1e20, 1, -1e20)) is 0 (beyond a 64-bit significand).
  assert.equal(sumR([1e20, 1, -1e20]), 0);
  assert.equal(sumR([]), 0);
  assert.equal(sumR([-2.5]), -2.5);
  assert.equal(sumR([1, Infinity]), Infinity);
});
