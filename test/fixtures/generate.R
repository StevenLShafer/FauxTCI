#!/usr/bin/env Rscript
# generate.R -- golden fixtures for FauxTCI (a pure-JavaScript port of the
# stanpumpR TCI API controller and of the propofol / remifentanil models).
#
# Run from the root of a stanpumpR checkout:
#
#   cd /path/to/stanpumpR && LC_ALL=C.UTF-8 NOT_CRAN=true RENV_CONFIG_AUTOLOADER_ENABLED=FALSE \
#     Rscript /path/to/fauxtci-fixtures/generate.R [output-dir]
#
# The output directory defaults to the directory this script lives in.  The
# package is loaded with devtools::load_all("."), so internal functions
# (tPeakError, CE, tciKinetics, tciAdvance, tciApiToBase, ...) are visible.
#
# Every JSON file is written with
#   jsonlite::toJSON(x, auto_unbox = TRUE, digits = NA, null = "null", pretty = TRUE)
# which keeps 15 significant digits, exactly as the Plumber router serializes
# a response.  Nothing in /path/to/stanpumpR is modified.

args <- commandArgs(trailingOnly = TRUE)
scriptPath <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE))
OUT <- if (length(args) >= 1) args[1] else dirname(normalizePath(scriptPath))
dir.create(OUT, showWarnings = FALSE, recursive = TRUE)
PKG <- Sys.getenv("STANPUMPR_DIR", ".")

suppressPackageStartupMessages(devtools::load_all(PKG, quiet = TRUE))

GENERATED_AT <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
COMMIT <- tryCatch(system2("git", c("-C", PKG, "rev-parse", "HEAD"), stdout = TRUE), error = function(e) NA_character_)
VERSION <- as.character(utils::packageVersion("stanpumpR"))

# ---------------------------------------------------------------------------
# Helpers

writeJSON <- function(x, file) {
  txt <- jsonlite::toJSON(x, auto_unbox = TRUE, digits = NA, null = "null", pretty = TRUE)
  con <- file(file.path(OUT, file), open = "wb")
  on.exit(close(con))
  writeLines(enc2utf8(as.character(txt)), con, useBytes = TRUE)
  invisible(file.path(OUT, file))
}

# A number as the JSON file will carry it (15 significant digits), so that
# the request the fixture stores is bit-for-bit the request R was given.
j15 <- function(x) as.numeric(sprintf("%.15g", x))

START_TEXT <- "2026-10-11T14:00:00.000Z"
START <- as.numeric(lubridate::ymd_hms("2026-10-11T14:00:00Z", tz = "UTC"))   # 1791727200
atSec <- function(s) tciApiFormatTime(START + s)
secOf <- function(stamp) as.numeric(lubridate::ymd_hms(stamp, tz = "UTC")) - START

# receivedAt = the request's now + 0.2 s, as the task fixes it.
callApi <- function(req, nowSec = secOf(req$now))
  tciNextRate(req, receivedAt = START + nowSec + 0.2)

apiError <- function(req, drug = req[["drug"]], nowSec = 0)
  tryCatch({ tciNextRate(req, drug = drug, receivedAt = START + nowSec + 0.2); NULL },
           tci_api_error = function(e) e)

warningCodes <- function(r) I(vapply(r$warnings, `[[`, "", "code"))

PATIENTS <- list(
  list(id = "adult-male-70",      weight = 70,  height = 170, age = 50, sex = "male"),
  list(id = "adult-female-60",    weight = 60,  height = 165, age = 35, sex = "female"),
  list(id = "obese-male-100",     weight = 100, height = 180, age = 60, sex = "male"),
  list(id = "obese-female-120",   weight = 120, height = 175, age = 45, sex = "female"),
  list(id = "child-male-20",      weight = 20,  height = 110, age = 5,  sex = "male"),
  list(id = "elderly-female-85",  weight = 85,  height = 175, age = 80, sex = "female"),
  list(id = "young-female-45",    weight = 45,  height = 160, age = 25, sex = "female"),
  list(id = "neonate-male-3.5",   weight = 3.5, height = 50,  age = 0,  sex = "male")
)
P70 <- PATIENTS[[1]]
P100 <- PATIENTS[[3]]
P20 <- PATIENTS[[5]]
covariatesOf <- function(pt) pt[c("weight", "height", "age", "sex")]

DRUGS <- c("propofol", "remifentanil")
defaultInfusate <- function(drug)
  if (drug == "propofol") list(concentration = 10, units = "mg/mL") else list(concentration = 50, units = "mcg/mL")
defaultTarget <- function(drug) if (drug == "propofol") 3 else 4
concUnitsOf <- function(drug) if (drug == "propofol") "mcg/mL" else "ng/mL"
massUnitOf <- function(drug) if (drug == "propofol") "mg" else "mcg"

pkOf <- function(drug, pt, adjustToFFM = TRUE)
  getDrugPK(drug, pt$weight, pt$height, pt$age, pt$sex, getDrugDefaults(drug), adjustToFFM = adjustToFFM)

# ---------------------------------------------------------------------------
# 1. models.json

modelEntry <- function(drug, pt) {
  PK <- pkOf(drug, pt)
  k <- PK$PK[[1]]
  X <- do.call(drug, c(covariatesOf(pt), list(adjustToFFM = TRUE)))   # the drug function itself
  bmi <- pt$weight / (pt$height / 100)^2
  branch <- if (drug == "remifentanil") { if (bmi < 30) "eleveld2017" else "kim2017" } else "eleveld2018"
  list(
    drug = drug,
    patientId = pt$id,
    patient = covariatesOf(pt),
    adjustToFFM = TRUE,
    bmi = bmi,
    branch = branch,
    tPeak = PK$tPeak,
    tPeakRoute = PK$tPeakRoute,
    reference = PK$reference,
    Concentration.Units = PK$Concentration.Units,
    Bolus.Units = PK$Bolus.Units,
    Infusion.Units = PK$Infusion.Units,
    Default.Units = PK$Default.Units,
    Units = I(PK$Units[[1]]),
    typical = PK$typical, lowerTypical = PK$lowerTypical, upperTypical = PK$upperTypical,
    MEAC = PK$MEAC, endCe = PK$endCe,
    # What the drug function itself returns, before getDrugPK() derives anything.
    drugFunction = list(
      returns = I(names(X)),
      PK = X$PK[[1]],
      exposesIntermediates = FALSE,
      intermediateNames = I(character(0))
    ),
    # The FULL default PK set as getDrugPK() builds it (every field).
    pk = k,
    # The model block exactly as tciApiModel() returns it (with hash).
    model = tciApiModel(drug, pt$weight, pt$height, pt$age, pt$sex, TRUE)
  )
}

