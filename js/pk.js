// FauxTCI: the pharmacokinetic core, a port of stanpumpR.
//
// Everything a TCI controller needs from the drug library, in one module and
// in the order stanpumpR computes it:
//
//   1. the covariate models, propofol (Eleveld 2018, R/drugs_propofol.R) and
//      remifentanil (Eleveld 2017 below BMI 30, Kim 2017 at or above,
//      R/drugs_remifentanil.R), which turn weight, height, age and sex into
//      v1, v2, v3, cl1, cl2, cl3;
//   2. the micro rate constants and the three eigenvalues (cube(), R/cube.R);
//   3. the plasma and effect-site bolus and infusion coefficients exactly as
//      getDrugPK() builds them (R/getDrugPK.R);
//   4. ke0 solved from the time to peak effect by the same nested Brent
//      minimisation stats::optimize() runs in R (tPeakError() and CE() in
//      R/getDrugPK.R; Brent_fmin() in R's src/library/stats/src/optimize.c);
//   5. the seven-amplitude closed-form recurrence of tciSchedule()'s
//      advance() (R/tci.R), which is how the controller moves the model state
//      through time.
//
// Units, as in stanpumpR: time in minutes, volumes in litres, amounts in the
// drug's base mass unit (mg for the mcg/mL drugs, mcg for the ng/mL drugs),
// so a rate is base/min and a concentration base/L, which is mcg/mL for
// propofol and ng/mL for remifentanil without any conversion.
//
// The arithmetic follows the R expression by expression, including the order
// of operations, so that the port reproduces the fixtures in
// test/fixtures/models.json to the last digits the JSON carries; the only
// differences left are the last binary digit of exp(), pow(), log() and the
// trigonometric functions, where the JavaScript engine's libm and R's may
// disagree.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

/** The male sex token (SEX_MALE in R/constants.R). */
export const SEX_MALE = "male";
/** The female sex token (SEX_FEMALE in R/constants.R). */
export const SEX_FEMALE = "female";

/** Covariate bounds, as MIN_WEIGHT .. MAX_AGE in stanpumpR's R/constants.R. */
export const COVARIATE_BOUNDS = Object.freeze({
  weight: Object.freeze({ min: 0.1, max: 500, units: "kg" }),
  height: Object.freeze({ min: 10, max: 200, units: "cm" }),
  age: Object.freeze({ min: 0, max: 90, units: "years" }),
});

/**
 * The library rows for the two drugs, copied from stanpumpR's
 * inst/extdata/drugDefaults_global.csv (columns Concentration.Units,
 * Bolus.Units, Lower, Upper, Typical).  `concentrationUnits` is the CSV's
 * bare token ("mcg" or "ng"); baseUnits() turns it into the API's units.
 */
export const DRUG_LIBRARY = Object.freeze({
  propofol: Object.freeze({
    concentrationUnits: "mcg", bolusUnits: "mg", lower: 2.5, upper: 4, typical: 3,
  }),
  remifentanil: Object.freeze({
    concentrationUnits: "ng", bolusUnits: "mcg", lower: 0.8, upper: 2, typical: 1.2,
  }),
});

/** R's default optimize() tolerance: .Machine$double.eps^0.25 = 2^-13. */
export const OPTIMIZE_TOL = Math.pow(Number.EPSILON, 0.25);

/** The ke0 search interval of getDrugPK(): stats::optimize(tPeakError, c(0, 200), ...). */
export const KE0_INTERVAL = Object.freeze([0, 200]);

/** The peak-time search interval of tPeakError(): stats::optimize(CE, c(0, 100), ...). */
export const PEAK_INTERVAL = Object.freeze([0, 100]);

// ---------------------------------------------------------------------------
// Covariates

/**
 * Check the covariates the way the TCI API does (tciApiValidate() in
 * R/tci-api.R, bounds from R/constants.R) and throw a plain Error naming
 * the offending field otherwise.  Returns the four values, with `sex`
 * untouched (the tokens are case-sensitive, as in the R).
 */
export function validateCovariates({ weight, height, age, sex } = {}) {
  for (const [name, value] of [["weight", weight], ["height", height], ["age", age]]) {
    const bound = COVARIATE_BOUNDS[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`patient.${name} must be a finite number (${bound.units})`);
    }
    if (value < bound.min || value > bound.max) {
      throw new Error(
        `patient.${name} must be between ${bound.min} and ${bound.max} ${bound.units}, got ${value}`);
    }
  }
  if (sex !== SEX_MALE && sex !== SEX_FEMALE) {
    throw new Error(`patient.sex must be "${SEX_MALE}" or "${SEX_FEMALE}", got ${JSON.stringify(sex)}`);
  }
  return { weight, height, age, sex };
}

