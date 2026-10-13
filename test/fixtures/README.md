# FauxTCI golden fixtures (from stanpumpR)

Machine-readable, full-double-precision fixtures for validating a pure-JavaScript
port of the stanpumpR TCI API controller (`R/tci-api.R`, `R/tci.R`) and of the
propofol and remifentanil PK models (`R/drugs_propofol.R`, `R/drugs_remifentanil.R`,
`R/getDrugPK.R`, `R/cube.R`).  The API contract is `docs/tci-api.md` (version 1.0).

| Provenance | |
|---|---|
| stanpumpR commit | `740b5055f12c9616cac4fec869ab2b6d1b3b777a` (branch `master`) |
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
  Rscript /path/to/fauxtci-fixtures/generate.R [output-dir]
```

`output-dir` defaults to the directory `generate.R` lives in.  Set
`STANPUMPR_DIR` if the package root is not the working directory.  The run takes
about 20 s and ends with a validation pass (re-reads every JSON file, replays every
`rate-cases.json` request through `tciNextRate()` and compares with the stored
response, re-raises every error case, summarises the traces) and writes
`manifest.json`.  `tciNextRate()` is deterministic, so a regeneration differs only
in `generatedAt` and the `server.*` blocks.

## Files

### `models.json` (16 entries = 2 drugs x 8 patients)

Patients: {70 kg, 170 cm, 50 y, male}, {60, 165, 35, female}, {100, 180, 60, male}
(BMI 30.9: remifentanil's Kim 2017 branch), {120, 175, 45, female} (BMI 39.2: Kim),
{20, 110, 5, male}, {85, 175, 80, female}, {45, 160, 25, female}, {3.5, 50, 0, male}.
`adjustToFFM = true` throughout (both drugs ignore it).

Per entry: covariates, `bmi`, `branch` (`eleveld2018` / `eleveld2017` / `kim2017`),
`tPeak`, `reference`, `Concentration.Units` and the other library-row fields,
`drugFunction` (what the drug function itself returns: `PK.default` = raw v1, v2, v3,
cl1, cl2, cl3; neither drug exposes intermediate quantities such as FFM or the
maturation factors, so `intermediateNames` is empty), `pk` (the **complete** default
PK set from `getDrugPK()`: v1..cl3, k10, k12, k13, k21, k31, lambda_1..3, ke0, every
`p_coef_bolus_*`, `p_coef_infusion_*`, `e_coef_bolus_*`, `e_coef_infusion_*`, plus the
zero oral/IM/IN/SL/RA fields and `customFunction`), and `model` = the block
`tciApiModel()` returns verbatim, including `hash`.

`model.hash` = `md5:` + MD5 of the file written by
`writeLines(jsonlite::toJSON(parameters_rounded_to_signif_10, auto_unbox = TRUE, digits = NA))`
(so the hashed text ends with a newline; the parameter order is v1, v2, v3, cl1, cl2,
cl3, k10, k12, k13, k21, k31, lambda_1, lambda_2, lambda_3, ke0).

### `ke0-solve.json`

`notes` documents the ke0 derivation precisely.  In short, for these IV drugs
`getDrugPK()` runs

```r
ke0 <- stats::optimize(tPeakError, c(0, 200), tPeak,
                       p_coef_bolus_l1, p_coef_bolus_l2, p_coef_bolus_l3,
                       lambda_1, lambda_2, lambda_3)$minimum