message("models.json ...")
modelEntries <- list()
for (drug in DRUGS) for (pt in PATIENTS) modelEntries[[length(modelEntries) + 1]] <- modelEntry(drug, pt)
models <- list(
  generatedAt = GENERATED_AT, stanpumpRCommit = COMMIT, stanpumpRVersion = VERSION, rVersion = R.version.string,
  notes = paste(
    "One entry per drug x patient.  `pk` is the complete default PK set from getDrugPK(drug, weight, height, age, sex,",
    "getDrugDefaults(drug), adjustToFFM = TRUE)$PK$default: v1..cl3 come from the drug function (R/drugs_propofol.R,",
    "R/drugs_remifentanil.R); k10 = cl1/v1, k12 = cl2/v1, k13 = cl3/v1, k21 = cl2/v2, k31 = cl3/v3; lambda_1 >= lambda_2 >=",
    "lambda_3 are the roots of cube(k10, k12, k13, k21, k31) (R/cube.R, trigonometric solution of the cubic);",
    "p_coef_bolus_l1 = (k21 - l1)(k31 - l1) / ((l1 - l2)(l1 - l3) v1) and cyclic; p_coef_infusion_li = p_coef_bolus_li / li;",
    "ke0 is solved from tPeak (see ke0-solve.json); e_coef_bolus_li = p_coef_bolus_li * ke0 / (ke0 - li),",
    "e_coef_bolus_ke0 = -(sum of the three), e_coef_infusion_li = e_coef_bolus_li / li, e_coef_infusion_ke0 = e_coef_bolus_ke0 / ke0.",
    "All ka_*, bioavailability_*, tlag_* and *_PO/IM/IN/SL/RA/PO2 coefficients are 0 for these two IV drugs.",
    "`model` is tciApiModel()'s block verbatim; `model.hash` is md5 of jsonlite::toJSON(parameters rounded to signif(., 10),",
    "auto_unbox = TRUE, digits = NA) followed by a newline (writeLines), i.e. tools::md5sum of that file.",
    "`branch`: remifentanil uses Eleveld 2017 below BMI 30 and Kim 2017 at or above (BMI = weight / (height/100)^2);",
    "propofol is always Eleveld 2018.  Neither drug function exposes its intermediate quantities (FFM, maturation",
    "factors, KMAT, ksex, ...): they return only PK, tPeak, reference (remifentanil also MEAC, typical, upperTypical,",
    "lowerTypical).  adjustToFFM is accepted and ignored by both (each carries its own fat-free-mass covariate)."),
  patients = PATIENTS,
  entries = modelEntries
)
writeJSON(models, "models.json")

# ---------------------------------------------------------------------------
# 2. ke0-solve.json

# A pure-R transcription of R's Brent_fmin (src/library/stats/src/optimize.c,
# the Netlib FMIN of Forsythe, Malcolm & Moler), used to check that the
# description in `notes` reproduces stats::optimize() bit for bit.
brentFmin <- function(f, ax, bx, tol) {
  cgold <- (3 - sqrt(5)) * 0.5
  eps <- sqrt(.Machine$double.eps)
  a <- ax; b <- bx
  v <- a + cgold * (b - a); w <- v; x <- v
  d <- 0; e <- 0
  fx <- f(x); fv <- fx; fw <- fx
  tol3 <- tol / 3
  repeat {
    xm <- (a + b) * 0.5
    tol1 <- eps * abs(x) + tol3
    t2 <- tol1 * 2
    if (abs(x - xm) <= t2 - (b - a) * 0.5) break
    p <- 0; q <- 0; r <- 0
    if (abs(e) > tol1) {
      r <- (x - w) * (fx - fv)
      q <- (x - v) * (fx - fw)
      p <- (x - v) * q - (x - w) * r
      q <- (q - r) * 2
      if (q > 0) p <- -p else q <- -q
      r <- e
      e <- d
    }
    if (abs(p) >= abs(q * 0.5 * r) || p <= q * (a - x) || p >= q * (b - x)) {
      e <- if (x < xm) b - x else a - x
      d <- cgold * e
    } else {
      d <- p / q
      u <- x + d
      if (u - a < t2 || b - u < t2) {
        d <- tol1
        if (x >= xm) d <- -d
      }
    }
    if (abs(d) >= tol1) u <- x + d
    else if (d > 0) u <- x + tol1
    else u <- x - tol1
    fu <- f(u)
    if (fu <= fx) {
      if (u < x) b <- x else a <- x
      v <- w; w <- x; x <- u
      fv <- fw; fw <- fx; fx <- fu
    } else {
      if (u < x) a <- u else b <- u
      if (fu <= fw || w == x) {
        v <- w; fv <- fw
        w <- u; fw <- fu
      } else if (fu <= fv || v == x || v == w) {
        v <- u; fv <- fu
      }
    }
  }
  x
}
OPT_TOL <- .Machine$double.eps^0.25

# tPeakError() with the inner stats::optimize() replaced by brentFmin().
tPeakErrorBrent <- function(lambda_4, tPeak, p1, p2, p3, l1, l2, l3) {
  e1 <- p1 / (lambda_4 - l1) * lambda_4
  e2 <- if (l2 > 0) p2 / (lambda_4 - l2) * lambda_4 else 0
  e3 <- if (l3 > 0) p3 / (lambda_4 - l3) * lambda_4 else 0
  e4 <- -e1 - e2 - e3
  predPeak <- brentFmin(function(t) -CE(t, e1, e2, e3, e4, l1, l2, l3, lambda_4), 0, 100, OPT_TOL)
  (tPeak - predPeak)^2
}

ke0Entry <- function(drug, pt) {
  PK <- pkOf(drug, pt)
  k <- PK$PK[[1]]
  tPeak <- PK$tPeak
  pc <- c(k$p_coef_bolus_l1, k$p_coef_bolus_l2, k$p_coef_bolus_l3)
  lam <- c(k$lambda_1, k$lambda_2, k$lambda_3)
  ke0 <- k$ke0

  # The solve, exactly as getDrugPK() does it.
  ke0Resolved <- stats::optimize(tPeakError, c(0, 200), tPeak, pc[1], pc[2], pc[3], lam[1], lam[2], lam[3])$minimum
  # The same with the pure-R Brent (outer and inner).
  ke0Brent <- brentFmin(function(z) tPeakErrorBrent(z, tPeak, pc[1], pc[2], pc[3], lam[1], lam[2], lam[3]), 0, 200, OPT_TOL)

  # Effect-site bolus coefficients at the solved ke0 (what tPeakError builds).
  ec <- pc / (ke0 - lam) * ke0
  ec4 <- -sum(ec)
  ceUnit <- function(t) CE(t, ec[1], ec[2], ec[3], ec4, lam[1], lam[2], lam[3], ke0)
  # Round trip 1: the peak as the INNER optimizer finds it (default tol).
  inner <- stats::optimize(CE, c(0, 100), ec[1], ec[2], ec[3], ec4, lam[1], lam[2], lam[3], ke0, maximum = TRUE)
  # Round trip 2: the peak to machine precision (root of dCe/dt).
  dCe <- function(t) -sum(c(ec, ec4) * c(lam, ke0) * exp(-c(lam, ke0) * t))
  peakExact <- stats::uniroot(dCe, c(1e-6, 100), tol = 1e-14)$root
  # A "perfect" ke0: the one whose exact peak time equals tPeak.
  peakTimeFor <- function(z) {
    e <- pc / (z - lam) * z; e4 <- -sum(e)
    stats::uniroot(function(t) -sum(c(e, e4) * c(lam, z) * exp(-c(lam, z) * t)), c(1e-6, 100), tol = 1e-14)$root
  }
  ke0Exact <- stats::uniroot(function(z) peakTimeFor(z) - tPeak, c(ke0 * 0.5, ke0 * 2), tol = 1e-14)$root

  factors <- c(0.5, 0.8, 0.95, 1, 1.05, 1.25, 2)
  samples <- lapply(factors, function(f) {
    z <- ke0 * f
    e <- pc / (z - lam) * z; e4 <- -sum(e)
    list(ke0 = z,
         predPeak = stats::optimize(CE, c(0, 100), e[1], e[2], e[3], e4, lam[1], lam[2], lam[3], z, maximum = TRUE)$maximum,
         objective = tPeakError(z, tPeak, pc[1], pc[2], pc[3], lam[1], lam[2], lam[3]))
  })

  list(
    drug = drug, patientId = pt$id, patient = covariatesOf(pt),
    tPeak = tPeak,
    inputs = list(p_coef_bolus = pc, lambda = lam),
    ke0 = ke0,
    ke0Resolved = ke0Resolved,
    resolveIdentical = identical(ke0, ke0Resolved),
    ke0PureRBrent = ke0Brent,
    pureRBrentIdentical = identical(ke0, ke0Brent),
    objectiveAtKe0 = tPeakError(ke0, tPeak, pc[1], pc[2], pc[3], lam[1], lam[2], lam[3]),
    e_coef_bolus = c(ec, ec4),
    roundTrip = list(
      peakTimeInnerOptimize = inner$maximum,
      ceAtPeakInnerOptimize = inner$objective,
      peakTimeExact = peakExact,
      ceAtPeakExact = ceUnit(peakExact),
      peakTimeMinusTPeak = peakExact - tPeak
    ),
    ke0Exact = ke0Exact,
    ke0ExactRelativeDifference = (ke0Exact - ke0) / ke0,
    objectiveSamples = samples
  )
}

