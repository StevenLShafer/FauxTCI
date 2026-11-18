// FauxTCI: the pharmacokinetic core, a port of stanpumpR.
//
// Everything a TCI controller needs from the drug library, in one module and
// in the order stanpumpR computes it:
//
//   1. the covariate models, propofol (Eleveld 2018, R/drugs_propofol.R),
//      remifentanil (Eleveld 2017, or Kim 2017 from a BMI of 30 in adults,
//      R/drugs_remifentanil.R), sufentanil (Gepts 1995, R/drugs_sufentanil.R)
//      and remimazolam (Eleveld 2025, R/drugs_remimazolam.R), the last two
//      scaled to fat-free mass by pkSizeFactors() (R/pkSizeFactors.R), which
//      turn weight, height, age and sex into v1, v2, v3, cl1, cl2, cl3;
//   2. the micro rate constants and the three eigenvalues (cube(), R/cube.R);
//   3. the plasma and effect-site bolus and infusion coefficients exactly as
//      getDrugPK() builds them (R/getDrugPK.R);
//   4. ke0 solved from the time to peak effect as ke0FromTPeakBolus() does it
//      (uniroot() on effectSitePeakTime(), itself an optimize(); R_zeroin2()
//      and Brent_fmin() in R's src/library/stats/src), or for a drug that
//      supplies ke0 (remimazolam) the time to peak effect solved from it;
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
 * The library rows for the four drugs, copied from stanpumpR's
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
  sufentanil: Object.freeze({
    concentrationUnits: "ng", bolusUnits: "mcg", lower: 0.0448, upper: 0.112, typical: 0.0672,
  }),
  remimazolam: Object.freeze({
    concentrationUnits: "mcg", bolusUnits: "mg", lower: 0.3, upper: 0.6, typical: 0.45,
  }),
});

/** R's default optimize() tolerance: .Machine$double.eps^0.25 = 2^-13. */
export const OPTIMIZE_TOL = Math.pow(Number.EPSILON, 0.25);

/** uniroot()'s tolerance in ke0FromTPeakBolus(): .Machine$double.eps^0.5. */
export const UNIROOT_TOL = Math.sqrt(Number.EPSILON);

/** uniroot()'s default maxiter. */
export const UNIROOT_MAXITER = 1000;

/** The ends of the ke0 bracket, per minute (KE0_SOLVE_MIN, KE0_SOLVE_MAX in R/getDrugPK.R). */
export const KE0_SOLVE_MIN = 1e-12;
export const KE0_SOLVE_MAX = 1e6;

/** The longest time effectSitePeakTime() searches, in minutes (its `upper` default). */
export const PEAK_SEARCH_MAX = 4000;

/** The REMIFENTANIL_KIM_MIN_AGE of R/constants.R: Kim 2017 was fitted in adults. */
export const REMIFENTANIL_KIM_MIN_AGE = 18;

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

const REMIFENTANIL_ELEVELD_REFERENCE =
  "Eleveld DJ et al., Anesthesiology 2017;126(6):1005-1018. https://pubmed.ncbi.nlm.nih.gov/28509794/";
const REMIFENTANIL_KIM_REFERENCE =
  "Kim TK et al., Anesthesiology 2017;126(6):1019-1032. https://pubmed.ncbi.nlm.nih.gov/28509796/";

/**
 * Remifentanil: port of remifentanil() in R/drugs_remifentanil.R.  Kim 2017
 * (Anesthesiology 126:1019-1032) at a BMI of 30 or more in a patient of
 * REMIFENTANIL_KIM_MIN_AGE or older, unless Kim's model gives a non-positive
 * parameter for the patient (its age terms are linear), in which case
 * Eleveld 2017 (Anesthesiology 126:1005-1018) is used and the citation says
 * why; Eleveld 2017 otherwise.  The citation is set in the branch so that the
 * model block names the model actually computed.  Returns { PK, tPeak,
 * reference, branch }; `adjustToFFM` is accepted and ignored, as in the R
 * (both models carry their own fat-free-mass covariate).
 */