// ---------------------------------------------------------------------------
// Drug models

/**
 * Propofol, Eleveld 2018 (Br J Anaesth 120:942-959): port of propofol() in
 * R/drugs_propofol.R.  Returns { PK: {v1, v2, v3, cl1, cl2, cl3}, tPeak,
 * reference, branch }.  `adjustToFFM` is accepted for a uniform signature and
 * ignored, as in the R: the model carries its own Al-Sallami fat-free-mass
 * covariate.
 */
export function propofol(weight, height, age, sex, adjustToFFM = true) {
  // NONMEM THETA vector from the paper's digital supplement, as in the R.
  const THETA = [
    null, // 1-based, as in R
    1.837860e+00, // 1 v1ref(adult)=6.283 l
    3.238730e+00, // 2 v2ref=25.501 l
    5.608800e+00, // 3 v3ref=272.817 l
    5.819830e-01, // 4 clref(male)=1.790 l/min
    5.596720e-01, // 5 q2ref(adult)=1.750 l/min
    1.030460e-01, // 6 q3ref=1.109 l/min
    1.913070e-01, // 7 log-error
    3.744220e+00, // 8 maturation CL E50=42.3 weeks
    2.203300e+00, // 9 maturation CL slope=9.05
    -1.563300e-02, // 10 V2 declines with age
    -2.857090e-03, // 11 CL declines with age with opiates
    3.513130e+00, // 12 V1 sigmoid E50=33.6 kg
    -1.381660e-02, // 13 V3 declines with age with opiates
    4.223570e+00, // 14 maturation Q3 E50=68.3 weeks
    7.420430e-01, // 15 clref(female)=2.100 l/min
    2.656420e-01, // 16 q2ref(child) factor=1.304
    3.498850e-01, // 17 v1 extra(max,venous)=1.419 l
    -3.849270e-01, // 18 q2 less for venous=0.681 l/min
  ];

  const A1V2 = 1; // arterial concentrations, as the R

  // Al-Sallami FFM.  R writes (height / 100)^2, which R_pow() evaluates as
  // x * x, so the port squares by multiplication rather than Math.pow().
  const heightM = height / 100;
  const BMI = weight / (heightM * heightM);
  let FFM;
  let M1F2;
  if (sex === SEX_MALE) {
    FFM = (0.88 + ((1 - 0.88) / (1 + Math.pow(age / 13.4, -12.7)))) *
      42.92 * weight / (30.93 + BMI);
    M1F2 = 1;
  } else {
    FFM = (1.11 + ((1 - 1.11) / (1 + Math.pow(age / 7.1, -1.1)))) *
      37.99 * weight / (35.98 + BMI);
    M1F2 = 2;
  }
  const FFMReference = (0.88 + ((1 - 0.88) / (1 + Math.pow(35 / 13.4, -12.7)))) *
    42.92 * 70 / (30.93 + 70 / (1.7 * 1.7));
  const NFFM = FFM / FFMReference;

  // maturation
  const DV1 = 1;
  const DV2 = 1;
  const DV3 = 1;

  // sigmoidal maturation of CL.  PMA is written as the R does it: 40 weeks at
  // birth plus 52 weeks per year of age.
  const PMW = 40 + age * 52;
  const PMR = (35 + 40 / 52) * 52;
  const ME50 = Math.exp(THETA[8]);
  const MGAM = Math.exp(THETA[9]);
  const MCL = Math.pow(PMW, MGAM) / (Math.pow(PMW, MGAM) + Math.pow(ME50, MGAM));
  const RCL = Math.pow(PMR, MGAM) / (Math.pow(PMR, MGAM) + Math.pow(ME50, MGAM));
  const DCL = MCL / RCL;
  const DQ2 = 1;
  // sigmoidal maturation of Q3 based on 40 weeks gestation
  const PMEW = age * 52 + 40;
  const PMER = 35 * 52 + 40;
  const QE50 = Math.exp(THETA[14]);
  const MQ3 = PMEW / (PMEW + QE50);
  const RQ3 = PMER / (PMER + QE50);
  const DQ3 = MQ3 / RQ3;
  // aging (TECH == 2, "with opiates", as the R applies it)
  const KV1 = 1;
  const KV2 = Math.exp(THETA[10] * (age - 35));
  const KV3 = Math.exp(THETA[13] * age);
  const KCL = Math.exp(THETA[11] * age);
  const KQ2 = 1;
  const KQ3 = 1;
  // covariate structure: V1 scales sigmoid with weight
  const VV50 = Math.exp(THETA[12]);
  const CV1 = weight / (weight + VV50);
  const RV1 = 70 / (70 + VV50);
  const M1 = (CV1 / RV1) * KV1 * DV1;
  const VCV1 = (A1V2 - 1) * (1 - CV1);
  const V1 = Math.exp(THETA[1]) * M1 * (1 + VCV1 * Math.exp(THETA[17]));
  const M2 = (weight / 70) * KV2 * DV2;
  const V2 = Math.exp(THETA[2]) * M2;
  const M3 = NFFM * KV3 * DV3; // (NFFM)^1 in the R: exact in both languages
  const V3 = Math.exp(THETA[3]) * M3;
  const M4 = Math.pow(weight / 70, 0.75) * KCL * DCL;
  const CL1 = Math.exp((2 - M1F2) * THETA[4] + (M1F2 - 1) * THETA[15]) * M4;
  const RV2 = Math.exp(THETA[2]);
  const M5 = Math.pow(V2 / RV2, 0.75) * KQ2 * DQ2;
  const KM5 = 1 + Math.exp(THETA[16]) * (1 - MQ3);
  const CL2 = Math.exp(THETA[5] + (A1V2 - 1) * THETA[18]) * M5 * KM5;
  const RV3 = Math.exp(THETA[3]);
  const M6 = Math.pow(V3 / RV3, 0.75) * KQ3 * DQ3;
  const CL3 = Math.exp(THETA[6]) * M6;

  return {
    PK: { v1: V1, v2: V2, v3: V3, cl1: CL1, cl2: CL2, cl3: CL3 },
    // tPeak per Schnider TW et al., Anesthesiology 1999;90(6):1502-1516.
    tPeak: 1.600,
    reference: "Eleveld DJ et al., Br J Anaesth 2018;120(5):942-959. https://pubmed.ncbi.nlm.nih.gov/29661412/",
    branch: "eleveld2018",
  };
}