message("ke0-solve.json ...")
ke0Entries <- list()
for (drug in DRUGS) for (pt in PATIENTS) ke0Entries[[length(ke0Entries) + 1]] <- ke0Entry(drug, pt)
ke0Notes <- paste(
  "HOW ke0 IS DERIVED FROM tPeak (R/getDrugPK.R).  For an IV drug (tPeakRoute 'IV', no X$ke0 supplied) getDrugPK() runs",
  "  ke0 <- stats::optimize(tPeakError, c(0, 200), tPeak, p_coef_bolus_l1, p_coef_bolus_l2, p_coef_bolus_l3, lambda_1, lambda_2, lambda_3)$minimum",
  "i.e. Brent's fmin on the interval [0, 200] /min with the DEFAULT tolerance tol = .Machine$double.eps^0.25 = 2^-13 =",
  "0.0001220703125 (absolute, in ke0 units).  The objective tPeakError(lambda_4 = ke0, tPeak, p1, p2, p3, l1, l2, l3) is:",
  "  e_i = p_i * ke0 / (ke0 - l_i) for the three plasma exponentials (e_2, e_3 are 0 when l_2, l_3 are 0), e_4 = -(e_1 + e_2 + e_3);",
  "  predPeak = stats::optimize(CE, c(0, 100), e_1, e_2, e_3, e_4, l_1, l_2, l_3, ke0, maximum = TRUE)$maximum, where",
  "  CE(t) = e_1 exp(-l_1 t) + e_2 exp(-l_2 t) + e_3 exp(-l_3 t) + e_4 exp(-ke0 t) is the effect-site concentration after a",
  "  UNIT IV BOLUS (the plasma curve is the bolus response sum p_i exp(-l_i t), p_i = p_coef_bolus_li);",
  "  return (tPeak - predPeak)^2.",
  "So it is a NESTED Brent minimisation: the inner optimize (maximum = TRUE, interval [0, 100] min, same default tol) finds",
  "the peak time of the unit-bolus effect-site curve for a trial ke0; the outer one minimises the squared miss of tPeak.",
  "stats::optimize(maximum = TRUE) minimises function(arg) -f(arg, ...) and returns list(maximum = argmin, objective = f(argmin)).",
  "The C routine is Brent_fmin() in R's src/library/stats/src/optimize.c (Netlib FMIN, Forsythe-Malcolm-Moler):",
  "  c = (3 - sqrt(5))/2; eps = sqrt(DBL_EPSILON); x = v = w = a + c (b - a); fx = f(x); d = e = 0; tol3 = tol/3;",
  "  loop: xm = (a+b)/2; tol1 = eps |x| + tol3; t2 = 2 tol1; stop when |x - xm| <= t2 - (b - a)/2;",
  "  if |e| > tol1 fit a parabola through (v,fv),(w,fw),(x,fx): r = (x-w)(fx-fv); q = (x-v)(fx-fw); p = (x-v) q - (x-w) r;",
  "  q = 2 (q - r); if q > 0 then p = -p else q = -q; r = e; e = d;",
  "  golden-section step (e = (x < xm ? b : a) - x; d = c e) when |p| >= |q r / 2| or p <= q (a - x) or p >= q (b - x),",
  "  else parabolic step d = p/q, u = x + d, and if u - a < t2 or b - u < t2 then d = (x >= xm ? -tol1 : tol1);",
  "  u = x + d if |d| >= tol1 else x +/- tol1 (sign of d); fu = f(u);",
  "  if fu <= fx: (u < x ? b = x : a = x); v = w; w = x; x = u; fv = fw; fw = fx; fx = fu;",
  "  else: (u < x ? a = u : b = u); if fu <= fw or w == x: v = w, fv = fw, w = u, fw = fu; else if fu <= fv or v == x or v == w: v = u, fv = fu.",
  "  return x.",
  "The pure-R transcription brentFmin() in generate.R, applied to BOTH levels, reproduced every ke0 in this file bit for bit",
  "(see pureRBrentIdentical), so a JavaScript port of the same algorithm with the same tolerance should match R's ke0 to",
  "within a few ulps whenever its exp() agrees with R's libm; a last-bit difference in exp() can in principle change a branch",
  "and move the result by up to the stopping width (about 2 tol1 = 2 (sqrt(eps) |ke0| + tol/3), i.e. ~8e-5 absolute).",
  "ACHIEVABLE ACCURACY WITHOUT PORTING BRENT: because the outer tolerance is absolute 1.22e-4 and the inner peak time is itself",
  "only resolved to ~4e-5 min, R's ke0 is NOT the exact root.  `ke0Exact` is the ke0 whose exact (uniroot, tol 1e-14) peak",
  "time equals tPeak; `ke0ExactRelativeDifference` shows how far R's value is from it (of order 1e-5 to 1e-4 relative).",
  "A port using a different (better) optimizer should therefore expect agreement with R's ke0 only to that order; to validate",
  "coefficients and controller output independently of the solve, inject R's ke0 from models.json.",
  "ROUND TRIP: `roundTrip.peakTimeInnerOptimize` is the inner optimizer's peak time for R's ke0 (what the solve 'saw');",
  "`roundTrip.peakTimeExact` is the true peak time of the unit-bolus Ce curve for that ke0; `ceAtPeak*` is Ce there (its",
  "reciprocal is getDrugPK()'s vdPeakEffect).  `objectiveSamples` give tPeakError() and the inner predPeak at ke0 x",
  "{0.5, 0.8, 0.95, 1, 1.05, 1.25, 2} so a port can check its objective function (including the inner optimizer) directly.",
  "Both drugs: tPeak = 1.6 min (propofol: Schnider 1999; remifentanil: 'Opioid simulation spreadsheet'), tPeakRoute IV.")
writeJSON(list(generatedAt = GENERATED_AT, stanpumpRCommit = COMMIT, stanpumpRVersion = VERSION,
               rVersion = R.version.string,
               optimizer = list(
                 outer = list(fn = "stats::optimize", objective = "tPeakError", interval = c(0, 200), tol = OPT_TOL, maximum = FALSE, result = "$minimum"),
                 inner = list(fn = "stats::optimize", objective = "CE", interval = c(0, 100), tol = OPT_TOL, maximum = TRUE, result = "$maximum"),
                 brentGoldenConstant = (3 - sqrt(5)) * 0.5, brentEps = sqrt(.Machine$double.eps)),
               notes = ke0Notes, entries = ke0Entries), "ke0-solve.json")

# ---------------------------------------------------------------------------
# Requests and the closed-loop simulator

makeRequest <- function(drug, nowSec, requestId, history = list(), target = defaultTarget(drug), site = "effect",
                        patient = P70, infusate = defaultInfusate(drug), rateUnits = "mL/hr",
                        maxRate = 1200, minRate = 0.1, rateResolution = 0.1, latency = 1.5, interval = 10,
                        pumpExtra = list(), lookAhead = NULL, options = NULL)
{
  pump <- list(rateUnits = rateUnits, maxRate = maxRate)
  if (!is.null(minRate)) pump$minRate <- minRate
  if (!is.null(rateResolution)) pump$rateResolution <- rateResolution
  for (nm in names(pumpExtra)) pump[[nm]] <- pumpExtra[[nm]]
  req <- list(requestId = requestId, drug = drug, now = atSec(nowSec), patient = covariatesOf(patient))
  if (!is.null(infusate)) req$infusate <- infusate
  req$pump <- pump
  req$target <- list(site = site, value = target, units = concUnitsOf(drug))
  req$timing <- list(latency = latency, interval = interval)
  req$history <- history
  if (!is.null(lookAhead)) req$lookAhead <- list(concentration = lookAhead)
  if (!is.null(options)) req$options <- options
  req
}