export function remifentanil(weight, height, age, sex, adjustToFFM = true) {
  const BMI = weight / ((height / 100) * (height / 100)); // (height / 100)^2 is x * x in R_pow()
  let useKim = BMI >= 30 && age >= REMIFENTANIL_KIM_MIN_AGE;
  let kimUndefined = [];
  let PK;
  let reference;
  if (useKim) {
    const kim = remifentanilKim(weight, height, age, sex);
    const names = Object.keys(kim);
    if (names.every((name) => kim[name] > 0)) {
      PK = kim;
      reference = REMIFENTANIL_KIM_REFERENCE;
    } else {
      useKim = false;
      kimUndefined = names.filter((name) => kim[name] <= 0);
    }
  }
  if (!useKim) {
    PK = remifentanilEleveld(weight, height, age, sex);
    reference = REMIFENTANIL_ELEVELD_REFERENCE;
    if (kimUndefined.length > 0) {
      reference += ` (Kim's model for obesity gives a non-positive ${kimUndefined.map((n) => n.toUpperCase()).join(", ")}` +
        " for this patient, so Eleveld's is used)";
    }
  }
  return {
    PK,
    tPeak: 1.6, // as the R
    reference,
    branch: useKim ? "kim2017" : "eleveld2017",
  };
}

/** Eleveld 2017's remifentanil: port of remifentanilEleveld() in R/drugs_remifentanil.R. */
export function remifentanilEleveld(weight, height, age, sex) {
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
  const v1 = Math.exp(THETA01) * M1;
  const v2 = Math.exp(THETA02) * M2;
  const v3 = Math.exp(THETA03) * M3;
  const rv2 = Math.exp(THETA02);
  const rv3 = Math.exp(THETA03);
  const M4 = Math.pow(bsize, 0.75) * kcl * ksex * KMAT;
  const M5 = Math.pow(v2 / rv2, 0.75) * kcl2 * ksex;
  const M6 = Math.pow(v3 / rv3, 0.75) * kcl3;
  const cl1 = Math.exp(THETA04) * M4;
  const cl2 = Math.exp(THETA05) * M5;
  const cl3 = Math.exp(THETA06) * M6;
  return { v1, v2, v3, cl1, cl2, cl3 };
}

/**
 * Kim 2017's remifentanil: port of remifentanilKim() in
 * R/drugs_remifentanil.R.  Fat-free mass by Janmahasatian et al. (Clin
 * Pharmacokinet 2005;44:1051-1065) with numerator and denominator divided by
 * 1000, the denominator taking BMI, as the R has it.
 */
export function remifentanilKim(weight, height, age, sex) {
  const BMI = weight / ((height / 100) * (height / 100));
  let FFM;
  if (sex === SEX_MALE) {
    FFM = 9.27 * weight / (6.68 + 0.216 * BMI);
  } else {
    FFM = 9.27 * weight / (8.78 + 0.244 * BMI);
  }
  return {
    v1: 4.76 * Math.pow(weight / 74.5, 0.658),
    v2: 8.4 * Math.pow(FFM / 52.3, 0.573) - 0.0936 * (age - 37),
    v3: 4 - 0.0477 * (age - 37),
    cl1: 2.77 * Math.pow(weight / 74.5, 0.336) - 0.0149 * (age - 37),
    cl2: 1.94 - 0.028 * (age - 37),
    cl3: 0.197,
  };
}

// ---------------------------------------------------------------------------
// Size scaling (R/pkSizeFactors.R)

/**
 * Fat-free mass, Al-Sallami et al. 2015 (Clin Pharmacokinet 54:1169-1178):
 * Janmahasatian's adult fat-free mass times a sex-specific maturation term.
 * Port of ffmAlSallami().
 */
export function ffmAlSallami(weight, height, age, sex) {
  const BMI = weight / ((height / 100) * (height / 100));
  if (sex === SEX_MALE) {
    const maturation = 0.88 + (1 - 0.88) / (1 + Math.pow(age / 13.4, -12.7));
    return maturation * 9270 * weight / (6680 + 216 * BMI);
  }
  const maturation = 1.11 + (1 - 1.11) / (1 + Math.pow(age / 7.1, -1.1));
  return maturation * 9270 * weight / (8780 + 244 * BMI);
}

/** The 70 kg, 170 cm, 35-year-old reference man every size-scaled model is anchored to. */
export const FFM_REFERENCE_WEIGHT = 70;
export const FFM_REFERENCE = ffmAlSallami(70, 170, 35, SEX_MALE); // 54.48 kg

