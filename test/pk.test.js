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
  brentFmin, cube, CE, tPeakError, peakTimeForKe0, ke0FromTPeak,
  validateCovariates, baseUnits, OPTIMIZE_TOL, DRUG_LIBRARY,
} from "../js/pk.js";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const models = await fixture("models.json");
const ke0Solve = await fixture("ke0-solve.json");

// Tolerances.  The first two are the figures the fixtures' README asks a port
// to meet; the ke0 figure is the README's aim (its hard bound is 2.5e-4).
const TOL_ARITHMETIC = 1e-10; // relative: parameters, eigenvalues, coefficients with R's ke0 injected
const TOL_KE0 = 1e-6; // relative: the JavaScript ke0 against R's
const TOL_PEAK_MINUTES = 0.01; // the effect-site peak recomputed from the JavaScript ke0
const TOL_INNER_MINUTES = 1e-8; // the inner optimizer's peak time against the fixture's round trip
const TOL_OBJECTIVE = 1e-8; // absolute, tPeakError() and predPeak at the fixture's sample points
const TOL_ODE = 1e-9; // relative, advance() against an RK4 integration of the compartment ODEs

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
  assert.equal(models.entries.length, 16);
  assert.equal(ke0Solve.entries.length, 16);
  assert.equal(models.stanpumpRCommit, "7d2d2f1b7727f39eba313fd8c5deea5b5104d959");
  assert.equal(ke0Solve.optimizer.outer.tol, OPTIMIZE_TOL);
  assert.equal(ke0Solve.optimizer.inner.tol, OPTIMIZE_TOL);
  assert.deepEqual(ke0Solve.optimizer.outer.interval, [0, 200]);
  assert.deepEqual(ke0Solve.optimizer.inner.interval, [0, 100]);
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

test("the solved ke0 matches R's for all 16 models", (t) => {
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
  }
  t.diagnostic(`max relative error, ke0 from the covariates: ${worst.value.toExponential(3)} ` +
    `(${worst.entry}; tolerance ${TOL_KE0}, README hard bound 2.5e-4)`);
});

test("the solve from ke0-solve.json's inputs reproduces R's ke0, objective and inner peak", (t) => {
  let worstKe0 = 0;
  let worstInner = 0;
  let worstObjective = 0;
  let worstPredPeak = 0;
  for (const entry of ke0Solve.entries) {
    const { p_coef_bolus: p, lambda } = entry.inputs;
    const ke0 = ke0FromTPeak(entry.tPeak, p, lambda);
    worstKe0 = Math.max(worstKe0, relativeError(ke0, entry.ke0));
    assert.ok(relativeError(ke0, entry.ke0) <= TOL_KE0, `${entry.drug} ${entry.patientId} ke0 ${ke0} vs ${entry.ke0}`);

    // The round trip: what the inner optimizer saw at R's ke0.
    const inner = peakTimeForKe0(entry.ke0, ...p, ...lambda);
    worstInner = Math.max(worstInner, Math.abs(inner - entry.roundTrip.peakTimeInnerOptimize));
    assert.ok(Math.abs(inner - entry.roundTrip.peakTimeInnerOptimize) <= TOL_INNER_MINUTES);

    // The effect-site coefficients tPeakError() builds at R's ke0.
    const e = p.map((pi, i) => pi / (entry.ke0 - lambda[i]) * entry.ke0);
    e.push(-e[0] - e[1] - e[2]);
    e.forEach((value, i) => assert.ok(relativeError(value, entry.e_coef_bolus[i]) <= TOL_ARITHMETIC));
    assert.ok(Math.abs(CE(inner, ...e, ...lambda, entry.ke0) - entry.roundTrip.ceAtPeakInnerOptimize) <= 1e-12);

    // The objective function, inner optimizer included, at the sample points.
    for (const sample of entry.objectiveSamples) {
      const objective = tPeakError(sample.ke0, entry.tPeak, ...p, ...lambda);
      const predPeak = peakTimeForKe0(sample.ke0, ...p, ...lambda);
      worstObjective = Math.max(worstObjective, Math.abs(objective - sample.objective));
      worstPredPeak = Math.max(worstPredPeak, Math.abs(predPeak - sample.predPeak));
      assert.ok(Math.abs(objective - sample.objective) <= TOL_OBJECTIVE,
        `${entry.drug} ${entry.patientId} objective at ke0 ${sample.ke0}: ${objective} vs ${sample.objective}`);
      assert.ok(Math.abs(predPeak - sample.predPeak) <= TOL_OBJECTIVE,
        `${entry.drug} ${entry.patientId} predPeak at ke0 ${sample.ke0}: ${predPeak} vs ${sample.predPeak}`);
    }
  }
  t.diagnostic(`max relative error, ke0 from the fixture's own inputs: ${worstKe0.toExponential(3)} (tolerance ${TOL_KE0})`);
  t.diagnostic(`max |inner peak time - fixture| (min): ${worstInner.toExponential(3)} (tolerance ${TOL_INNER_MINUTES})`);
  t.diagnostic(`max |tPeakError - fixture|: ${worstObjective.toExponential(3)}, ` +
    `max |predPeak - fixture| (min): ${worstPredPeak.toExponential(3)} (tolerance ${TOL_OBJECTIVE})`);
});