# A pump controller in closed loop with tciNextRate(), modelled on
# simulatePump() in tests/testthat/test-tci-api.R.  Time is in seconds from
# START.  Requests go out every `interval` s from t = 0 to t = minutes*60
# INCLUSIVE.  The pump switches to the commanded rate `actualLatency` s after
# the request (the request declares `latency`), records a rate change only
# when the rate changes, and the TRUE state follows the closed-form recurrence
# (tciAdvance()) at the rates actually run; Ce is also sampled every second
# for the maximum.  If a hold ended without a newer command the pump would run
# fallback.rate for fallback.maxSeconds and then stop (never happens here:
# every response is accepted and actualLatency < interval).
runLoop <- function(drug, target = defaultTarget(drug), site = "effect", patient = P70,
                    infusate = defaultInfusate(drug), rateUnits = "mL/hr",
                    maxRate = 1200, minRate = 0.1, rateResolution = 0.1,
                    latency = 1.5, actualLatency = latency, interval = 10, minutes = 30,
                    targetSteps = list(), handBoluses = list(), infusateChanges = list(),
                    recordInitialInfusate = length(infusateChanges) > 0, idPrefix = "loop")
{
  PK <- pkOf(drug, patient)
  K <- tciKinetics(PK)
  base <- massUnitOf(drug)
  curInfusate <- infusate
  concBase <- function() if (is.null(curInfusate)) NA_real_ else tciApiInfusateBase(curInfusate, base)
  toBase <- function(v) tciApiToBase(v, rateUnits, base, patient$weight, concBase())

  S <- list(p = numeric(3), e = numeric(4)); tState <- 0
  pumpValue <- 0; pumpRate <- 0
  history <- list()
  ceTrace <- numeric(0); ceTime <- numeric(0)

  advanceTo <- function(t) {
    if (t <= tState) return(invisible())
    n <- floor((t - tState) + 1e-9)
    if (n >= 1) {
      tau <- seq_len(n) / 60
      d4 <- exp(-outer(K$lambda4, tau))
      ce <- as.vector(S$e %*% d4) + pumpRate * as.vector(K$einf %*% (1 - d4))
      ceTrace <<- c(ceTrace, ce); ceTime <<- c(ceTime, tState + seq_len(n))
    }
    S <<- tciAdvance(S, (t - tState) / 60, pumpRate, K)
    tState <<- t
  }
  setRate <- function(t, value) {
    advanceTo(t)
    value <- j15(value)
    if (value != pumpValue)
      history[[length(history) + 1]] <<- list(time = atSec(t), rate = value, units = rateUnits, source = "tci")
    pumpValue <<- value
    pumpRate <<- toBase(value)
  }
  if (recordInitialInfusate) history[[1]] <- list(time = atSec(0), infusate = curInfusate)

  steps <- list(); requests <- list(); responses <- list()
  pending <- NULL
  t <- 0; i <- 0
  end <- minutes * 60
  while (t <= end + 1e-9) {
    i <- i + 1
    for (ev in targetSteps) if (abs(ev$min * 60 - t) < 1e-9) target <- ev$value
    for (ev in handBoluses) if (abs(ev$min * 60 - t) < 1e-9) {
      advanceTo(t)
      amt <- tciApiToBase(ev$amount, ev$units, base, patient$weight, concBase())
      S$p <- S$p + K$pbolus * amt
      S$e <- S$e + K$ebolus * amt
      history[[length(history) + 1]] <- list(time = atSec(t), bolus = ev$amount, units = ev$units, source = "manual")
    }
    for (ev in infusateChanges) if (abs(ev$min * 60 - t) < 1e-9) {
      advanceTo(t)
      curInfusate <- list(concentration = ev$concentration, units = curInfusate$units)
      pumpRate <- toBase(pumpValue)
      history[[length(history) + 1]] <- list(time = atSec(t), infusate = curInfusate)
    }
    advanceTo(t)
    req <- makeRequest(drug, t, sprintf("%s-%06d", idPrefix, i), history = history, target = target, site = site,
                       patient = patient, infusate = curInfusate, rateUnits = rateUnits, maxRate = maxRate,
                       minRate = minRate, rateResolution = rateResolution, latency = latency, interval = interval)
    r <- callApi(req, t)
    requests[[i]] <- req
    responses[[i]] <- r
    tSwitch <- t + actualLatency
    steps[[i]] <- list(
      index = i, now = req$now, nowSeconds = t, target = target,
      rate = list(value = r$rate$value, units = r$rate$units, ideal = r$rate$ideal, limitedBy = r$rate$limitedBy),
      controller = r$controller,
      fallbackRate = r$fallback$rate,
      timing = r$timing,
      stateNow = list(cp = r$state$now$cp, ce = r$state$now$ce),
      stateHoldUntil = list(cp = r$state$holdUntil$cp, ce = r$state$holdUntil$ce),
      prediction = list(peakCe = r$prediction$peakCe, peakAt = r$prediction$peakAt, onTarget = r$prediction$onTarget),
      trueCp = sum(S$p), trueCe = sum(S$e),
      warnings = warningCodes(r),
      pumpSwitchesAt = atSec(tSwitch)
    )
    tNext <- t + interval
    limit <- tSwitch - 1e-9
    while (!is.null(pending) && pending$at <= limit) {
      setRate(pending$at, pending$rate)
      pending <- if (is.finite(pending$stopAt)) list(at = pending$stopAt, rate = 0, stopAt = Inf) else NULL
    }
    setRate(tSwitch, r$rate$value)
    holdEnd <- tSwitch + interval
    pending <- list(at = holdEnd, rate = r$fallback$rate, stopAt = holdEnd + r$fallback$maxSeconds)
    t <- tNext
  }
  last <- responses[[length(responses)]]
  trueAtLast <- list(p = steps[[length(steps)]]$trueCp, e = steps[[length(steps)]]$trueCe)
  list(drug = drug, PK = PK, K = K, steps = steps, requests = requests, responses = responses,
       finalHistory = requests[[length(requests)]]$history,
       maxTrueCe = max(ceTrace), maxTrueCeAtSeconds = ceTime[which.max(ceTrace)],
       finalTrueState = list(cp = trueAtLast$p, ce = trueAtLast$e),
       finalResponseStateNow = list(cp = last$state$now$cp, ce = last$state$now$ce),
       finalStateRelativeDifference = list(
         cp = abs(trueAtLast$p - last$state$now$cp) / max(abs(last$state$now$cp), 1e-300),
         ce = abs(trueAtLast$e - last$state$now$ce) / max(abs(last$state$now$ce), 1e-300)))
}

# ---------------------------------------------------------------------------
# 3. rate-cases.json

message("rate-cases.json ...")
cases <- list()
addCase <- function(name, drug, req, notes = "") {
  r <- callApi(req)
  cases[[length(cases) + 1]] <<- list(name = name, drug = drug, notes = notes,
                                      compare = list(ignore = I("server")),
                                      warnings = warningCodes(r), request = req, response = r)
  invisible(r)
}

