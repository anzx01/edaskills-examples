---
name: mlcc-dc-bias-derating
description: "Offline MLCC DC-bias derating screening from user-supplied vendor curve CSVs (Murata SimSurfing export layout): piecewise-linear interpolation of the DC-bias capacitance curve, optional temperature-characteristic curve combined multiplicatively as a documented separable approximation, then effective capacitance at the operating bias/temperature, retention versus nominal, required nominal capacitance and parallel part count for a target effective capacitance; out-of-curve bias or temperature and missing columns are explicit errors with no extrapolation, synthetic teaching fixtures ship in-bundle while real vendor CSVs are passed by the user; known-answer self-tests every run, derating.json + derating.csv artifacts."
license: MIT
---

# MLCC DC-bias derating

A 10 µF Class-II MLCC is only "10 µF" at zero bias, small signal, 25 °C.
Put 5 V across an 0402 X5R and you may be holding less than half of it.
This bundle turns the vendor's own published curves into the number that
matters — the effective capacitance at your operating point — entirely
offline in Node >= 20 with zero dependencies. The interpolation math is
an independent rewrite of public engineering practice; no upstream code,
notebooks or vendor data are vendored (references/PROVENANCE.md).

## What it consumes

- **DC-bias curve CSV (required, user-supplied)** in the Murata
  SimSurfing export layout: `#` comment lines (one declares the curve
  temperature, e.g. `#capacitance  25.0degC  AC0.01Vrms`), then the
  header `DC Bias[V],Capacitance[F],` and numeric rows. Export it
  yourself from SimSurfing (or an equivalent vendor tool) for the exact
  part you plan to use. Trailing empty cells are tolerated.
- **Temperature-characteristic CSV (optional)** with header
  `Temperature[degC],Capacitance change rate[%],`. When present, the
  capacitance change rate is interpolated at the operating temperature
  and applied multiplicatively.
- Operating point and goal: `biasV`, `temperatureC`, `nominalCapF`
  (datasheet nominal, farads), `targetEffectiveF` (what the rail actually
  needs, farads).

The bundled fixtures are **hand-constructed synthetic teaching curves**,
not Murata measurements. They exist so the demo and self-tests run
out-of-the-box; real screening always uses your own vendor CSV.

## What the script computes

`scripts/demo.mjs` (single self-contained file):

- **C(V)**: piecewise-linear interpolation on the bias curve. Bias
  outside `[Vmin, Vmax]` is an explicit `BIAS_OUT_OF_RANGE` error — the
  tool never extrapolates a curve into a region the vendor never swept.
  A negative operating bias maps to `|V|` (Class-II loss follows field
  magnitude; vendor curves are swept positive), reported as an info item.
- **k(T)**: with a temperature curve, `k = 1 + rate(T)/100` interpolated
  linearly; outside its range → `TEMP_OUT_OF_RANGE` error. Without one,
  the operating temperature must match the bias curve's declared
  temperature within `options.tempToleranceC` (default 0.5 °C),
  otherwise `TEMP_OUT_OF_RANGE` — no silent temperature guessing.
- **Ceff = C(V) · k(T)**. This separable (multiplicative) combination
  ignores bias × temperature coupling in real dielectrics; it is
  documented as an approximation, not a measured surface.
- **Retention**: `Ceff / nominalCapF`, plus the bias-only keep ratio
  `C(V)/C(0V)`. Below 50 % retention → `SEVERE_DERATING` warning (bigger
  package / higher voltage rating first, stacking parts second).
- **Sizing**: `requiredNominalF = target / retention` (same-family
  scaling assumption) and `parallelCount = ceil(target / Ceff)` of the
  characterized part.
- **Sanity**: curve zero-bias capacitance differing from the declared
  nominal by >20 % → `NOMINAL_MISMATCH` warning (wrong CSV or vendor
  small-signal measurement conditions).
- **Artifacts**: `derating.json` (raw SI values) and `derating.csv`
  (engineering-unit summary). 17 known-answer self-tests run on every
  invocation against closed-form anchors on the synthetic curves.

## Usage

```bash
node scripts/demo.mjs --out-dir out                        # default fixture
node scripts/demo.mjs --out-dir out --input my-part.json   # your vendor CSV
```

Input JSON: `biasCsv` (path) or `biasCsvText` (inline), optional `tempCsv`
/ `tempCsvText`, `biasV`, `temperatureC`, `nominalCapF`,
`targetEffectiveF`, optional `options.tempToleranceC`. Relative CSV paths
resolve against the input JSON's own directory (or `csvBaseDir`), so the
demo runs from any working directory, repo root included. Exit 0 on pass
/ pass_with_warnings, 1 on a failed verdict, 2 on usage error.

Fixtures: `scripts/fixtures/input.json` plus the synthetic curves in
`references/fixtures/synthetic-bias.csv` / `synthetic-temp.csv`
(the worked example), `fail-bias-range.json` (20 V beyond the 16 V curve
end), `fail-temp-uncovered.json` (85 °C with only a 25 °C curve),
`fail-missing-column.json` (capacitance column in µF instead of F).

## Worked example (hand-derived, pinned by self-tests)

Synthetic curve: 0 V→10 µF, 5 V→8 µF, 10 V→5 µF, 16 V→3 µF at 25 °C;
temperature rate −55 °C→−10 %, 25 °C→0 %, 85 °C→−15 %.
At 7.5 V / 55 °C: C = 6.5 µF (segment midpoint), rate = −7.5 % →
**Ceff = 6.0125 µF**, retention **60.125 %** of 10 µF nominal. For a
12 µF target: **2 parts in parallel** (12.025 µF) or a nominal of at
least **19.958 µF** at the same keep ratio.

## Honest limits

- Linear interpolation between vendor points is an approximation of a
  smooth curve; dense SimSurfing sweeps keep the error small, sparse
  curves do not.
- The separable bias × temperature model ignores dielectric coupling;
  for precision rails verify against the vendor's combined curves or
  measurement.
- Required-nominal scaling assumes the same dielectric/package/voltage
  family keeps the same retention ratio — a screening estimate, not a
  guarantee for a different part.
- Aging, AC-ripple amplitude and frequency dependence are out of scope;
  this screens DC bias and temperature only.