# FauxTCI golden fixtures (from stanpumpR)

Machine-readable, full-double-precision fixtures for validating a pure-JavaScript
port of the stanpumpR TCI API controller (`R/tci-api.R`, `R/tci.R`) and of the
propofol, remifentanil, sufentanil and remimazolam PK models
(`R/drugs_propofol.R`, `R/drugs_remifentanil.R`, `R/drugs_sufentanil.R`,
`R/drugs_remimazolam.R`, `R/pkSizeFactors.R`, `R/getDrugPK.R`, `R/cube.R`).  The API
contract is `docs/tci-api.md` (version 1.0).

| Provenance | |
|---|---|
| stanpumpR commit | `d99231c6aebf09d8a6d0352e188f32d4dc4ed6bc`: master of 2026-11-18 (`8b2283a`) plus remimazolam's target units (StevenLShafer/stanpumpR#768) |
| stanpumpR version | 0.0.1.9002 (`DESCRIPTION`) |
| R | 4.3.3 (2024-02-29), Linux x86_64; jsonlite 1.8.8 |
| Serialization | `jsonlite::toJSON(x, auto_unbox = TRUE, digits = NA, null = "null", pretty = TRUE)` (15 significant digits, scalars unboxed, `null` for R `NULL`) -- the same call the Plumber router uses |
| Clock | every request clock starts at `2026-10-11T14:00:00.000Z`; `receivedAt` passed to `tciNextRate()` is always the request's `now` + 0.2 s |

Nothing in the stanpumpR checkout was modified; the fixtures were produced with
`devtools::load_all(".")` so that internal functions were callable.

## Regenerating

```sh
cd /path/to/stanpumpR
LC_ALL=C.UTF-8 NOT_CRAN=true RENV_CONFIG_AUTOLOADER_ENABLED=FALSE \
  Rscript /path/to/FauxTCI/test/fixtures/generate.R [output-dir]
```