# Twenty-minute loops, whose request at the 20 min mark is the maintenance state.
loops20 <- list()
for (drug in DRUGS) {
  message("  20-min loop ", drug)
  loops20[[drug]] <- runLoop(drug, minutes = 20, idPrefix = paste0("mk-", drug))
}
# Loops with a syringe change at 10 min (10 -> 20 mg/mL; 50 -> 100 mcg/mL).
loopsInf <- list()
for (drug in DRUGS) {
  message("  20-min loop with infusate change ", drug)
  loopsInf[[drug]] <- runLoop(drug, minutes = 20,
                              infusateChanges = list(list(min = 10, concentration = 2 * defaultInfusate(drug)$concentration)),
                              idPrefix = paste0("inf-", drug))
}

for (drug in DRUGS) {
  inf <- defaultInfusate(drug)
  CT <- defaultTarget(drug)
  base <- massUnitOf(drug)
  L20 <- loops20[[drug]]
  n20 <- length(L20$requests)
  maint <- L20$requests[[n20]]          # the request at the 20 min mark (t = 1200 s)
  maintSec <- secOf(maint$now)
  stopifnot(abs(maintSec - 1200) < 1e-9)
  withId <- function(req, id) { req$requestId <- id; req }
  id <- function(case) sprintf("fx-%s-%s", case, drug)

  # (a) empty history, loading from zero
  addCase(paste0("a_empty_history_", drug), drug, makeRequest(drug, 0, id("a")),
          "Empty history: the first plan from an empty body (loading, capped by maxRate for propofol).")

  # (b) literally: 1200 mL/hr for 10 s then 0 for 5 s, now = +15 s
  addCase(paste0("b_after_1200_for_10s_then_off_5s_", drug), drug,
          makeRequest(drug, 15, id("b"), history = list(
            list(time = atSec(0), rate = 1200, units = "mL/hr"),
            list(time = atSec(10), rate = 0, units = "mL/hr"))),
          "History exactly as specified: 1200 mL/hr from +0 to +10 s, 0 from +10 s; request at +15 s.  Whether this is 'waiting for peak' is up to the controller (for propofol one capped interval is not the whole loading dose).")
  # (b2) the real loop's first waitingForPeak request
  phases <- vapply(L20$responses, function(r) r$controller$phase, "")
  wfp <- which(phases == "waitingForPeak")[1]
  if (!is.na(wfp))
    addCase(paste0("b2_first_waitingForPeak_in_loop_", drug), drug, withId(L20$requests[[wfp]], id("b2")),
            sprintf("The first request of the 20-min closed loop (1200 mL/hr cap, latency 1.5, interval 10) whose response phase is waitingForPeak (step %d, t = %g s).", wfp, secOf(L20$requests[[wfp]]$now)))

  # (c) maintenance at 20 min
  rc <- addCase(paste0("c_maintenance_20min_", drug), drug, withId(maint, id("c")),
                "The request formed at the 20 min mark of the closed loop (propofol 1%/remifentanil 50 mcg/mL, 1200 mL/hr cap, minRate 0.1, resolution 0.1, latency 1.5, interval 10); history = every rate change the pump recorded.")
  running <- tail(Filter(function(e) !is.null(e$rate), maint$history), 1)[[1]]$rate

  # (d) target lowered
  reqd <- withId(maint, id("d")); reqd$target$value <- if (drug == "propofol") 2 else 2
  addCase(paste0("d_target_lowered_", drug), drug, reqd, "Same state as (c), target lowered (3 -> 2 mcg/mL propofol; 4 -> 2 ng/mL remifentanil).")
  # (e) target raised
  reqe <- withId(maint, id("e")); reqe$target$value <- if (drug == "propofol") 4 else 6
  addCase(paste0("e_target_raised_", drug), drug, reqe, "Same state as (c), target raised (3 -> 4 mcg/mL propofol; 4 -> 6 ng/mL remifentanil).")
  # (f) hand bolus 30 s ago
  reqf <- withId(maint, id("f"))
  bol <- if (drug == "propofol") list(amount = 20, units = "mg") else list(amount = 50, units = "mcg")
  reqf$history[[length(reqf$history) + 1]] <- list(time = atSec(maintSec - 30), bolus = bol$amount, units = bol$units, source = "manual")
  addCase(paste0("f_hand_bolus_30s_ago_", drug), drug, reqf,
          sprintf("Same state as (c) plus a hand bolus of %g %s at now - 30 s, appended at the END of the history array (the server sorts by time).", bol$amount, bol$units))
  # (g) paused
  reqg <- withId(maint, id("g")); reqg$pump$state <- "paused"; reqg$pump$currentRate <- 0
  addCase(paste0("g_pump_paused_currentRate0_", drug), drug, reqg, "Same state as (c), pump.state 'paused' and currentRate 0: latency projection at rate 0, PUMP_NOT_RUNNING, no RATE_MISMATCH.")
  # (h) delivered segments with an initial infusate event
  rcs <- Filter(function(e) !is.null(e$rate), maint$history)
  segs <- list(list(time = atSec(0), infusate = inf))
  if (length(rcs) >= 2) for (k in seq_len(length(rcs) - 1)) {
    from <- rcs[[k]]$time; to <- rcs[[k + 1]]$time
    hrs <- (secOf(to) - secOf(from)) / 3600
    segs[[length(segs) + 1]] <- list(from = from, to = to, delivered = j15(rcs[[k]]$rate * hrs), units = "mL")
  }
  segs[[length(segs) + 1]] <- rcs[[length(rcs)]]
  reqh <- withId(maint, id("h")); reqh$history <- segs
  addCase(paste0("h_delivered_segments_with_initial_infusate_", drug), drug, reqh,
          "The (c) history rewritten as: an infusate event at t0, one delivered segment (mL = rate x hours, 15 significant digits) per rate-change span, and the last rate change kept as a rate change (the shape of docs/tci-api.md section 4).")
  # (i) infusate change mid-case
  LI <- loopsInf[[drug]]
  addCase(paste0("i_infusate_change_at_10min_", drug), drug, withId(LI$requests[[length(LI$requests)]], id("i")),
          sprintf("20-min closed loop in which the syringe changed at 10 min from %g to %g %s: initial infusate event at t0, infusate event at 10 min, request.infusate = the new syringe; mL/hr rates priced by the syringe in force.", inf$concentration, 2 * inf$concentration, inf$units))
  # (j) minRate above the maintenance rate
  reqj <- withId(maint, id("j")); reqj$pump$minRate <- j15(running * 3)
  addCase(paste0("j_minRate_above_maintenance_", drug), drug, reqj,
          sprintf("Same state as (c) with pump.minRate = %g mL/hr (three times the running maintenance rate %g): the plan is sent as 0, limitedBy minRate.", reqj$pump$minRate, running))
  # (k) rateResolution 1
  reqk <- withId(maint, id("k")); reqk$pump$rateResolution <- 1
  addCase(paste0("k_rateResolution_1_", drug), drug, reqk, "Same state as (c), rateResolution 1 mL/hr (rounded DOWN).")
  # (l) target 0
  reql <- withId(maint, id("l")); reql$target$value <- 0
  addCase(paste0("l_target_0_", drug), drug, reql, "Same state as (c), target 0: plan off, phase stopped, rate 0.")
  # (m) plasma target
  addCase(paste0("m_plasma_target_from_zero_", drug), drug, makeRequest(drug, 0, id("m"), site = "plasma"),
          "Plasma target from an empty history (Bailey & Shafer plan).")
  reqm2 <- withId(maint, id("m2")); reqm2$target$site <- "plasma"
  addCase(paste0("m2_plasma_target_at_maintenance_", drug), drug, reqm2, "Same state as (c) with target.site 'plasma'.")
  # (n) lookAhead + syringe
  reqn <- withId(maint, id("n")); reqn$lookAhead <- list(concentration = 1); reqn$pump$syringeVolumeRemaining <- list(value = 10, units = "mL")
  addCase(paste0("n_lookAhead_1_syringe_10mL_", drug), drug, reqn, "Same state as (c), lookAhead.concentration 1.0 (decrement time) and syringeVolumeRemaining 10 mL (syringeEmptyAt).")
  # (o) volumeInfused 10% high
  fromHistory <- rc$delivered$fromHistory
  reqo <- withId(maint, id("o")); reqo$pump$volumeInfused <- list(value = j15(1.1 * fromHistory / inf$concentration), units = "mL")
  addCase(paste0("o_volumeInfused_plus10pct_DELIVERY_MISMATCH_", drug), drug, reqo,
          sprintf("Same state as (c); the history integrates to %g %s = %g mL and the pump reports 10%% more.", fromHistory, base, fromHistory / inf$concentration))
  # (p) currentRate mismatch
  reqp <- withId(maint, id("p")); reqp$pump$currentRate <- j15(running + 5)
  addCase(paste0("p_currentRate_mismatch_RATE_MISMATCH_", drug), drug, reqp,
          sprintf("Same state as (c); the history says %g mL/hr is running, pump.currentRate says %g.", running, running + 5))
  # (s) interval 30 s; (s2) interval 40 s
  addCase(paste0("s_interval_30s_", drug), drug, makeRequest(drug, 0, id("s"), interval = 30),
          "Interval 30 s from an empty history.  NOTE: INTERVAL_LONG fires only above tPeak*60/3 = 32 s for both drugs (tPeak 1.6 min), so 30 s does NOT warn; see s2.")
  addCase(paste0("s2_interval_40s_INTERVAL_LONG_", drug), drug, makeRequest(drug, 0, id("s2"), interval = 40),
          "Interval 40 s from an empty history: above tPeak*60/3 = 32 s, so INTERVAL_LONG.")
  # (t) latency 6 of 10
  addCase(paste0("t_latency_6_of_10_LATENCY_LONG_", drug), drug, makeRequest(drug, 0, id("t"), latency = 6),
          "Latency 6 s with interval 10 s: more than half, LATENCY_LONG.")
  # (u) target above Upper
  up <- getDrugDefaults(drug)$Upper
  addCase(paste0("u_target_above_Upper_TARGET_HIGH_", drug), drug, makeRequest(drug, 0, id("u"), target = 2 * up),
          sprintf("Target %g %s, above the library's Upper (%g) and below 5 x Upper: TARGET_HIGH.  (Remifentanil's default 4 ng/mL is itself above Upper = 2, so every remifentanil case carries TARGET_HIGH.)", 2 * up, concUnitsOf(drug), up))
  # (v) mass-rate pump units, no infusate
  massUnits <- if (drug == "propofol") "mg/min" else "mcg/min"
  massMax <- 1200 * inf$concentration / 60     # the same ceiling as 1200 mL/hr of the default syringe
  addCase(paste0("v_mass_rate_units_no_infusate_", drug), drug,
          makeRequest(drug, 0, id("v"), infusate = NULL, rateUnits = massUnits, maxRate = massMax,
                      minRate = j15(0.1 * inf$concentration / 60), rateResolution = j15(0.1 * inf$concentration / 60)),
          sprintf("pump.rateUnits %s with no infusate (no mlPerHour / volumeMl in the response); maxRate %g = 1200 mL/hr of the default syringe.", massUnits, massMax))
}
# (q) 100 kg patient on remifentanil (Kim 2017)
addCase("q_100kg_remifentanil_Kim", "remifentanil", makeRequest("remifentanil", 0, "fx-q-remifentanil", patient = P100),
        "100 kg, 180 cm, 60 y male: BMI 30.9 selects remifentanil's Kim 2017 model; empty history.")