/**
 * The multipliers a drug model applies to its reference (70 kg) volumes and
 * clearances: port of pkSizeFactors().  With adjustToFFM the volume factor
 * is the patient's fat-free mass over the reference man's and the clearance
 * factor that ratio ^ 0.75; without it, the model's own legacy factors
 * (`legacyVolume` defaults to weight / 70, `legacyClearance` to legacyVolume).
 */
export function pkSizeFactors(weight, height, age, sex, adjustToFFM = true,
  legacyVolume = weight / FFM_REFERENCE_WEIGHT, legacyClearance = legacyVolume) {
  const ffm = ffmAlSallami(weight, height, age, sex);
  let volume;
  let clearance;
  if (adjustToFFM === true) {
    volume = ffm / FFM_REFERENCE;
    clearance = Math.pow(volume, 0.75);
  } else {
    volume = legacyVolume;
    clearance = legacyClearance;
  }
  return { volume, clearance, ffm, ffmReference: FFM_REFERENCE, pkWeight: FFM_REFERENCE_WEIGHT * ffm / FFM_REFERENCE };
}

/**
 * Sufentanil, Gepts 1995 (Anesthesiology 83:1194-1204), Table 3's two-stage
 * means: port of sufentanil() in R/drugs_sufentanil.R.  The 70 kg parameters
 * are scaled by pkSizeFactors(); with adjustToFFM false the published
 * parameters are used unscaled (legacyVolume 1).  tPeak 5.6 min (Shafer and
 * Varvel 1991, EEG).
 */
export function sufentanil(weight, height, age, sex, adjustToFFM = true) {
  const size = pkSizeFactors(weight, height, age, sex, adjustToFFM, 1);
  return {
    PK: {
      v1: 14.3 * size.volume,
      v2: 63.1 * size.volume,
      v3: 261.6 * size.volume,
      cl1: 0.92 * size.clearance,
      cl2: 1.55 * size.clearance,
      cl3: 0.33 * size.clearance,
    },
    tPeak: 5.6,
    reference: "Gepts E et al., Anesthesiology 1995;83(6):1194-1204. https://pubmed.ncbi.nlm.nih.gov/8533912/",
    branch: "gepts1995",
  };
}

/**
 * Remimazolam, Eleveld 2025 (Br J Anaesth 135:206-217): port of
 * remimazolam() in R/drugs_remimazolam.R.  Volumes scale with
 * pkSizeFactors() (legacy: weight / 70, clearances (weight / 70)^0.75), V3
 * with age and sex, CL1 with sex; the Pugh-Child and opioid terms are not
 * applied, as in the R.  The model supplies ke0 itself, the published MOAA/S
 * equilibration exp(-1.20976) = 0.2983 /min, and no tPeak: the time to peak
 * effect is solved from it (about 2.4 min for the reference adult).
 */
export function remimazolam(weight, height, age, sex, adjustToFFM = true) {
  const size = pkSizeFactors(weight, height, age, sex, adjustToFFM, undefined, Math.pow(weight / 70, 0.75));
  const Fsize = size.volume;
  const Kv3_age = 7.31;
  const Kcl1_sex = 16.3;
  const Kv3_sex = 28.7;
  const Fv3_age = Math.exp(Kv3_age / 1000 * (age - 35));
  let Fcl1_sex = 1;
  let Fv3_sex = 1;
  if (sex === SEX_FEMALE) {
    Fcl1_sex = Math.exp(Kcl1_sex / 100);
    Fv3_sex = Math.exp(Kv3_sex / 100);
  }
  const v1 = 4.31 * Fsize;
  const v2 = 12.3 * Fsize;
  const v3 = 18.6 * Fsize * Fv3_age * Fv3_sex;
  const cl1 = 1.12 * size.clearance * Fcl1_sex;
  const cl2 = 1.45 * Math.pow(v2 / 12.3, 0.75);
  const cl3 = 0.298 * Math.pow(v3 / 18.6, 0.75);
  return {
    PK: { v1, v2, v3, cl1, cl2, cl3 },
    ke0: Math.exp(-1.20976),
    tPeak: null,
    reference: "Eleveld DJ et al., Br J Anaesth 2025;135(1):206-217. https://pubmed.ncbi.nlm.nih.gov/40312166/",
    branch: "eleveld2025",
  };
}

/** The drug functions by API name; anything not listed here is not a FauxTCI drug. */
export const DRUG_FUNCTIONS = Object.freeze({ propofol, remifentanil, sufentanil, remimazolam });

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
// R's sum() and uniroot()