/**
 * Remifentanil: port of remifentanil() in R/drugs_remifentanil.R.  Eleveld
 * 2017 (Anesthesiology 126:1005-1018) below a BMI of 30, Kim 2017
 * (Anesthesiology 126:1019-1032) at or above it, with the citation set in
 * the branch so that the model block names the model actually computed.
 * Returns { PK, tPeak, reference, branch }; `adjustToFFM` is accepted and
 * ignored, as in the R (both models carry their own fat-free-mass covariate).
 */
export function remifentanil(weight, height, age, sex, adjustToFFM = true) {
  const heightM = height / 100;
  const BMI = weight / (heightM * heightM);
  let v1; let v2; let v3; let cl1; let cl2; let cl3;
  let reference;
  let branch;

  if (BMI < 30) { // NIH obesity cutoff
    // Eleveld 2017
    const M1F2 = sex === SEX_MALE ? 1 : 2;

    const THETA01 = 1.759110; // v1=5.81
    const THETA02 = 2.177170; // v2=8.82
    const THETA03 = 1.614450; // v3=5.03
    const THETA04 = 0.946257; // cl=2.58
    const THETA05 = 0.540315; // q2=1.72
    const THETA06 = -2.083880; // q3=0.12
    const THETA07 = 2.878980; // e50 for cl maturation
    const THETA08 = -0.00554481; // aging v1/q2/q3
    const THETA09 = -0.00326985; // aging v2/cl
    const THETA10 = -0.0315135; // aging v3
    const THETA11 = 0.4704050; // increase cl/q2/v2 in females 12-45 years
    const THETA12 = -0.0260496; // weight correction v3

    // maturation.  weight^2 is x * x in R_pow(), hence the multiplications.
    const SE50 = THETA07;
    const ADLT = (weight * weight) / ((weight * weight) + (SE50 * SE50));
    const AREF = (70 * 70) / ((70 * 70) + (SE50 * SE50));
    const KMAT = ADLT / AREF;

    // scaling using Al-Sallami FFM
    const HT2 = (height / 100) * (height / 100);
    const MATM = 0.88 + ((1 - 0.88) / (1 + Math.pow(age / 13.4, -12.7)));
    const MATF = 1.11 + ((1 - 1.11) / (1 + Math.pow(age / 7.1, -1.1)));
    const FFMM = MATM * 42.92 * HT2 * weight / (30.93 * HT2 + weight);
    const FFMF = MATF * 37.99 * HT2 * weight / (35.98 * HT2 + weight);
    const FFMR = 42.92 * (1.7 * 1.7) * 70 / (30.93 * (1.7 * 1.7) + 70);

    const MAL = 2 - M1F2;
    const FEM = M1F2 - 1;
    const bsize = (MAL * FFMM + FEM * FFMF) / FFMR;

    // aging for v1/q2/q3, v3 and v2/cl
    const kv1 = Math.exp(THETA08 * (age - 35));
    const kv2 = Math.exp(THETA09 * (age - 35));
    const kv3 = Math.exp(THETA10 * (age - 35));
    const kcl = kv2;
    const kcl2 = kv1;
    const kcl3 = kv1;

    // sex correction for cl, v2 and q2
    const age6 = Math.pow(age, 6);
    const PPUB = age6 / (age6 + Math.pow(12, 6));
    const ELDY = age6 / (age6 + Math.pow(45, 6));
    const ksex = 1 + (M1F2 - 1) * PPUB * (1 - ELDY) * THETA11;

    // weight correction for v3
    const Wv3 = Math.exp(THETA12 * (weight - 70));

    // compartmental allometric scaling ((bsize)^1 is exact in both languages)
    const M1 = bsize * kv1;
    const M2 = bsize * kv2 * ksex;
    const M3 = bsize * kv3 * Wv3;
    v1 = Math.exp(THETA01) * M1;
    v2 = Math.exp(THETA02) * M2;
    v3 = Math.exp(THETA03) * M3;
    const rv2 = Math.exp(THETA02);
    const rv3 = Math.exp(THETA03);
    const M4 = Math.pow(bsize, 0.75) * kcl * ksex * KMAT;
    const M5 = Math.pow(v2 / rv2, 0.75) * kcl2 * ksex;
    const M6 = Math.pow(v3 / rv3, 0.75) * kcl3;
    cl1 = Math.exp(THETA04) * M4;
    cl2 = Math.exp(THETA05) * M5;
    cl3 = Math.exp(THETA06) * M6;

    reference = "Eleveld DJ et al., Anesthesiology 2017;126(6):1005-1018. https://pubmed.ncbi.nlm.nih.gov/28509794/";
    branch = "eleveld2017";
  } else {
    // Kim 2017, fat-free mass by Janmahasatian et al. (Clin Pharmacokinet
    // 2005;44:1051-1065) with numerator and denominator divided by 1000, the
    // denominator taking BMI, as the R has it.
    let FFM;
    if (sex === SEX_MALE) {
      FFM = 9.27 * weight / (6.68 + 0.216 * BMI);
    } else {
      FFM = 9.27 * weight / (8.78 + 0.244 * BMI);
    }
    v1 = 4.76 * Math.pow(weight / 74.5, 0.658);
    v2 = 8.4 * Math.pow(FFM / 52.3, 0.573) - 0.0936 * (age - 37);
    v3 = 4 - 0.0477 * (age - 37);
    cl1 = 2.77 * Math.pow(weight / 74.5, 0.336) - 0.0149 * (age - 37);
    cl2 = 1.94 - 0.028 * (age - 37);
    cl3 = 0.197;

    reference = "Kim TK et al., Anesthesiology 2017;126(6):1019-1032. https://pubmed.ncbi.nlm.nih.gov/28509796/";
    branch = "kim2017";
  }

  return {
    PK: { v1, v2, v3, cl1, cl2, cl3 },
    tPeak: 1.6, // Opioid simulation spreadsheet, as the R
    reference,
    branch,
  };
}