`output-dir` defaults to the directory `generate.R` lives in.  Set
`STANPUMPR_DIR` if the package root is not the working directory.  The run takes
about 40 s and ends with a validation pass (re-reads every JSON file, replays every
`rate-cases.json` request through `tciNextRate()` and compares with the stored
response, re-raises every error case, checks that every ke0 re-solve is identical to
`getDrugPK()`'s, summarises the traces) and writes `manifest.json`.
`tciNextRate()` is deterministic, so a regeneration differs only in `generatedAt` and
the `server.*` blocks.  When the commit changes, also refresh
`STANPUMPR_LIBRARY_DRUGS` and `STANPUMPR_TCI_DRUGS` in `js/tci.js`
(`getDrugDefaultsGlobal()$Drug` and `tciApiDrugNames()`).

The per-drug choices of the cases (syringe, default target, hand bolus, the lowered
and raised targets) are the table `DRUG_SPECS` at the top of `generate.R`.

## Files

### `models.json` (48 entries)

Patients: {70 kg, 170 cm, 50 y, male}, {60, 165, 35, female}, {100, 180, 60, male}
(BMI 30.9: remifentanil's Kim 2017 branch), {120, 175, 45, female} (BMI 39.2: Kim),
{20, 110, 5, male}, {85, 175, 80, female}, {45, 160, 25, female}, {3.5, 50, 0, male}.
Propofol and remifentanil once per patient at `adjustToFFM = true` (both ignore it:
each carries its own fat-free mass); sufentanil and remimazolam at `adjustToFFM`
true **and** false (8 x 1 x 2 + 8 x 2 x 2 = 48).

Per entry: covariates, `adjustToFFM`, `bmi`, `branch` (`eleveld2018`, `eleveld2017` /
`kim2017`, `gepts1995`, `eleveld2025`), `tPeak`, `reference`, `Concentration.Units`
and the other library-row fields, `drugFunction` (what the drug function itself
returns: `PK.default` = raw v1, v2, v3, cl1, cl2, cl3; `ke0` for remimazolam, which
supplies it; and for the two scaled drugs `size`, `pkSizeFactors()` as the drug
function calls it: volume and clearance factors, `ffm`, `ffmReference`,
`pkWeight`), `pk` (the **complete** default PK set from `getDrugPK()`: v1..cl3, k10,
k12, k13, k21, k31, lambda_1..3, ke0, every `p_coef_bolus_*`, `p_coef_infusion_*`,
`e_coef_bolus_*`, `e_coef_infusion_*`, plus the zero oral/IM/IN/SL/RA fields), and
`model` = the block `tciApiModel()` returns verbatim, including `hash`.

Remifentanil uses Kim 2017 at a BMI of 30 or more from the age of 18
(`REMIFENTANIL_KIM_MIN_AGE`) unless Kim's model gives a non-positive parameter for the
patient, when Eleveld 2017 is used and the citation says why; Eleveld 2017 otherwise.
Sufentanil (Gepts 1995's 70 kg parameters) and remimazolam (Eleveld 2025) scale with
`pkSizeFactors()`: volumes by the patient's Al-Sallami fat-free mass over the 70 kg,
170 cm, 35-year-old reference man's, clearances by that ratio ^ 0.75; with
`adjustToFFM = false` sufentanil is unscaled and remimazolam takes weight / 70 and
(weight / 70)^0.75.

`model.hash` = `md5:` + MD5 of the file written by
`writeLines(jsonlite::toJSON(parameters_rounded_to_signif_10, auto_unbox = TRUE, digits = NA))`
(so the hashed text ends with a newline; the parameter order is v1, v2, v3, cl1, cl2,
cl3, k10, k12, k13, k21, k31, lambda_1, lambda_2, lambda_3, ke0).

### `ke0-solve.json` (48 entries, one per `models.json` entry)

`notes` documents the derivation precisely.  There are two cases (`solve`).

**`ke0FromTPeak`** (propofol, remifentanil and sufentanil: the drug function gives
tPeak).  `getDrugPK()` runs `ke0FromTPeakBolus(tPeak, p_coef_bolus, lambda)`:

```r
peakAt <- function(ke0) effectSitePeakTime(coef, lambda, ke0)
lo <- 1e-3; hi <- 1
while (peakAt(lo) < tPeak && lo > KE0_SOLVE_MIN) lo <- lo / 10   # 1e-12
while (peakAt(hi) > tPeak && hi < KE0_SOLVE_MAX) hi <- hi * 10   # 1e6
if (peakAt(lo) < tPeak) return(lo)
if (peakAt(hi) > tPeak) return(hi)
stats::uniroot(function(ke0) peakAt(ke0) - tPeak, c(lo, hi), tol = .Machine$double.eps^0.5)$root
```

and then `ke0 <- separateEigenvalues(ke0, lambda)` (a relative 1e-8 nudge only on a tie
within 1e-10; it never fires here).  `bracket` records lo, hi and `peakAt` there,
`ke0BeforeSeparation` the root, `ke0` the final value.  `ke0Exact` is the ke0 whose
exact peak time (a 1e-14 root of dCe/dt) equals tPeak; the library's differs from it
by at most 2.4e-5 relative (`ke0ExactRelativeDifference`), because the peak time it
solves against is itself an `optimize()` at tol 2^-13.

**`tPeakFromKe0`** (remimazolam: the drug function gives ke0 = exp(-1.20976) =
0.2983 /min, the published MOAA/S equilibration, and no tPeak).  ke0 is the model's
(`modelKe0`, then `separateEigenvalues()`) and tPeak is
`effectSitePeakTime(p_coef_bolus, lambda, ke0)` (`tPeakResolved`; about 2.38 min for
the reference adult).

`effectSitePeakTime(coef, lambda, ke0)` keeps the positive lambdas, computes
`e = coef * ke0 / (ke0 - lambda)` (in that order, unlike `getDrugPK()`'s
`p / (ke0 - l) * ke0`), and maximises `sum(e * exp(-lambda t)) - sum(e) exp(-ke0 t)`
with `stats::optimize(..., c(0, min(4000, 20 / min(c(lambda, ke0)))), maximum = TRUE)`
(R's `Brent_fmin`, tol 2^-13).  **R's `sum()` accumulates in long double** (the x87
80-bit format on x86-64), which matters near t = 0 where the terms nearly cancel; a
port should emulate it (FauxTCI's `sumR()` carries the sum exactly and rounds to a
64-bit significand after each term).  `uniroot()` is R's `R_zeroin2()`
(`src/library/stats/src/zeroin.c`), given f at both ends first.

Every entry also has `e_coef_bolus` at `ke0`, `roundTrip` (`window`, the search's
upper end; `peakTime`, `effectSitePeakTime()` at `ke0`; `ceAtPeak`, the unit-bolus Ce
there, whose reciprocal is `vdPeakEffect`) and `peakSamples` (`effectSitePeakTime()`
and its window at ke0 x {0.5, 0.8, 0.95, 1, 1.05, 1.25, 2}).

This replaced, on 2026-10-17 (stanpumpR `f5b2f0f`), the nested `optimize()` of
`tPeakError()` over ke0 in [0, 200] that the first FauxTCI fixtures (stanpumpR
`7d2d2f1`) documented; propofol's ke0 for the reference adult moved from 0.687118 to
0.687096 /min with it, and its loading rate from 1702.21 to 1702.23 mL/hr.

### `rate-cases.json` (99 success cases, 13 error cases)

Each success case: `name`, `drug`, `notes`, `warnings` (the codes, for convenience),
`request`, `response` (exactly `tciNextRate(request, receivedAt = now + 0.2 s)`).
**Do not compare `response.server.*`** (the generator's clock).  Every number in a
request is stored with 15 significant digits and was fed to R exactly as stored, so
`request` can be replayed verbatim; the replay check reproduced every stored
response to 4.9e-15 relative (the serialization floor).

Base pump unless the request says otherwise: `mL/hr`, maxRate 1200, minRate 0.1,
rateResolution 0.1, latency 1.5 s, interval 10 s; 70 kg / 170 cm / 50 y / male;
effect-site targets of propofol 3 mcg/mL from 10 mg/mL, remifentanil 4 ng/mL from
50 mcg/mL, sufentanil 0.1 ng/mL from 5 mcg/mL, remimazolam 0.5 mcg/mL from 2.5 mg/mL
(Byfavo's reconstituted concentration).  Cases a-p and s-v exist for **every** drug
(suffix `_<drug>`):

* `a` empty history; `b` history exactly "1200 mL/hr for 10 s then 0", request at
  +15 s; `b2` the first request of the real 20-min closed loop whose phase is
  `waitingForPeak`; `c` the request formed at the 20-min mark of the closed loop
  (maintenance; its history is every rate change the pump recorded); `d` target
  lowered (3->2, 4->2, 0.1->0.05, 0.5->0.3); `e` raised (3->4, 4->6, 0.1->0.2,
  0.5->1); `f` hand bolus 30 s ago (20 mg, 50 mcg, 10 mcg, 5 mg); `g`
  `pump.state: paused`, `currentRate: 0`; `h` the `c` history rewritten as an initial
  infusate event + delivered `mL` segments + the last rate change; `i` a 20-min loop
  with the syringe doubled at 10 min; `j` minRate = 3 x the running maintenance rate;
  `k` rateResolution 1; `l` target 0; `m` plasma target from zero and `m2` plasma
  target at the `c` state; `n` lookAhead 1.0 + syringeVolumeRemaining 10 mL; `o`
  volumeInfused 10 % above the history (DELIVERY_MISMATCH); `p` currentRate = running
  + 5 (RATE_MISMATCH); `s` interval 30 s; `s2` interval 40 s; `t` latency 6 of 10
  (LATENCY_LONG); `u` target 2 x Upper (TARGET_HIGH); `v` mass-rate pump units
  (`mg/min` / `mcg/min`) with no infusate.
* `w` and `w2`, for sufentanil and remimazolam only: the 120 kg, 175 cm, 45 y woman
  with `options.adjustToFFM: false` (the legacy size factors) and without options
  (fat-free mass).
* `q` 100 kg remifentanil (Kim 2017), `r` 20 kg child on propofol, `x` the
  documented example body of `docs/tci-api.md` section 4.

`INTERVAL_LONG` fires above `tPeak * 60 / 3` s: 32 s for propofol and remifentanil
(tPeak 1.6 min), 47.6 s for remimazolam (2.38 min) and 112 s for sufentanil (5.6
min), beyond the 60 s maximum interval.  So `s` (30 s) never warns, and `s2` (40 s)
warns, and is named `s2_interval_40s_INTERVAL_LONG_<drug>`, only for propofol and
remifentanil.  Remifentanil's library `Upper` is 2 ng/mL, so its 4 ng/mL default
target carries `TARGET_HIGH` on every remifentanil response but `d`.

Error cases (`errors[]`: `name`, `request`, `requestText`, `status`, `code`,
`pointer`, `message`, `requestId`): unknown drug (404 UNKNOWN_DRUG), non-TCI drug
midazolam (422 DRUG_NOT_TCI), missing `now` (400 MISSING_FIELD), numeric `now` (400
INVALID_TYPE), epoch-number history time (400 INVALID_TYPE `/history/0/time`),
`mL/h` (422 UNIT_UNKNOWN), `µg` with U+00B5 (422 UNIT_UNKNOWN, nearest token `mcg`),
`ng/mL` for propofol (422 UNIT_MISMATCH), latency = interval (422 LATENCY_INVALID),
two rate changes at one instant (422 HISTORY_INVALID `/history/1`), event 5 s in the
future (422 HISTORY_IN_FUTURE), duplicate JSON key (400 DUPLICATE_KEY
`/pump/maxRate`; **`request` is null and the body is in `requestText`**, since a
parsed JSON object cannot hold a duplicate key -- the port must detect it while
parsing), unknown field (400 UNKNOWN_FIELD `/foo`).

### `closed-loop.json` (8 traces x 181 steps)

A standalone controller + pump simulator (`runLoop()` in `generate.R`, modelled on
`simulatePump()` in `tests/testthat/test-tci-api.R`).  Requests go out every
`interval` s at t = 0, 10, ..., 1800 s **inclusive** (181 steps); the pump applies
`rate.value` at `now + actualLatency`, appends a rate change (`mL/hr`, `source: tci`)
only when the value differs from the rate already running, and the **true** state is
the seven-amplitude closed-form recurrence advanced at the rates actually run (with
Ce also sampled every second for `maxTrueCe`).  The fallback branch never fires
(every response accepted, actualLatency < interval).

Traces (max true Ce in brackets): (1) propofol 3 mcg/mL, 1200 cap, latency 1.5,
interval 10, 30 min (3.00353); (2) + target 4 at 10 min, 2 at 20 min (4.00421); (3) +
20 mg hand bolus at 15 min (3.88489, the bolus); (4) remifentanil 4 ng/mL, 50 mcg/mL
(4.00178); (5) propofol with maxRate 300 mL/hr, capped intervals then a partial
(3.00231); (6) propofol declaring latency 1.5 s while the pump switches 3.0 s after
the request (3.31608, the overshoot of `docs/tci-api.md` section 5.5 under a 1200
cap); (7) sufentanil 0.1 ng/mL, 5 mcg/mL (0.099985: the slow effect site reaches the
target from below); (8) remimazolam 0.5 mcg/mL, 2.5 mg/mL, raised to 1 mcg/mL at
15 min (1.00040; `TARGET_HIGH` from then, Upper being 0.6).

Per step: `now`, `rate` {value, units, ideal, limitedBy}, `controller` {plan, phase},
`fallbackRate`, `timing` (all six fields), `stateNow` {cp, ce}, `stateHoldUntil`
{cp, ce}, `prediction` {peakCe, peakAt, onTarget}, `trueCp`, `trueCe` (the recurrence
at `now`), `warnings`, `pumpSwitchesAt`.  Per trace: `finalHistory` (the history sent
with the last request), `maxTrueCe` / `maxTrueCeAt`, `finalTrueState` vs
`finalResponseStateNow` with their relative difference (~1e-14: the server's
superposition equals the recurrence), and the `model` block.

### `manifest.json`, `generate.R`

`manifest.json`: commit, counts, sizes and the replay difference from the last run.
`generate.R`: the generator (see above).

## Tolerances a port should aim for

| What | Tolerance | Why |
|---|---|---|
| PK parameters, eigenvalues, every `p_coef_*` / `e_coef_*` with **R's ke0 injected** from `models.json` | 1e-10 relative | pure arithmetic; `cube()`'s trigonometric roots and the coefficient formulas are exact closed forms. (The JSON itself carries 15 digits, so ~1e-14 is the floor.) |
| The ke0 bracket | exact | decided by comparisons of peak times far from tPeak |
| ke0 from tPeak, and remimazolam's tPeak from ke0, ported as R computes them | 1e-9 relative (ke0), 1e-8 min (peak times) | not bit-exact: the covariate models' `exp()` and `pow()` differ from R's libm in the last bit, and a root search over an `optimize()` passes that on; FauxTCI agrees to 3e-11. A port with an exact root finder in place of R's should expect R's ke0 only to ~2.4e-5 (`ke0ExactRelativeDifference`). |
| `rate-cases.json` responses: rates (`rate.value`, `rate.ideal`, `rate.mlPerHour`, `rate.massPerMinute`, `fallback.rate`, `segment.*`), concentrations (`state.*`, `prediction.peakCe`, `prediction.deviation`, `delivered.*`, `lookAhead.decrementSeconds`) | 1e-8 relative, with R's ke0 injected | the effect-site search takes a minimum over a 1 s grid, so the result is a smooth function of the state; 1e-8 leaves room for `exp()`/`expm1()` differences accumulated over a 100-event superposition. Rounded rates (`rateResolution`) should match exactly; `limitedBy`, `controller`, timing strings, warning codes and `onTarget` exactly. `targetReachedAt`, `peakAt`, `nextRequestAt`, `syringeEmptyAt` are on 1 s / 1 ms grids: compare the strings, allowing a 1 ms slip only where a value sits on a rounding boundary. |
| `model.hash` | the procedure exactly, on R's parameters | the port's own hash equals R's only where its ke0 rounds to the same ten digits |
| `closed-loop.json` true Ce (`trueCe`, `maxTrueCe`) and `stateNow` | 1e-6 relative | the loop compounds 181 plans, each rounded down to 0.1 mL/hr. If a port's ideal rate differs from R's by an ulp exactly at a rounding boundary, one command differs by 0.1 mL/hr and the traces diverge from that step; that is unlikely, but if it happens note the step and compare from the following step on. Timing strings, phases, `limitedBy` and warning codes exactly. |
| `server.*` | not compared | the generator's clock |

Within these files, 15 significant digits are stored; treat ~1e-14 relative as the
floor of any comparison.