# (r) 20 kg child on propofol
addCase("r_20kg_child_propofol", "propofol", makeRequest("propofol", 0, "fx-r-propofol", patient = P20),
        "20 kg, 110 cm, 5 y male on propofol; empty history.")
# extra: the documented example body of docs/tci-api.md section 4 (its own now; receivedAt = now + 0.2)
docBody <- list(
  requestId = "ch1-000193", drug = "propofol", now = "2026-10-11T14:31:58.500Z",
  patient = list(weight = 70, height = 170, age = 50, sex = "male"),
  infusate = list(concentration = 10, units = "mg/mL"),
  pump = list(rateUnits = "mL/hr", maxRate = 1200, minRate = 0.1, rateResolution = 0.1, currentRate = 40.4,
              state = "running", volumeInfused = list(value = 26.95, units = "mL"),
              syringeVolumeRemaining = list(value = 28.5, units = "mL")),
  target = list(site = "effect", value = 3.0, units = "mcg/mL"),
  timing = list(latency = 1.5, interval = 10),
  history = list(
    list(time = "2026-10-11T13:59:30.000Z", infusate = list(concentration = 10, units = "mg/mL")),
    list(time = "2026-10-11T13:59:40.000Z", bolus = 20, units = "mg", source = "manual"),
    list(time = "2026-10-11T14:00:00.000Z", rate = 995.1, units = "mL/hr"),
    list(time = "2026-10-11T14:00:10.000Z", rate = 0, units = "mL/hr"),
    list(from = "2026-10-11T14:01:30.000Z", to = "2026-10-11T14:10:00.000Z", delivered = 7.90, units = "mL"),
    list(from = "2026-10-11T14:10:00.000Z", to = "2026-10-11T14:20:00.000Z", delivered = 7.88, units = "mL"),
    list(from = "2026-10-11T14:20:00.000Z", to = "2026-10-11T14:25:00.000Z", delivered = 3.60, units = "mL"),
    list(from = "2026-10-11T14:25:00.000Z", to = "2026-10-11T14:30:00.000Z", delivered = 3.46, units = "mL"),
    list(from = "2026-10-11T14:30:00.000Z", to = "2026-10-11T14:31:50.000Z", delivered = 1.24, units = "mL"),
    list(time = "2026-10-11T14:31:50.000Z", rate = 40.4, units = "mL/hr")
  ),
  lookAhead = list(concentration = 1.0),
  options = list(adjustToFFM = TRUE)
)
addCase("x_documented_example_section4", "propofol", docBody,
        "The request body of docs/tci-api.md section 4 verbatim; section 6.1 shows its response rounded to four digits.")