/** The drug functions by API name; anything not listed here is not a FauxTCI drug. */
export const DRUG_FUNCTIONS = Object.freeze({ propofol, remifentanil });

// ---------------------------------------------------------------------------
// Eigenvalues

/**
 * The three eigenvalues of the mammillary three-compartment model from its
 * micro rate constants, sorted decreasing: port of cube() in R/cube.R, the
 * trigonometric solution of the cubic.  The two- and one-compartment
 * branches (k31 == 0, k21 == 0) are ported too, as the R has them.  The cube
 * root is taken as exp(log(r1) / 3), as the R does, not Math.cbrt().
 */
export function cube(k10, k12, k13, k21, k31) {
  const toradian = Math.asin(1.0) * 2.0 / 180.0; // pi/180
  let root1; let root2; let root3;
  if (k31 > 0) {
    // roots of X^3 + a2 X^2 + a1 X + a0 = 0
    const a0 = k10 * k21 * k31;
    const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
    const a2 = k10 + k12 + k13 + k21 + k31;

    // transform to x^3 + p x + q = 0
    const p = a1 - (a2 * a2 / 3.0);
    const q = (2 * a2 * a2 * a2 / 27.0) - (a1 * a2 / 3.0) + a0;
    let r1 = Math.sqrt(-(p * p * p) / 27.0);
    let phi = (-q / 2.0) / r1;
    if (phi > 1) phi = 1;
    else if (phi < -1) phi = -1;
    phi = Math.acos(phi) / 3.0;
    r1 = 2.0 * Math.exp(Math.log(r1) / 3.0);
    root1 = -(Math.cos(phi) * r1 - a2 / 3.0);
    root2 = -(Math.cos(phi + 120.0 * toradian) * r1 - a2 / 3.0);
    root3 = -(Math.cos(phi + 240.0 * toradian) * r1 - a2 / 3.0);
  } else if (k21 > 0) {
    // roots of X^2 - a1 X + a0 = 0
    const a0 = k10 * k21;
    const a1 = -(k10 + k12 + k21);
    root1 = (-a1 + Math.sqrt(a1 * a1 - 4 * a0)) / 2;
    root2 = (-a1 - Math.sqrt(a1 * a1 - 4 * a0)) / 2;
    root3 = 0;
  } else {
    // one compartment
    root1 = k10;
    root2 = 0;
    root3 = 0;
  }
  // sort(c(root1, root2, root3), decreasing = TRUE)
  return [root1, root2, root3].sort((x, y) => y - x);
}