// A double as an exact binary fraction m * 2^e (m a BigInt, signed).
const F64 = new DataView(new ArrayBuffer(8));
function toBinary(x) {
  F64.setFloat64(0, x);
  const hi = F64.getUint32(0);
  const lo = F64.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const biased = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (biased === 0) { e = -1074; } else { m |= 1n << 52n; e = biased - 1075; }
  return { m: sign * m, e };
}

// Round m * 2^e to `bits` significant bits, to nearest, ties to even.
function roundBinary({ m, e }, bits) {
  if (m === 0n) return { m, e };
  const sign = m < 0n ? -1n : 1n;
  let a = m < 0n ? -m : m;
  const length = a.toString(2).length;
  if (length <= bits) return { m, e };
  const shift = BigInt(length - bits);
  const q = a >> shift;
  const r = a & ((1n << shift) - 1n);
  const half = 1n << (shift - 1n);
  a = (r > half || (r === half && (q & 1n) === 1n)) ? q + 1n : q;
  return { m: sign * a, e: e + Number(shift) };
}

function addBinary(x, y) {
  if (x.m === 0n) return y;
  if (y.m === 0n) return x;
  const e = Math.min(x.e, y.e);
  return { m: (x.m << BigInt(x.e - e)) + (y.m << BigInt(y.e - e)), e };
}

/**
 * A sum as R's sum() gives it.  R adds a double vector term by term in a long
 * double (on x86-64 the x87 80-bit format, a 64-bit significand) and rounds
 * the total to a double once.  Where the terms nearly cancel, as the
 * effect-site curve's do near its start, that is neither a left-to-right
 * double sum nor the correctly rounded one, and Brent's search turns the
 * difference into a different iterate.  So the accumulator is carried here
 * exactly, as a binary fraction, and rounded to 64 significant bits after
 * every addition and to 53 at the end, which is the x87's arithmetic.
 */
export function sumR(values) {
  let acc = { m: 0n, e: 0 };
  for (const x of values) {
    if (!Number.isFinite(x)) return values.reduce((s, v) => s + v, 0); // R: Inf/NaN propagate
    if (x === 0) continue;
    acc = roundBinary(addBinary(acc, toBinary(x)), 64);
  }
  if (acc.m === 0n) return 0;
  const d = roundBinary(acc, 53);
  return Number(d.m) * Math.pow(2, d.e);
}

/**
 * Brent's root finder on [ax, bx] given f(ax) and f(bx): a line-for-line port
 * of R_zeroin2() in R's src/library/stats/src/zeroin.c, which is what
 * stats::uniroot() calls.  As uniroot()'s wrapper does, a non-finite f value
 * becomes the largest double of its sign (NaN as positive).  Returns the root
 * (uniroot()'s $root).
 */
export function zeroin2(f, ax, bx, fa, fb, tol, maxit = UNIROOT_MAXITER) {
  const fcn = (x) => {
    const value = f(x);
    if (Number.isFinite(value)) return value;
    return value === -Infinity ? -Number.MAX_VALUE : Number.MAX_VALUE;
  };
  let a = ax;
  let b = bx;
  let c = a;
  let fc = fa;
  if (fa === 0) return a;
  if (fb === 0) return b;
  let iterations = maxit + 1;
  while (iterations-- > 0) {
    const prevStep = b - a;
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a;
      fa = fb; fb = fc; fc = fa;
    }
    const tolAct = 2 * Number.EPSILON * Math.abs(b) + tol / 2;
    let newStep = (c - b) / 2;
    if (Math.abs(newStep) <= tolAct || fb === 0) return b;
    if (Math.abs(prevStep) >= tolAct && Math.abs(fa) > Math.abs(fb)) {
      let p;
      let q;
      const cb = c - b;
      if (a === c) {
        const t1 = fb / fa;
        p = cb * t1;
        q = 1.0 - t1;
      } else {
        q = fa / fc;
        const t1 = fb / fc;
        const t2 = fb / fa;
        p = t2 * (cb * q * (q - t1) - (b - a) * (t1 - 1.0));
        q = (q - 1.0) * (t1 - 1.0) * (t2 - 1.0);
      }
      if (p > 0) q = -q; else p = -p;
      if (p < (0.75 * cb * q - Math.abs(tolAct * q) / 2) && p < Math.abs(prevStep * q / 2)) newStep = p / q;
    }
    if (Math.abs(newStep) < tolAct) newStep = newStep > 0 ? tolAct : -tolAct;
    a = b; fa = fb;
    b += newStep; fb = fcn(b);
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) { c = a; fc = fa; }
  }
  return b; // did not converge, as R's returns its last iterate
}

