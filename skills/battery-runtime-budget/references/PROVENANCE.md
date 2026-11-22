# Provenance

## Inspiration source

- Repository: https://github.com/roman01la/embedded-electronics-skills
- Commit inspected: b52d6185d6f82f38152064c1ba3d437ec7e89ced (2026-09-06)
- Skills read for domain procedures only: `battery-pack-and-runtime-planner`,
  `power-tree-pdn-reviewer`, `load-driver-thermal-safety`.
- **No license upstream** (no LICENSE file and no license declaration in
  the repository). Therefore **no code or text was copied**. What was
  taken is the uncopyrightable idea of *which checks an engineer
  performs* (load-state modeling, explicit derating factors with cited
  sources, converter efficiency and quiescent current, UVLO fit against
  discharge curves, pulse droop as a separate claim). Every formula,
  algorithm, fixture, comment and document in this bundle is an
  **independent implementation of standard engineering mathematics**,
  written for this repository and licensed MIT.

## Standard formulas implemented (textbook-level citations)

- Duty-cycle average current and charge integration over piecewise-
  constant segments: standard embedded power-budgeting practice
  (Twomey, *Embedded Systems Design*; White, *Making Embedded Systems*).
- Power-conserving load reflection through a converter chain
  `I_bat = P_load/(η·V_bat) + I_q`: standard power-electronics relation
  (Erickson & Maksimović, *Fundamentals of Power Electronics*).
- Peukert's law `I^k·t = const`, expressed as effective capacity
  `C_eff(I) = C·(I_r/I)^(k−1)` with `I_r = C/H_rated`: W. Peukert (1897);
  modern treatment in Linden & Reddy, *Handbook of Batteries*.
- Series/parallel pack scaling of voltage, capacity and internal
  resistance: Linden & Reddy, *Handbook of Batteries*.
- Terminal voltage `V_oc(SoC) − I·R_internal` and UVLO/brownout
  screening: standard battery equivalent-circuit first order
  (Linden & Reddy; Erickson & Maksimović).

## House approximations (declared, not vendor data)

- Capacity-vs-temperature tables per chemistry are piecewise-linear
  screening curves authored for this bundle (li-ion 0.8 at 0 °C, 0.6 at
  −20 °C, etc.); they are order-of-magnitude planning factors, not
  measured cell data, and are clamped with an explicit warning outside
  −20…60 °C.
- The open-circuit discharge curve is a three-point piecewise-linear
  approximation (full/nominal/cutoff at SoC 1/0.5/0); real chemistries
  have plateaus this model does not reproduce.
- Per-segment Peukert application is a conservative engineering
  approximation of a varying-load discharge.

## House additions

- `scripts/demo.mjs`: single self-contained Node >= 20 core, zero npm
  dependencies, offline only; 12 known-answer self-tests executed on
  every run; `edaskills.report.v1` contract report.
- `scripts/fixtures/input.json`: synthetic 2000 mAh li-ion IoT load
  profile authored for this bundle.
- `references/procedures.md`: capture-to-budget engineering flow,
  written here.
- `assets/icon.png`: generated for this library; upstream ships none.