// ---------------------------------------------------------------------------
// Brent's fmin, as R runs it

/**
 * Brent's minimiser on [ax, bx] with absolute tolerance `tol`: a line-for-line
 * port of Brent_fmin() in R's src/library/stats/src/optimize.c (the Netlib
 * FMIN of Forsythe, Malcolm and Moler), which is what stats::optimize()
 * calls.  Same golden-section and parabolic steps, same stopping rule
 * |x - xm| <= 2 tol1 - (b - a)/2 with tol1 = sqrt(eps) |x| + tol/3, so that a
 * JavaScript port can reproduce R's result to the last bit whenever the
 * objective does.  As optimize()'s fcn1() does, a non-finite objective value
 * is replaced by the largest double, so the search steps away from it.
 * Returns the abscissa of the minimum (optimize()'s $minimum); to maximise,
 * pass the negated function, as optimize(maximum = TRUE) does.
 */
export function brentFmin(f, ax, bx, tol = OPTIMIZE_TOL) {
  if (!(ax < bx)) throw new Error("brentFmin: the interval must have ax < bx");
  if (!(tol > 0)) throw new Error("brentFmin: tol must be positive");
  const fcn = (z) => {
    const value = f(z);
    return Number.isFinite(value) ? value : Number.MAX_VALUE;
  };
  // c is the squared inverse of the golden ratio
  const c = (3 - Math.sqrt(5)) * 0.5;
  // eps is approximately the square root of the relative machine precision
  const eps = Math.sqrt(Number.EPSILON);

  let a = ax;
  let b = bx;
  let v = a + c * (b - a);
  let w = v;
  let x = v;
  let d = 0;
  let e = 0;
  let fx = fcn(x);
  let fv = fx;
  let fw = fx;
  const tol3 = tol / 3;

  for (;;) {
    const xm = (a + b) * 0.5;
    const tol1 = eps * Math.abs(x) + tol3;
    const t2 = tol1 * 2;

    // check stopping criterion
    if (Math.abs(x - xm) <= t2 - (b - a) * 0.5) break;
    let p = 0;
    let q = 0;
    let r = 0;
    if (Math.abs(e) > tol1) { // fit parabola
      r = (x - w) * (fx - fv);
      q = (x - v) * (fx - fw);
      p = (x - v) * q - (x - w) * r;
      q = (q - r) * 2;
      if (q > 0) p = -p; else q = -q;
      r = e;
      e = d;
    }

    let u;
    if (Math.abs(p) >= Math.abs(q * 0.5 * r) || p <= q * (a - x) || p >= q * (b - x)) {
      // a golden-section step
      e = (x < xm) ? b - x : a - x;
      d = c * e;
    } else {
      // a parabolic-interpolation step
      d = p / q;
      u = x + d;
      // f must not be evaluated too close to ax or bx
      if (u - a < t2 || b - u < t2) {
        d = tol1;
        if (x >= xm) d = -d;
      }
    }

    // f must not be evaluated too close to x
    if (Math.abs(d) >= tol1) u = x + d;
    else if (d > 0) u = x + tol1;
    else u = x - tol1;

    const fu = fcn(u);

    // update a, b, v, w, and x
    if (fu <= fx) {
      if (u < x) b = x; else a = x;
      v = w; w = x; x = u;
      fv = fw; fw = fx; fx = fu;
    } else {
      if (u < x) a = u; else b = u;
      if (fu <= fw || w === x) {
        v = w; fv = fw;
        w = u; fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u; fv = fu;
      }
    }
  }
  return x;
}

// ---------------------------------------------------------------------------
// ke0 from the time to peak effect

/**
 * The effect-site concentration after a unit IV bolus at time t (minutes)
 * from four coefficients and four exponents: port of CE() in R/getDrugPK.R.
 */
export function CE(t, e1, e2, e3, e4, lambda1, lambda2, lambda3, lambda4) {
  return e1 * Math.exp(-lambda1 * t) +
    e2 * Math.exp(-lambda2 * t) +
    e3 * Math.exp(-lambda3 * t) +
    e4 * Math.exp(-lambda4 * t);
}