/**
 * stats::uniroot(f, c(lower, upper), tol = tol)$root: f at both ends (an
 * error if they share a sign, as R's), then zeroin2().
 */
export function uniroot(f, lower, upper, tol = OPTIMIZE_TOL, maxit = UNIROOT_MAXITER) {
  if (!(lower < upper)) throw new Error("uniroot: lower < upper is not fulfilled");
  const fLower = f(lower);
  const fUpper = f(upper);
  if (Number.isNaN(fLower) || Number.isNaN(fUpper)) throw new Error("uniroot: f() is NA at an end point");
  const clamp = (v) => Math.max(Math.min(v, Number.MAX_VALUE), -Number.MAX_VALUE);
  if (clamp(fLower) * clamp(fUpper) > 0) throw new Error("uniroot: f() values at end points not of opposite sign");
  return zeroin2(f, lower, upper, fLower, fUpper, tol, maxit);
}

// ---------------------------------------------------------------------------
// ke0 and the time to peak effect

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
 * A rate constant nudged off any of `others` it ties with: port of
 * separateEigenvalues() in R/metaboliteCoefficients.R for one rate.  A tie is
 * |rate - other| < 1e-10 max(rate, other), and the nudge a relative 1e-8, far
 * below any published parameter's precision; zeros are left alone.
 */
export function separateEigenvalues(rate, others) {
  if (Number.isNaN(rate) || rate <= 0) return rate;
  let value = rate;
  for (const other of others) {
    if (Number.isNaN(other) || !(other > 0)) continue;
    if (Math.abs(value - other) < 1e-10 * Math.max(value, other)) value *= (1 + 1e-8);
  }
  return value;
}

/**
 * The time of the peak effect-site concentration after a unit IV bolus: port
 * of effectSitePeakTime() in R/getDrugPK.R.  The plasma curve is the bolus
 * response sum coef_i exp(-lambda_i t) over the positive lambdas; the effect
 * site is sum e_i exp(-lambda_i t) - sum(e) exp(-ke0 t) with
 * e_i = coef_i ke0 / (ke0 - lambda_i), maximised by Brent's fmin on
 * [0, min(4000, 20 / slowest rate)] with R's default tolerance.  Returns
 * { time, window }.
 */
export function effectSitePeak(coef, lambda, ke0, upper = PEAK_SEARCH_MAX) {
  const c = [];
  const l = [];
  lambda.forEach((value, i) => { if (value > 0) { c.push(coef[i]); l.push(value); } });
  const k = separateEigenvalues(ke0, l);
  const e = c.map((ci, i) => ci * k / (k - l[i]));
  const window = Math.min(upper, 20 / Math.min(...l, k));
  const sumE = sumR(e);
  const curve = (t) => sumR(e.map((ei, i) => ei * Math.exp(-l[i] * t))) - sumE * Math.exp(-k * t);
  const time = brentFmin((t) => -curve(t), 0, window, OPTIMIZE_TOL);
  return { time, window };
}

/** effectSitePeakTime(): the peak time alone. */
export function effectSitePeakTime(coef, lambda, ke0, upper = PEAK_SEARCH_MAX) {
  return effectSitePeak(coef, lambda, ke0, upper).time;
}

/**
 * The bracket ke0FromTPeakBolus() searches: lo from 1e-3 down by tens while
 * the effect site there still peaks before tPeak, hi from 1 up by tens while
 * it still peaks after.  Returns { lower, upper }.
 */
export function ke0Bracket(tPeak, coef, lambda) {
  const peakAt = (z) => effectSitePeakTime(coef, lambda, z);
  let lo = 1e-3;
  let hi = 1;
  while (peakAt(lo) < tPeak && lo > KE0_SOLVE_MIN) lo /= 10;
  while (peakAt(hi) > tPeak && hi < KE0_SOLVE_MAX) hi *= 10;
  return { lower: lo, upper: hi };
}

