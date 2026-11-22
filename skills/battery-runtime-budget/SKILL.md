---
name: battery-runtime-budget
description: "Offline battery runtime budgeting from a measured load profile: piecewise-constant duty-cycle integration, temperature/age capacity derating, optional Peukert correction for lead-acid, regulator efficiency chain with quiescent current, reserve margin, and a brownout check against a piecewise-linear discharge curve with internal-resistance droop; known-answer self-tests, runtime JSON + worst-case segment CSV."
license: MIT
---

# Battery runtime budget

Nameplate capacity is not a runtime guarantee. This bundle integrates a
real duty-cycle load profile into a runtime estimate with explicit
derating, regulator losses, reserve margin and a pulse/brownout screen —
entirely offline in Node >= 20 with zero dependencies. Domain procedures
were inspired by an unlicensed upstream skill; every line of math and
prose here is an independent implementation (references/PROVENANCE.md).

## What the script computes

`scripts/demo.mjs` (single self-contained file):

- **Load-profile integration**: piecewise-constant current segments over
  one duty cycle. Each segment's load-side current is reflected to the
  battery bus by power conservation: `I_bat = I_load·V_rail /
  (η_chain·V_pack_nominal) + Σ I_quiescent`. Per-cycle mAh and consumed
  fraction are summed; runtime = cycles-to-empty × cycle period. With
  k=1 this reduces exactly to usable-capacity / average-current.
- **Capacity derating**: chemistry-specific piecewise-linear
  capacity-vs-temperature screening tables (li-ion, LiFePO4, NiMH,
  lead-acid; clamped with an explicit `TEMP_EXTRAPOLATION` warning
  outside −20…60 °C), an age/cycle factor in (0, 1], and a reserve
  margin. An explicit `temperatureFactor` override is accepted.
- **Peukert (lead-acid only)**: `C_eff(I) = C·(I_r/I)^(k−1)` with
  `I_r = C/H_rated`, applied per segment current; k=1 reproduces the
  ideal case. Exponents on other chemistries are ignored with an info
  item, never silently applied.
- **Regulator chain**: series product of efficiencies plus summed
  quiescent current; pack topology (series cells raise voltage and
  resistance, parallel strings raise capacity and lower resistance).
- **Brownout check**: piecewise-linear open-circuit curve through
  (100 %, V_full), (50 %, V_nominal), (0 %, V_cutoff); terminal voltage
  `V_oc(SoC) − I·R_pack` for the worst segment is scanned against the
  system minimum input. Crossing before the reserve SoC is a
  `BROWNOUT_RISK` error; droop below minimum even at full charge is a
  `PULSE_DROOP` warning. This is a curve approximation, not a cell model.
- **Worst-case segment table**: per-segment battery current, duty %,
  mAh/cycle, Peukert effective capacity and continuous-only runtime.

Artifacts in `--out-dir`: `runtime.json`, `segments.csv`.

**Known-answer self-tests run on every invocation** (12 cases):
1000 mAh @ 100 mA constant = exactly 10 h ideal; derated case
(0 °C factor 0.8 × age 0.9 × 80 % usable, η 0.9) = exactly 5.184 h;
lead-acid 7 Ah, k=1.2, 700 mA = 20·(350/700)^1.2 = 8.7055 h; two-segment
50/150 mA duty cycle averages to 10 h; 2P doubles runtime; negative
current, zero capacity, zero efficiency and empty profile raise specific
error codes; a 0.5 Ω pack at 1 A must flag `BROWNOUT_RISK` at SoC ≈ 42.9 %
(hand-solved); −30 °C warns and clamps; Peukert-on-li-ion is ignored.
Any regression exits fail.

## Run

```bash
node scripts/demo.mjs --out-dir <dir> [--input <json>]
```

Default input `scripts/fixtures/input.json` is a 2000 mAh li-ion IoT node
(sleep/sample/TX cycle, 3.3 V buck, 20 % reserve). stdout is exactly one
`edaskills.report.v1` report; exit 1 iff verdict fail, 2 on usage error.

## When to use

- Sizing a battery from a scope/current-probe load profile instead of a
  single "average current" guess.
- Comparing chemistries, temperatures, age states or reserve policies
  with the same profile, reproducibly.
- Screening pulse brownout risk before committing to a cell or pack.

Differentiation from sibling bundles: `lceda-calc-toolbox-core` only has
the one-line `h = capacity×efficiency/load` estimate; this bundle adds
duty-cycle integration, temperature/age derating, Peukert, quiescent
current, reserve margin and brownout screening. Rail impedance and
decoupling belong to `lceda-pdn-decoupling-core`, not here.

## Not for

- Not a cell electrochemistry model: the discharge curve and temperature
  tables are screening approximations, not vendor data; validate with a
  real discharge test at load and temperature.
- Not a charger/BMS/protection design or safety/transport compliance
  tool; high-energy packs need qualified pack-vendor review.
- Not a pulse-capability proof: average-current budgeting cannot replace
  a dedicated pulse droop/recovery measurement.