/**
 * The squared miss between the wanted time to peak effect and the peak time
 * of the unit-bolus effect-site curve for a trial ke0 (`lambda4`): port of
 * tPeakError() in R/getDrugPK.R, inner stats::optimize(CE, c(0, 100), ...,
 * maximum = TRUE) included, which here is brentFmin() on -CE with R's
 * default tolerance.  `p1..p3` are the plasma bolus coefficients and
 * `lambda1..3` the eigenvalues.
 */
export function tPeakError(lambda4, tPeak, p1, p2, p3, lambda1, lambda2, lambda3) {
  const e1 = p1 / (lambda4 - lambda1) * lambda4;
  const e2 = lambda2 > 0 ? p2 / (lambda4 - lambda2) * lambda4 : 0;
  const e3 = lambda3 > 0 ? p3 / (lambda4 - lambda3) * lambda4 : 0;
  const e4 = -e1 - e2 - e3;
  const predPeak = brentFmin(
    (t) => -CE(t, e1, e2, e3, e4, lambda1, lambda2, lambda3, lambda4),
    PEAK_INTERVAL[0], PEAK_INTERVAL[1], OPTIMIZE_TOL);
  const miss = tPeak - predPeak;
  return miss * miss; // (tPeak - predPeak)^2, which R_pow() evaluates as x * x
}

/**
 * The peak time of the unit-bolus effect-site curve for a given ke0, as the
 * inner optimizer of tPeakError() finds it (useful for the round trip the
 * fixtures record).  Same arguments as tPeakError() without tPeak.
 */
export function peakTimeForKe0(ke0, p1, p2, p3, lambda1, lambda2, lambda3) {
  const e1 = p1 / (ke0 - lambda1) * ke0;
  const e2 = lambda2 > 0 ? p2 / (ke0 - lambda2) * ke0 : 0;
  const e3 = lambda3 > 0 ? p3 / (ke0 - lambda3) * ke0 : 0;
  const e4 = -e1 - e2 - e3;
  return brentFmin(
    (t) => -CE(t, e1, e2, e3, e4, lambda1, lambda2, lambda3, ke0),
    PEAK_INTERVAL[0], PEAK_INTERVAL[1], OPTIMIZE_TOL);
}

/**
 * ke0 from the time to peak effect after an IV bolus: the solve getDrugPK()
 * runs for an IV drug,
 *   stats::optimize(tPeakError, c(0, 200), tPeak, p1, p2, p3, l1, l2, l3)$minimum,
 * i.e. Brent's fmin on [0, 200] /min with R's default tolerance over the
 * nested objective tPeakError().  `pbolus` is [p1, p2, p3], `lambda` is
 * [lambda_1, lambda_2, lambda_3].
 */
export function ke0FromTPeak(tPeak, pbolus, lambda) {
  const [p1, p2, p3] = pbolus;
  const [l1, l2, l3] = lambda;
  return brentFmin(
    (ke0) => tPeakError(ke0, tPeak, p1, p2, p3, l1, l2, l3),
    KE0_INTERVAL[0], KE0_INTERVAL[1], OPTIMIZE_TOL);
}

// ---------------------------------------------------------------------------
// Rate constants and coefficients, as getDrugPK() builds them

/**
 * From the six disposition parameters to the complete IV parameter set the
 * controller needs: the micro rate constants, the eigenvalues, the plasma and
 * effect-site bolus and infusion coefficients and ke0.  A port of the
 * coefficient block of getDrugPK() in R/getDrugPK.R for an IV drug.  Pass
 * `ke0` to inject a known value (the fixtures' R value, or a drug's own
 * X$ke0) in place of the solve, which is how the coefficient arithmetic is
 * validated independently of the optimizer.
 *
 * Returns { params, coef: {pbolus, pinf, ebolus, einf}, lambda3, lambda4 }
 * with params = {v1, v2, v3, cl1, cl2, cl3, k10, k12, k13, k21, k31,
 * lambda_1, lambda_2, lambda_3, ke0, tPeak}.
 */