```

with the default `tol = .Machine$double.eps^0.25 = 2^-13 = 1.220703125e-4`
(absolute).  `tPeakError(ke0, ...)` builds the unit-bolus effect-site coefficients
`e_i = p_i * ke0 / (ke0 - lambda_i)`, `e_4 = -(e_1 + e_2 + e_3)`, finds the peak of
`CE(t) = sum e_i exp(-lambda_i t) + e_4 exp(-ke0 t)` with an **inner**
`stats::optimize(CE, c(0, 100), ..., maximum = TRUE)` (same default tol), and returns
`(tPeak - predPeak)^2`.  The plasma curve is the IV **bolus** response
`sum p_coef_bolus_li exp(-lambda_i t)`.  Both levels are R's `Brent_fmin`
(Netlib FMIN); the notes spell out the algorithm step by step, and a pure-R
transcription of it (`brentFmin()` in `generate.R`) reproduced all 16 ke0 values
**bit for bit** (`pureRBrentIdentical: true`).

Per entry: inputs (`p_coef_bolus`, `lambda`, `tPeak`), `ke0`, `objectiveAtKe0`,
`e_coef_bolus`, the round trip (`roundTrip.peakTimeInnerOptimize`: the inner
optimizer's peak time for that ke0; `roundTrip.peakTimeExact`: the true peak time from
a 1e-14 root of dCe/dt; Ce at the peak, whose reciprocal is `vdPeakEffect`),
`ke0Exact` (the ke0 whose exact peak time equals tPeak) with its relative difference
from R's value (max |3.4e-5| over the 16 entries), and `objectiveSamples`
(`tPeakError` and the inner `predPeak` at ke0 x {0.5, 0.8, 0.95, 1, 1.05, 1.25, 2})
for checking the objective function, inner optimizer included.

### `rate-cases.json` (49 success cases, 13 error cases)

Each success case: `name`, `drug`, `notes`, `warnings` (the codes, for convenience),
`request`, `response` (exactly `tciNextRate(request, receivedAt = now + 0.2 s)`).
**Do not compare `response.server.*`** (the generator's clock).  Every number in a
request is stored with 15 significant digits and was fed to R exactly as stored, so
`request` can be replayed verbatim; the replay check reproduced every stored
response to 4.6e-15 relative (the serialization floor).

Base pump unless the request says otherwise: `mL/hr`, maxRate 1200, minRate 0.1,
rateResolution 0.1, latency 1.5 s, interval 10 s; propofol 10 mg/mL to 3 mcg/mL
effect; remifentanil 50 mcg/mL to 4 ng/mL effect; 70 kg / 170 cm / 50 y / male.
Cases a-p and s-v exist for **both** drugs (suffix `_propofol` / `_remifentanil`):

* `a` empty history; `b` history exactly "1200 mL/hr for 10 s then 0", request at
  +15 s; `b2` the first request of the real 20-min closed loop whose phase is
  `waitingForPeak`; `c` the request formed at the 20-min mark of the closed loop
  (maintenance; its history is every rate change the pump recorded); `d` target
  lowered (3->2 / 4->2); `e` raised (3->4 / 4->6); `f` hand bolus 30 s ago (20 mg
  propofol; **50 mcg** remifentanil, a clinically sensible amount in place of the
  generic "20 mg"); `g` `pump.state: paused`, `currentRate: 0`; `h` the `c` history
  rewritten as an initial infusate event + delivered `mL` segments + the last rate
  change; `i` a 20-min loop with a syringe change at 10 min (10->20 mg/mL,
  50->100 mcg/mL); `j` minRate = 3 x the running maintenance rate; `k`
  rateResolution 1; `l` target 0; `m` plasma target from zero and `m2` plasma target
  at the `c` state; `n` lookAhead 1.0 + syringeVolumeRemaining 10 mL; `o`
  volumeInfused 10 % above the history (DELIVERY_MISMATCH); `p` currentRate = running
  + 5 (RATE_MISMATCH); `s` interval 30 s; `s2` interval 40 s; `t` latency 6 of 10
  (LATENCY_LONG); `u` target 2 x Upper (TARGET_HIGH); `v` mass-rate pump units
  (`mg/min` / `mcg/min`) with no infusate.
* `q` 100 kg remifentanil (Kim 2017), `r` 20 kg child on propofol, `x` the
  documented example body of `docs/tci-api.md` section 4.

Two deviations from the brief, both deliberate and noted in the cases: (1)
`INTERVAL_LONG` fires above `tPeak * 60 / 3 = 32 s` for both drugs (tPeak 1.6 min),
so the requested 30 s interval (`s`) does **not** warn; `s2` at 40 s does.
(2) Remifentanil's library `Upper` is 2 ng/mL, so the requested 4 ng/mL target itself
carries `TARGET_HIGH` on every remifentanil response (the `u` case uses 4 ng/mL = 2 x
Upper; `d` at 2 ng/mL is the only remifentanil success case without the warning).

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
parsing), unknown field (400 UNKNOWN_FIELD `/foo`).  The brief's list enumerates
13 items, so there are 13 cases rather than 12.

### `closed-loop.json` (6 traces x 181 steps)

A standalone controller + pump simulator (`runLoop()` in `generate.R`, modelled on
`simulatePump()` in `tests/testthat/test-tci-api.R`).  Requests go out every
`interval` s at t = 0, 10, ..., 1800 s **inclusive** (181 steps); the pump applies
`rate.value` at `now + actualLatency`, appends a rate change (`mL/hr`, `source: tci`)
only when the value differs from the rate already running, and the **true** state is
the seven-amplitude closed-form recurrence advanced at the rates actually run (with
Ce also sampled every second for `maxTrueCe`).  The fallback branch never fires
(every response accepted, actualLatency < interval).

Traces: (1) propofol 3 mcg/mL, 1200 cap, latency 1.5, interval 10, 30 min (max true
Ce 3.00358); (2) + target 4 at 10 min, 2 at 20 min (4.00423); (3) + 20 mg hand bolus at
15 min (3.88491, the bolus); (4) remifentanil 4 ng/mL, 50 mcg/mL (4.00126); (5) propofol
with maxRate 300 mL/hr, five capped intervals then a partial (3.00235); (6) propofol
declaring latency 1.5 s while the pump switches 3.0 s after the request (3.31612,
+10.5 %, the overshoot of `docs/tci-api.md` section 5.5 under a 1200 cap).

Per step: `now`, `rate` {value, units, ideal, limitedBy}, `controller` {plan, phase},
`fallbackRate`, `timing` (all six fields), `stateNow` {cp, ce}, `stateHoldUntil`
{cp, ce}, `prediction` {peakCe, peakAt, onTarget}, `trueCp`, `trueCe` (the recurrence
at `now`), `warnings`, `pumpSwitchesAt`.  Per trace: `finalHistory` (the history sent
with the last request), `maxTrueCe` / `maxTrueCeAt`, `finalTrueState` vs
`finalResponseStateNow` with their relative difference (~1e-14: the server's
superposition equals the recurrence), and the `model` block.

### `manifest.json`, `generate.R`

`manifest.json`: counts, sizes and the replay difference from the last run.
`generate.R`: the generator (see above).

## Tolerances a port should aim for

| What | Tolerance | Why |
|---|---|---|
| PK parameters, eigenvalues, every `p_coef_*` / `e_coef_*` with **R's ke0 injected** from `models.json` | 1e-10 relative | pure arithmetic; `cube()`'s trigonometric roots and the coefficient formulas are exact closed forms. (The JSON itself carries 15 digits, so ~1e-14 is the floor.) |
| ke0 from tPeak, same nested Brent fmin ported with tol 2^-13 at both levels | 1e-6 relative aimed; **bit-exact expected** when `exp()` agrees with R's libm. Hard bound 2.5e-4 relative | R's `Brent_fmin` was reproduced bit for bit in R; a last-ulp difference in `exp()` can flip a branch and move the result by up to the stopping width 2*(sqrt(eps)*ke0 + tol/3) ~ 8e-5 absolute (1.2e-4 relative at ke0 0.69, 2.5e-4 at ke0 0.33). |
| ke0 from tPeak with a **different** optimizer (exact root finder) | 5e-5 relative (observed max 3.4e-5, `ke0ExactRelativeDifference`) | R's value is not the exact root: the outer tolerance is absolute 1.2e-4 and the inner peak time is resolved only to ~4e-5 min. |
| `rate-cases.json` responses: rates (`rate.value`, `rate.ideal`, `rate.mlPerHour`, `rate.massPerMinute`, `fallback.rate`, `segment.*`), concentrations (`state.*`, `prediction.peakCe`, `prediction.deviation`, `delivered.*`, `lookAhead.decrementSeconds`) | 1e-8 relative, with R's ke0 injected | the effect-site search takes a minimum over a 1 s grid, so the result is a smooth function of the state; 1e-8 leaves room for `exp()`/`expm1()` differences accumulated over a 100-event superposition. Rounded rates (`rateResolution`) should match exactly; `limitedBy`, `controller`, timing strings, warning codes and `onTarget` exactly. `targetReachedAt`, `peakAt`, `nextRequestAt`, `syringeEmptyAt` are on 1 s / 1 ms grids: compare the strings, allowing a 1 ms slip only where a value sits on a rounding boundary. |
| `closed-loop.json` true Ce (`trueCe`, `maxTrueCe`) and `stateNow` | 1e-6 relative | the loop compounds 181 plans, each rounded down to 0.1 mL/hr. If a port's ideal rate differs from R's by an ulp exactly at a rounding boundary, one command differs by 0.1 mL/hr and the traces diverge from that step; that is unlikely, but if it happens note the step and compare from the following step on. Timing strings, phases, `limitedBy` and warning codes exactly. |
| `server.*` | not compared | the generator's clock |

Within these files, 15 significant digits are stored; treat ~1e-14 relative as the
floor of any comparison.