# Error cases
message("  error cases ...")
errors <- list()
addError <- function(name, req, status, code, pointer, drug = req[["drug"]], notes = "", requestText = NULL) {
  e <- apiError(req, drug = drug)
  stopifnot(!is.null(e))
  if (!identical(e$status, as.integer(status)) || !identical(e$code, code) || !identical(e$pointer, pointer))
    stop(sprintf("error case %s: expected %s %s %s, got %s %s %s", name, status, code, pointer, e$status, e$code, e$pointer))
  errors[[length(errors) + 1]] <<- list(name = name, notes = notes, drug = drug,
                                        request = if (is.null(requestText)) req else NULL, requestText = requestText,
                                        status = e$status, code = e$code, pointer = e$pointer,
                                        message = conditionMessage(e), requestId = e$requestId)
}
baseReq <- function(id, nowSec = 0, ...) makeRequest("propofol", nowSec, id, ...)
r1 <- baseReq("fx-err-unknown-drug"); r1$drug <- "notadrug"
addError("err_unknown_drug", r1, 404, "UNKNOWN_DRUG", "/drug", notes = "drug 'notadrug' is not in the library (path drug = body drug).")
r2 <- baseReq("fx-err-non-tci-drug"); r2$drug <- "midazolam"
addError("err_non_tci_drug", r2, 422, "DRUG_NOT_TCI", "/drug", notes = "midazolam is in the library but offers no target units.")
r3 <- baseReq("fx-err-missing-now"); r3$now <- NULL
addError("err_missing_now", r3, 400, "MISSING_FIELD", "/now")
r4 <- baseReq("fx-err-numeric-now"); r4$now <- 1791727200
addError("err_numeric_now", r4, 400, "INVALID_TYPE", "/now", notes = "now as a JSON number (epoch seconds).")
r5 <- baseReq("fx-err-epoch-history-time", history = list(list(time = 1791727200, rate = 100, units = "mL/hr")), nowSec = 10)
addError("err_epoch_number_history_time", r5, 400, "INVALID_TYPE", "/history/0/time", notes = "a history event whose time is an epoch number.")
r6 <- baseReq("fx-err-mL-per-h", rateUnits = "mL/h")
addError("err_unit_token_mL_h", r6, 422, "UNIT_UNKNOWN", "/pump/rateUnits", notes = "the message names the nearest accepted token (mL/hr).")
r7 <- baseReq("fx-err-micro-sign", history = list(list(time = atSec(0), bolus = 20, units = "µg")), nowSec = 10)
addError("err_unit_micro_sign", r7, 422, "UNIT_UNKNOWN", "/history/0/units", notes = "bolus units written with U+00B5 MICRO SIGN; the nearest token named is mcg.")
r8 <- baseReq("fx-err-wrong-conc-scale"); r8$target$units <- "ng/mL"
addError("err_wrong_concentration_scale", r8, 422, "UNIT_MISMATCH", "/target/units", notes = "ng/mL is a valid token but propofol is measured in mcg/mL.")
r9 <- baseReq("fx-err-latency-ge-interval", latency = 10, interval = 10)
addError("err_latency_ge_interval", r9, 422, "LATENCY_INVALID", "/timing/latency")
r10 <- baseReq("fx-err-two-rate-changes", nowSec = 20, history = list(list(time = atSec(0), rate = 100, units = "mL/hr"), list(time = atSec(0), rate = 200, units = "mL/hr")))
addError("err_two_rate_changes_same_instant", r10, 422, "HISTORY_INVALID", "/history/1")
r11 <- baseReq("fx-err-future-event", nowSec = 0, history = list(list(time = atSec(5), rate = 100, units = "mL/hr")))
addError("err_event_5s_in_future", r11, 422, "HISTORY_IN_FUTURE", "/history/0/time", notes = "5 s after now is beyond the 2 s clock-skew clamp.")
dupText <- paste0('{"requestId":"fx-err-duplicate-key","drug":"propofol","now":"', START_TEXT, '",',
                  '"patient":{"weight":70,"height":170,"age":50,"sex":"male"},"infusate":{"concentration":10,"units":"mg/mL"},',
                  '"pump":{"rateUnits":"mL/hr","maxRate":1200,"maxRate":1200},',
                  '"target":{"site":"effect","value":3,"units":"mcg/mL"},"timing":{"latency":1.5,"interval":10},"history":[]}')
r12 <- jsonlite::fromJSON(dupText, simplifyVector = FALSE)
addError("err_duplicate_json_key", r12, 400, "DUPLICATE_KEY", "/pump/maxRate", requestText = dupText,
         notes = "The body must be fed to the parser as TEXT (requestText): JSON cannot carry a duplicate key in a parsed object, so `request` is null here.  A port must detect the duplicate while parsing (jsonlite keeps both keys; the server walks the parsed list).")
r13 <- baseReq("fx-err-unknown-field"); r13$foo <- 1
addError("err_unknown_field", r13, 400, "UNKNOWN_FIELD", "/foo")

writeJSON(list(
  generatedAt = GENERATED_AT, stanpumpRCommit = COMMIT, stanpumpRVersion = VERSION, rVersion = R.version.string,
  notes = paste(
    "Each case: `response` is exactly what tciNextRate(request, receivedAt = <request now + 0.2 s>) returned, serialized with",
    "jsonlite::toJSON(auto_unbox = TRUE, digits = NA, null = 'null'), i.e. the body the Plumber router would send.",
    "`server.*` (package, version, commit, receivedAt, respondedAt, computeSeconds) is the generator's own clock and MUST NOT",
    "be compared.  `warnings` at the case level lists the response's warning codes for convenience.  All request numbers are",
    "stored with 15 significant digits and were fed to R exactly as stored (computed quantities were rounded to 15 digits",
    "before the call), so a port can replay `request` verbatim.  Error cases: `status`, `code`, `pointer`, `message` are the",
    "tci_api_error condition's fields; the HTTP body would be {apiVersion, requestId, errors: [{code, message, pointer}], server}.",
    "Base pump for every success case unless its request says otherwise: mL/hr, maxRate 1200, minRate 0.1, rateResolution 0.1,",
    "latency 1.5 s, interval 10 s; propofol 10 mg/mL to 3 mcg/mL effect, remifentanil 50 mcg/mL to 4 ng/mL effect; 70 kg 170 cm",
    "50 y male.  The START of every clock is 2026-10-11T14:00:00.000Z."),
  cases = cases, errors = errors), "rate-cases.json")

# ---------------------------------------------------------------------------
# 4. closed-loop.json

message("closed-loop.json ...")
traceOut <- function(name, notes, L, spec) {
  list(name = name, notes = notes, spec = spec, drug = L$drug,
       steps = L$steps, finalHistory = L$finalHistory,
       maxTrueCe = L$maxTrueCe, maxTrueCeAt = atSec(L$maxTrueCeAtSeconds), maxTrueCeAtSeconds = L$maxTrueCeAtSeconds,
       finalTrueState = L$finalTrueState, finalResponseStateNow = L$finalResponseStateNow,
       finalStateRelativeDifference = L$finalStateRelativeDifference,
       model = L$responses[[1]]$model)
}
traces <- list()
spec1 <- list(drug = "propofol", target = 3, site = "effect", infusate = list(concentration = 10, units = "mg/mL"),
              rateUnits = "mL/hr", maxRate = 1200, minRate = 0.1, rateResolution = 0.1, latency = 1.5, actualLatency = 1.5,
              interval = 10, minutes = 30, patient = covariatesOf(P70))
message("  trace 1"); L <- runLoop("propofol", minutes = 30, idPrefix = "cl1")
traces[[1]] <- traceOut("1_propofol_3_cap1200", "Propofol 3 mcg/mL effect, 1% syringe, 1200 mL/hr cap, latency 1.5 s (actual 1.5), interval 10 s, 30 min.", L, spec1)
message("  trace 2"); L <- runLoop("propofol", minutes = 30, targetSteps = list(list(min = 10, value = 4), list(min = 20, value = 2)), idPrefix = "cl2")
s2 <- spec1; s2$targetSteps <- list(list(minute = 10, value = 4), list(minute = 20, value = 2))
traces[[2]] <- traceOut("2_propofol_target_steps_4_at_10min_2_at_20min", "As trace 1 with the target stepped to 4 at 10 min and to 2 at 20 min (the request formed at those minutes carries the new target).", L, s2)
message("  trace 3"); L <- runLoop("propofol", minutes = 30, handBoluses = list(list(min = 15, amount = 20, units = "mg")), idPrefix = "cl3")
s3 <- spec1; s3$handBoluses <- list(list(minute = 15, amount = 20, units = "mg"))
traces[[3]] <- traceOut("3_propofol_hand_bolus_20mg_at_15min", "As trace 1 with a 20 mg hand bolus at 15 min: added to the TRUE state and appended to the history ({bolus: 20, units: 'mg', source: 'manual'}) before the request formed at 15 min.", L, s3)
message("  trace 4"); L <- runLoop("remifentanil", minutes = 30, idPrefix = "cl4")
s4 <- spec1; s4$drug <- "remifentanil"; s4$target <- 4; s4$infusate <- list(concentration = 50, units = "mcg/mL")
traces[[4]] <- traceOut("4_remifentanil_4_cap1200", "Remifentanil 4 ng/mL effect, 50 mcg/mL, 1200 mL/hr cap, latency 1.5, interval 10, 30 min (TARGET_HIGH on every step: Upper is 2 ng/mL).", L, s4)
message("  trace 5"); L <- runLoop("propofol", minutes = 30, maxRate = 300, idPrefix = "cl5")
s5 <- spec1; s5$maxRate <- 300
traces[[5]] <- traceOut("5_propofol_cap300", "As trace 1 with maxRate 300 mL/hr: the loading dose spreads over several capped intervals.", L, s5)
message("  trace 6"); L <- runLoop("propofol", minutes = 30, latency = 1.5, actualLatency = 3.0, idPrefix = "cl6")
s6 <- spec1; s6$actualLatency <- 3.0
traces[[6]] <- traceOut("6_propofol_declared_latency_1.5_actual_3.0", "As trace 1 but the pump actually switches 3.0 s after each request while the request declares 1.5 s: the loading rate runs 1.5 s too long and the effect site overshoots (docs/tci-api.md section 5.5).", L, s6)