export function buildKinetics(PK, tPeak, ke0 = null) {
  const { v1, v2, v3, cl1, cl2, cl3 } = PK;
  for (const [name, value] of Object.entries({ v1, v2, v3, cl1, cl2, cl3 })) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`buildKinetics: ${name} must be a finite number`);
    }
  }

  const k10 = cl1 / v1;
  const k12 = cl2 / v1;
  const k13 = cl3 / v1;
  const k21 = cl2 / v2;
  const k31 = cl3 / v3;

  const [lambda_1, lambda_2, lambda_3] = cube(k10, k12, k13, k21, k31);

  // Bolus delivery
  let p_coef_bolus_l1 = 0;
  let p_coef_bolus_l2 = 0;
  let p_coef_bolus_l3 = 0;
  let e_coef_bolus_l1 = 0;
  let e_coef_bolus_l2 = 0;
  let e_coef_bolus_l3 = 0;
  let e_coef_bolus_ke0 = 0;
  // Infusion delivery
  let p_coef_infusion_l1 = 0;
  let p_coef_infusion_l2 = 0;
  let p_coef_infusion_l3 = 0;
  let e_coef_infusion_l1 = 0;
  let e_coef_infusion_l2 = 0;
  let e_coef_infusion_l3 = 0;
  let e_coef_infusion_ke0 = 0;

  if (k31 > 0) {
    p_coef_bolus_l1 = (k21 - lambda_1) * (k31 - lambda_1) /
      (lambda_1 - lambda_2) /
      (lambda_1 - lambda_3) / v1;
    p_coef_bolus_l2 = (k21 - lambda_2) * (k31 - lambda_2) /
      (lambda_2 - lambda_1) /
      (lambda_2 - lambda_3) /
      v1;
    p_coef_bolus_l3 = (k21 - lambda_3) * (k31 - lambda_3) /
      (lambda_3 - lambda_2) /
      (lambda_3 - lambda_1) /
      v1;
  } else if (lambda_2 > 0) {
    p_coef_bolus_l1 = (k21 - lambda_1) / (lambda_2 - lambda_1) / v1;
    p_coef_bolus_l2 = (k21 - lambda_2) / (lambda_1 - lambda_2) / v1;
  } else {
    // One compartment: Cp(0) = dose / v1
    p_coef_bolus_l1 = 1 / v1;
  }

  p_coef_infusion_l1 = p_coef_bolus_l1 / lambda_1;
  if (lambda_2 > 0) p_coef_infusion_l2 = p_coef_bolus_l2 / lambda_2;
  if (lambda_3 > 0) p_coef_infusion_l3 = p_coef_bolus_l3 / lambda_3;

  // find ke0 from tPeak: for these IV drugs the peak is measured against the
  // IV bolus response, so the solve runs on the bolus coefficients.
  let ke0Value;
  if (ke0 !== null && ke0 !== undefined) {
    if (typeof ke0 !== "number" || !Number.isFinite(ke0) || ke0 <= 0) {
      throw new Error("buildKinetics: an injected ke0 must be a positive finite number");
    }
    ke0Value = ke0;
  } else if (tPeak > 0) {
    ke0Value = ke0FromTPeak(tPeak,
      [p_coef_bolus_l1, p_coef_bolus_l2, p_coef_bolus_l3],
      [lambda_1, lambda_2, lambda_3]);
  } else {
    ke0Value = 0;
  }

  if (ke0Value > 0) {
    e_coef_bolus_l1 = p_coef_bolus_l1 / (ke0Value - lambda_1) * ke0Value;
    e_coef_infusion_l1 = e_coef_bolus_l1 / lambda_1;
    if (lambda_2 > 0) {
      e_coef_bolus_l2 = p_coef_bolus_l2 / (ke0Value - lambda_2) * ke0Value;
      e_coef_infusion_l2 = e_coef_bolus_l2 / lambda_2;
    }
    if (lambda_3 > 0) {
      e_coef_bolus_l3 = p_coef_bolus_l3 / (ke0Value - lambda_3) * ke0Value;
      e_coef_infusion_l3 = e_coef_bolus_l3 / lambda_3;
    }
    e_coef_bolus_ke0 = -e_coef_bolus_l1 - e_coef_bolus_l2 - e_coef_bolus_l3;
    e_coef_infusion_ke0 = e_coef_bolus_ke0 / ke0Value;
  }

  const lambda3 = [lambda_1, lambda_2, lambda_3];
  return {
    params: {
      v1, v2, v3, cl1, cl2, cl3,
      k10, k12, k13, k21, k31,
      lambda_1, lambda_2, lambda_3,
      ke0: ke0Value,
      tPeak: ke0Value > 0 ? tPeak : 0, // tciKinetics(): tPeak is 0 without an effect site
    },
    // The layout of tciKinetics() in R/tci.R.
    coef: {
      pbolus: [p_coef_bolus_l1, p_coef_bolus_l2, p_coef_bolus_l3],
      pinf: [p_coef_infusion_l1, p_coef_infusion_l2, p_coef_infusion_l3],
      ebolus: [e_coef_bolus_l1, e_coef_bolus_l2, e_coef_bolus_l3, e_coef_bolus_ke0],
      einf: [e_coef_infusion_l1, e_coef_infusion_l2, e_coef_infusion_l3, e_coef_infusion_ke0],
    },
    lambda3,
    lambda4: [lambda_1, lambda_2, lambda_3, ke0Value],
  };
}