/**
 * ke0 from the time to peak effect after an IV bolus: port of
 * ke0FromTPeakBolus() in R/getDrugPK.R.  The peak time falls monotonically
 * as ke0 rises, so the root of effectSitePeakTime(ke0) - tPeak is bracketed
 * (ke0Bracket()) and found with uniroot() at tol sqrt(eps).  A tPeak outside
 * the bracket gets the bracket's nearer end, as in the R.  `coef` are the
 * plasma bolus coefficients and `lambda` the eigenvalues; this is ke0 BEFORE
 * getDrugPK() runs it through separateEigenvalues().
 */
export function ke0FromTPeakBolus(tPeak, coef, lambda) {
  const peakAt = (z) => effectSitePeakTime(coef, lambda, z);
  const { lower, upper } = ke0Bracket(tPeak, coef, lambda);
  if (peakAt(lower) < tPeak) return lower;
  if (peakAt(upper) > tPeak) return upper;
  return uniroot((z) => peakAt(z) - tPeak, lower, upper, UNIROOT_TOL);
}

// ---------------------------------------------------------------------------
// Rate constants and coefficients, as getDrugPK() builds them

/**
 * From the six disposition parameters to the complete IV parameter set the
 * controller needs: the micro rate constants, the eigenvalues, the plasma and
 * effect-site bolus and infusion coefficients and ke0.  A port of the
 * coefficient block of getDrugPK() in R/getDrugPK.R for an IV drug.  ke0 is
 * solved from `tPeak` (ke0FromTPeakBolus()), or is `modelKe0` when the drug
 * function supplies one (remimazolam), and either is then nudged off the
 * eigenvalues (separateEigenvalues()); a `tPeak` of null with a ke0 is solved
 * as effectSitePeakTime() at that ke0, as getDrugPK() does for a model that
 * leaves tPeak out.  Pass `ke0` to inject a known value (the fixtures' R
 * value, already nudged) in place of the solve, which is how the coefficient
 * arithmetic is validated independently of the root finder.
 *
 * Returns { params, coef: {pbolus, pinf, ebolus, einf}, lambda3, lambda4 }
 * with params = {v1, v2, v3, cl1, cl2, cl3, k10, k12, k13, k21, k31,
 * lambda_1, lambda_2, lambda_3, ke0, tPeak}.
 */
export function buildKinetics(PK, tPeak, ke0 = null, modelKe0 = null) {
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

  // ke0, as getDrugPK() finds it for an IV drug: injected, the model's own,
  // or solved from tPeak against the IV bolus response; then off the
  // eigenvalues.
  const lambdas = [lambda_1, lambda_2, lambda_3];
  const pbolusVector = [p_coef_bolus_l1, p_coef_bolus_l2, p_coef_bolus_l3];
  let ke0Value;
  if (ke0 !== null && ke0 !== undefined) {
    if (typeof ke0 !== "number" || !Number.isFinite(ke0) || ke0 <= 0) {
      throw new Error("buildKinetics: an injected ke0 must be a positive finite number");
    }
    ke0Value = ke0;
  } else if (typeof modelKe0 === "number" && modelKe0 > 0) {
    ke0Value = separateEigenvalues(modelKe0, lambdas);
  } else if (tPeak > 0) {
    ke0Value = separateEigenvalues(ke0FromTPeakBolus(tPeak, pbolusVector, lambdas), lambdas);
  } else {
    ke0Value = 0;
  }
  // A model that gives ke0 and no tPeak: the effect site's own peak.
  let tPeakValue = tPeak;
  if ((tPeak === null || tPeak === undefined) && ke0Value > 0) {
    tPeakValue = effectSitePeakTime(pbolusVector, lambdas, ke0Value);
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
      tPeak: ke0Value > 0 ? tPeakValue : 0, // tciKinetics(): tPeak is 0 without an effect site
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
 * tciKinetics() in stanpumpR).  Only the drugs of DRUG_FUNCTIONS are known;
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
    throw new Error(`unknown drug ${JSON.stringify(drug)}: FauxTCI knows ${Object.keys(DRUG_FUNCTIONS).join(", ")}`);
  }
  validateCovariates({ weight, height, age, sex });
  const adjust = adjustToFFM !== false;

  const model = drugFunction(weight, height, age, sex, adjust);
  const kinetics = buildKinetics(model.PK, model.tPeak, ke0, model.ke0 ?? null);
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