writeJSON(list(
  generatedAt = GENERATED_AT, stanpumpRCommit = COMMIT, stanpumpRVersion = VERSION, rVersion = R.version.string,
  start = START_TEXT,
  notes = paste(
    "Closed-loop traces from a standalone controller+pump simulator (runLoop() in generate.R, modelled on simulatePump() in",
    "tests/testthat/test-tci-api.R).  The controller sends a request every `interval` s at t = 0, 10, ..., minutes*60 INCLUSIVE",
    "(so a 30-min trace has 181 steps), each with the whole history; receivedAt = now + 0.2 s.  The simulated pump applies the",
    "commanded rate.value at now + actualLatency and appends {time, rate, units: 'mL/hr', source: 'tci'} to the history ONLY when",
    "the value differs from the rate already running (the value is first rounded to 15 significant digits, as the JSON carries",
    "it).  The TRUE state is the seven-amplitude closed-form recurrence p <- p e^{-l dt} + pinf R (1 - e^{-l dt}) (likewise e",
    "with the four effect-site eigenvalues) advanced at the rates actually run, with R = rate.value converted through the",
    "syringe (mL/hr * concentration / 60 = mass/min); a hand bolus adds pbolus*A, ebolus*A.  `trueCp`/`trueCe` are that state at",
    "`now` (before the request); `stateNow` is the server's reconstruction from the history, which should agree to rounding.",
    "`maxTrueCe` is the maximum of the true Ce sampled every 1 s (closed form within each constant-rate span) over the whole",
    "trace; `maxTrueCeAt` its time.  The fallback branch (run fallback.rate at holdUntil if no newer command) never fires in",
    "these traces because every response is accepted and actualLatency < interval; the hold started at the switch time ends",
    "exactly when the next command lands.  `finalHistory` is the history array sent with the last request.",
    "`finalStateRelativeDifference` compares the true state with the last response's state.now (a self-check, ~1e-13).",
    "Step fields: now (request), rate {value, units, ideal, limitedBy}, controller {plan, phase}, fallbackRate, timing (all",
    "fields), stateNow {cp, ce}, stateHoldUntil {cp, ce}, prediction {peakCe, peakAt, onTarget}, trueCp, trueCe, warnings,",
    "pumpSwitchesAt (now + actualLatency)."),
  traces = traces), "closed-loop.json")

# ---------------------------------------------------------------------------
# 5. Validation

message("validating ...")
report <- list()
for (f in c("models.json", "ke0-solve.json", "rate-cases.json", "closed-loop.json")) {
  x <- jsonlite::fromJSON(file.path(OUT, f), simplifyVector = FALSE)
  report[[f]] <- list(bytes = file.size(file.path(OUT, f)), parsed = TRUE)
}
rc <- jsonlite::fromJSON(file.path(OUT, "rate-cases.json"), simplifyVector = FALSE)
stripServer <- function(r) { r$server <- NULL; r }
numLeaves <- function(x) if (is.list(x)) unlist(lapply(x, numLeaves)) else if (is.numeric(x)) x else NULL
maxRel <- 0; nChecked <- 0
for (cs in rc$cases) {
  fresh <- stripServer(tciNextRate(cs$request, receivedAt = START + secOf(cs$request$now) + 0.2))
  stored <- stripServer(cs$response)
  a <- numLeaves(fresh); b <- numLeaves(stored)
  stopifnot(length(a) == length(b))
  rel <- abs(a - b) / pmax(abs(a), 1e-300)
  rel[a == 0 & b == 0] <- 0
  maxRel <- max(maxRel, rel)
  freshJ <- jsonlite::toJSON(fresh, auto_unbox = TRUE, digits = NA, null = "null")
  storedJ <- jsonlite::toJSON(stored, auto_unbox = TRUE, digits = NA, null = "null")
  if (!identical(as.character(freshJ), as.character(storedJ))) {
    # Compare structure (non-numeric leaves) exactly
    strA <- unlist(lapply(fresh, function(x) if (is.list(x)) unlist(x) else x)); strB <- unlist(lapply(stored, function(x) if (is.list(x)) unlist(x) else x))
    if (!identical(names(strA), names(strB))) stop("structure mismatch in ", cs$name)
  }
  nChecked <- nChecked + 1
}
message(sprintf("  %d success cases re-run from the stored JSON requests: max relative difference %.3g (floor set by 15-digit serialization)", nChecked, maxRel))
nErr <- 0
for (er in rc$errors) {
  req <- if (!is.null(er$requestText)) jsonlite::fromJSON(er$requestText, simplifyVector = FALSE) else er$request
  e <- tryCatch({ tciNextRate(req, receivedAt = START + 0.2); NULL }, tci_api_error = function(e) e)
  stopifnot(!is.null(e), e$code == er$code, e$status == er$status, identical(e$pointer, er$pointer))
  nErr <- nErr + 1
}
message(sprintf("  %d error cases re-run from the stored JSON: all codes, statuses and pointers match", nErr))
cl <- jsonlite::fromJSON(file.path(OUT, "closed-loop.json"), simplifyVector = FALSE)
for (tr in cl$traces)
  message(sprintf("  trace %s: %d steps, %d history events, max true Ce %.6f at %s, final state rel diff cp %.2e ce %.2e",
                  tr$name, length(tr$steps), length(tr$finalHistory), tr$maxTrueCe, tr$maxTrueCeAt,
                  tr$finalStateRelativeDifference$cp, tr$finalStateRelativeDifference$ce))
ke <- jsonlite::fromJSON(file.path(OUT, "ke0-solve.json"), simplifyVector = FALSE)
message(sprintf("  ke0: %d entries; pure-R Brent identical in %d; |ke0Exact rel diff| max %.3g",
                length(ke$entries), sum(vapply(ke$entries, function(e) isTRUE(e$pureRBrentIdentical), NA)),
                max(vapply(ke$entries, function(e) abs(e$ke0ExactRelativeDifference), 0))))
message(sprintf("  models: %d entries; rate cases: %d success + %d error; files: %s",
                length(jsonlite::fromJSON(file.path(OUT, "models.json"), simplifyVector = FALSE)$entries),
                length(rc$cases), length(rc$errors),
                paste(sprintf("%s=%d bytes", names(report), vapply(report, `[[`, 0, "bytes")), collapse = ", ")))
writeLines(jsonlite::toJSON(list(generatedAt = GENERATED_AT, commit = COMMIT, version = VERSION,
                                 successCases = length(rc$cases), errorCases = length(rc$errors),
                                 modelEntries = 16L, traces = length(cl$traces), maxRelativeReplayDifference = maxRel,
                                 files = report), auto_unbox = TRUE, digits = NA, pretty = TRUE),
           file.path(OUT, "manifest.json"))
message("done: ", OUT)