/**
 * The API's units for a library row: port of tciApiBaseUnits() in
 * R/tci-api.R.  A "ng" drug is dosed in mcg and targeted in ng/mL; every
 * other drug in mg and mcg/mL.
 */
export function baseUnits(concentrationUnitsToken) {
  const ng = concentrationUnitsToken === "ng";
  return {
    massUnits: ng ? "mcg" : "mg",
    concentrationUnits: ng ? "ng/mL" : "mcg/mL",
  };
}

// ---------------------------------------------------------------------------
// The model

/**
 * Resolve the complete model for one drug in one patient: the covariate
 * model, the eigenvalues, the coefficients and ke0 (getDrugPK() followed by
 * tciKinetics() in stanpumpR).  Only "propofol" and "remifentanil" are known;
 * anything else throws, as do covariates outside the API's bounds.  The
 * optional `ke0` injects a known value in place of the solve (validation
 * only).  Returns
 *   { drug, concentrationUnits, massUnits, params, coef, lambda3, lambda4,
 *     reference, branch, typical, upper, lower, adjustToFFM }.
 */
export function resolveModel({ drug, weight, height, age, sex, adjustToFFM = true, ke0 = null } = {}) {
  const drugFunction = Object.prototype.hasOwnProperty.call(DRUG_FUNCTIONS, drug)
    ? DRUG_FUNCTIONS[drug] : null;
  if (!drugFunction) {
    throw new Error(`unknown drug ${JSON.stringify(drug)}: FauxTCI knows propofol and remifentanil`);
  }
  validateCovariates({ weight, height, age, sex });
  const adjust = adjustToFFM !== false;

  const model = drugFunction(weight, height, age, sex, adjust);
  const kinetics = buildKinetics(model.PK, model.tPeak, ke0);
  const row = DRUG_LIBRARY[drug];
  const units = baseUnits(row.concentrationUnits);

  return {
    drug,
    concentrationUnits: units.concentrationUnits,
    massUnits: units.massUnits,
    params: kinetics.params,
    coef: kinetics.coef,
    lambda3: kinetics.lambda3,
    lambda4: kinetics.lambda4,
    reference: model.reference,
    branch: model.branch,
    typical: row.typical,
    upper: row.upper,
    lower: row.lower,
    adjustToFFM: adjust,
  };
}

// ---------------------------------------------------------------------------
// The state and its closed-form recurrence

/** A model state with nothing on board: { p: [0, 0, 0], e: [0, 0, 0, 0] }. */
export function emptyState() {
  return { p: [0, 0, 0], e: [0, 0, 0, 0] };
}

/**
 * Move the seven-amplitude state through `dtMinutes` at a constant infusion
 * of `rateBasePerMin` (base mass units per minute): port of advance() inside
 * tciSchedule() in R/tci.R, STANPUMP's "bring model forward".  For each
 * exponential, p <- p exp(-lambda dt) + pinf R (1 - exp(-lambda dt)), and the
 * same for the four effect-site amplitudes with lambda4 and einf.  Returns a
 * new state; the input is not modified.
 */
export function advance(state, dtMinutes, rateBasePerMin, model) {
  const { pinf, einf } = model.coef;
  const lambda3 = model.lambda3 || model.lambda4.slice(0, 3);
  const { lambda4 } = model;
  const p = new Array(3);
  const e = new Array(4);
  for (let i = 0; i < 3; i++) {
    const d3 = Math.exp(-lambda3[i] * dtMinutes);
    p[i] = state.p[i] * d3 + pinf[i] * rateBasePerMin * (1 - d3);
  }
  for (let i = 0; i < 4; i++) {
    const d4 = Math.exp(-lambda4[i] * dtMinutes);
    e[i] = state.e[i] * d4 + einf[i] * rateBasePerMin * (1 - d4);
  }
  return { p, e };
}

/**
 * Add an instantaneous bolus of `amountBase` (base mass units) to the state:
 * pbolus A to the plasma amplitudes and ebolus A to the effect-site ones, as
 * tciSchedule() and the API's history replay do.  Returns a new state.
 */
export function bolus(state, amountBase, model) {
  const { pbolus, ebolus } = model.coef;
  return {
    p: state.p.map((value, i) => value + pbolus[i] * amountBase),
    e: state.e.map((value, i) => value + ebolus[i] * amountBase),
  };
}

/** Plasma concentration (base/L) of a state: the sum of its plasma amplitudes. */
export function cp(state) {
  return state.p[0] + state.p[1] + state.p[2];
}

/** Effect-site concentration (base/L) of a state: the sum of its four effect-site amplitudes. */
export function ce(state) {
  return state.e[0] + state.e[1] + state.e[2] + state.e[3];
}