test("the effect site after a unit bolus peaks at tPeak with the JavaScript ke0", (t) => {
  let worst = { value: 0 };
  for (const entry of models.entries) {
    const model = modelFor(entry);
    // The inner optimizer's answer, and a fine grid as a second opinion that
    // does not share the optimizer's code.
    const peak = peakTimeForKe0(model.params.ke0, ...model.coef.pbolus, ...model.lambda3);
    const unit = bolus(emptyState(), 1, model);
    let gridPeak = 0;
    let gridMax = -Infinity;
    for (let step = 0; step <= 4000; step++) {
      const time = step * 0.001; // 0 .. 4 min by 0.001
      const value = ce(advance(unit, time, 0, model));
      if (value > gridMax) { gridMax = value; gridPeak = time; }
    }
    const miss = Math.abs(peak - entry.tPeak);
    if (miss > worst.value) worst = { value: miss, entry: `${entry.drug}/${entry.patientId}` };
    assert.ok(miss <= TOL_PEAK_MINUTES, `${entry.drug} ${entry.patientId}: peak ${peak} vs tPeak ${entry.tPeak}`);
    assert.ok(Math.abs(gridPeak - entry.tPeak) <= TOL_PEAK_MINUTES, `grid peak ${gridPeak}`);
    // ...and the concentration there is the fixture's (1 / vdPeakEffect).
    const ceAtPeak = ce(advance(unit, peak, 0, model));
    const reference = ke0Solve.entries.find((k) => k.drug === entry.drug && k.patientId === entry.patientId);
    assert.ok(relativeError(ceAtPeak, reference.roundTrip.ceAtPeakInnerOptimize) <= 1e-9);
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
    // A loading rate of the right order: 1200 mL/hr of 1% propofol is 200
    // mg/min; 1200 mL/hr of 50 mcg/mL remifentanil is 1000 mcg/min.
    const rate = entry.drug === "propofol" ? 200 : 1000;

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
    assert.equal(model.params.tPeak, entry.tPeak);
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
  assert.deepEqual(baseUnits("ng"), { massUnits: "mcg", concentrationUnits: "ng/mL" });
  assert.deepEqual(baseUnits("mcg"), { massUnits: "mg", concentrationUnits: "mcg/mL" });
});

test("remifentanil switches from Eleveld 2017 to Kim 2017 at a BMI of 30", () => {
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
  // adjustToFFM is accepted and ignored by both drugs, as in the R.
  for (const drug of ["propofol", "remifentanil"]) {
    const on = resolveModel({ drug, weight: 60, height: 165, age: 35, sex: "female", adjustToFFM: true });
    const off = resolveModel({ drug, weight: 60, height: 165, age: 35, sex: "female", adjustToFFM: false });
    assert.deepEqual(on.params, off.params);
    assert.equal(on.adjustToFFM, true);
    assert.equal(off.adjustToFFM, false);
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
  // The outer solve is this routine on tPeakError over [0, 200]: at the
  // result the objective is at most the fixture's figure within tolerance.
  const entry = ke0Solve.entries[0];
  const ke0 = brentFmin(
    (z) => tPeakError(z, entry.tPeak, ...entry.inputs.p_coef_bolus, ...entry.inputs.lambda), 0, 200, OPTIMIZE_TOL);
  assert.ok(relativeError(ke0, entry.ke0) <= TOL_KE0);
});
