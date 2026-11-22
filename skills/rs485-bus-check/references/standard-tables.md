# Standard tables and sourced constants — rs485-bus-check

Access date for every source below: **2026-11-22**. Sources:

- **[S272]** TI SLLA272D, "The RS-485 Design Guide" (rev. May 2021),
  https://www.ti.com/lit/an/slla272d/slla272d.pdf
- **[S070]** TI SLLA070D, "RS-422 and RS-485 Standards Overview and
  System Configurations" (rev. May 2010),
  https://www.ti.com/lit/an/slla070d/slla070d.pdf

Both PDFs were downloaded and read in full during development.
"Mandate" = a TIA/EIA-485-A requirement as reproduced in these public
TI references. "Guideline" = an industry-typical, configurable default
or a documented screening convention — never presented as a standard
requirement.

## Table 1 — Core electrical limits

| Constant | Value | Class | Source |
|---|---|---|---|
| Unit load resistance | 12000 ohm (1 UL) | Mandate | [S070] unit-load figure (1 mA at +12 V, 0.8 mA at -7 V); [S272] §8 "1 UL ~ 12 kohm" |
| Max bus unit loads | 32 UL | Mandate | [S272] §2 "up to 32 unit loads"; §8 |
| Receiver differential threshold | 200 mV | Mandate | [S272] §4 "receivers detect a differential input down to 200 mV"; [S070] receiver transition figure |
| Driver test load | 54 ohm (+50 pF) | Mandate | [S070] §2.2.4 Figure 14; [S272] §4 "minimum 1.5 V across a 54-ohm load" |
| Receiver common-mode range | -7 V .. +12 V | Mandate | [S272] §2; [S070] Figure 13 |
| Loaded differential output |VOD| | 1.5 .. 5 V | Mandate (context) | [S070] Figures 12/13 |
| Driver offset voltage VOC | -1 .. +3 V | Mandate (context) | [S070] Figure 12 |
| Allowed per-node UL fractions | 1, 1/2, 1/4, 1/8 | Mandate-derived | [S272] §8 (1/8 UL -> 256 transceivers) |

Hand-check (unit load): 12 V / 1 mA = 12000 ohm; 7 V / 0.8 mA =
8750 ohm <= 12000 ohm, so the 12 kohm model satisfies both boundary
points of the [S070] unit-load figure. 32 UL in parallel =
12000/32 = 375 ohm — exactly the common-mode test resistance in
[S070] Figure 13. ✓

Hand-check (driver test load): two 120 ohm terminations in parallel =
60 ohm; 60 || 375 = 51.72 ohm; the standard rounds the test circuit to
54 ohm ([S070] Fig 14), which this screen uses as the minimum. ✓

## Table 2 — Configurable industry-typical defaults (guidelines)

| Default | Value | Class | Source / rationale |
|---|---|---|---|
| Cable Z0 | 120 ohm | Guideline (typical) | [S272] §5: 22-24 AWG UTP ~120 ohm |
| Propagation velocity | 2e8 m/s (~0.67 c) | Guideline (typical) | Round screening default; [S272] Table 6-1 uses 0.78 c for its example cable (Belden 3109A, §5) |
| Rise time when undeclared | 0.1 / baud (10% UI) | Guideline | Corroborated by [S272] Table 6-1: 100 ns at 1 Mbps, 250 ns at 250 kbps, 500 ns at 200 kbps — all 10% of the unit interval |
| Termination tolerance | +/-20% | Guideline | [S272] §6 discusses resistor-tolerance trade-offs; 20% is a common screen band, configurable |
| Driver offset (typical) | 2.5 V | Guideline | Typical Vcc/2 for a 5-V driver; the mandate is the -1..+3 V range (Table 1) |
| Differential output (typical) | 2 V | Guideline | Typical loaded VOD; the mandate is 1.5..5 V (Table 1) |
| CM headroom warning | 0.5 V | Guideline | Screening margin, configurable |
| Marginal band ratio | 1.2x | Guideline (contract) | Shared skill-contract convention |
| Failsafe threshold | 0.2 V | Mandate default, configurable | 200 mV receiver mandate; true-failsafe receivers may relax it per datasheet ([S272] §7 notes internal failsafe noise margin can be as low as 10 mV) |

Hand-check (rise time): at 100 kbps, UI = 10 us, 10% = 1 us ->
gate/stub limit = 1e-6 x 2e8 / 10 = 20 m. ✓

## Table 3 — Length rules

| Rule | Formula | Class | Source |
|---|---|---|---|
| Stub limit | L_stub <= tr x v / 10 | Guideline (standard-derived) | [S272] §6 equation (1): L_Stub <= (tr/10) x v x c |
| Electrical-length gate (missing termination) | length > tr x v / 10 -> long | Guideline (declared extrapolation) | Same critical-length formula reused as the gate; documented convention, not standard text |
| Speed-vs-length curve | min(1219.2 m, 1.2192e8 / baud) | Guideline (warning only) | [S272] §2: 10 Mbps at 40 ft, 4000 ft at 100 kbps; §9 plateau discussion. 4000 ft x 0.3048 = 1219.2 m; 1e7 bps x 40 ft x 0.3048 = 1.2192e8 m·bps |
| Conservative text rule (NOT enforced) | length[m] x rate[bps] < 1e7 | Documented only | [S272] §9 calls it "far more conservative"; enforcing it would flag TI's own 4000 ft / 100 kbps headline (5e7) |

Hand-check (stub, TI Table 6-1 row): SN65HVD12, tr = 100 ns, 0.78 c:
0.78 x 299792458 x 100e-9 / 10 = 2.3384 m = 7.67 ft -> table lists
7 ft (floored). ✓

Hand-check (curve): 1e6 bps -> 1.2192e8/1e6 = 121.92 m (~120 m at
1 Mbps); 1e7 -> 12.192 m (~12 m at 10 Mbps); 1e5 -> 1219.2 m plateau
(~1200 m at 100 kbps). ✓

## Table 4 — Bias divider model and unit-load convention

| Item | Formula | Class | Source |
|---|---|---|---|
| Idle differential | V_idle = Vcc x Rt_eff / (Rp + Rn + Rt_eff) | Model | [S272] §7 series-divider model |
| Effective load | Rt_eff = parallel(end-termination load, all receiver resistances) | Model | Same; receiver R = 12000/UL per node |
| Noise margin requirement | V_AB >= 200 mV + V_noise | Mandate + margin | [S272] §7 equation (2); the 1.2x marginal band approximates unknown noise |
| Bias UL (screened) | 12000 / (Rp + Rn) | **Declared convention (guideline)** | Series differential path: rails are AC grounds, so Rp and Rn appear in series across A/B, consistent with the divider model |
| Bias UL (stricter, reported) | 12000/Rp + 12000/Rn | Reported for transparency | [S272] §8: "failsafe biasing contributes up to 20 unit loads" (per-resistor common-mode view); N = (32-20)/UL_per_node -> 96 nodes at 1/8 UL |
| Driver DC load | parallel(term load, receivers, Rp+Rn) >= 54 ohm | Convention vs mandate load | 54 ohm test load is the mandate (Table 1); applying it to the total DC load is the declared screening convention |

Hand-check (TI worked example, [S272] §7): Vcc_min 4.75 V, two 523 ohm
resistors, 60 ohm termination load:
V = 4.75 x 60 / (523 + 523 + 60) = 285/1106 = 0.25769 V >= 0.25 V
target. ✓

Hand-check (default fixture): 16 x 1/8 UL -> 96000 ohm each ->
6000 ohm parallel; Rt_eff = 60 || 6000 = 6000/101 = 59.40594 ohm;
V_idle = 5 x (6000/101) / (1360 + 6000/101) = 30000/143360 =
0.20926339 V (>= 0.2 V, < 0.24 V -> marginal warning).
I_idle = 505/143360 = 3.5226 mA.
Bias UL = 12000/1360 = 8.82353; total = 2 + 8.82353 = 10.82353 UL.
Driver load = 60 || 6000 || 1360 = 102000/1792 = 56.91964 ohm
(>= 54, < 64.8 -> marginal warning). ✓

## Verification posture and known limits

- This is a DC/lumped budget screen, not a transmission-line simulation:
  no attenuation-vs-frequency, jitter accumulation, or connector
  discontinuity modeling.
- The bias-UL series-path convention is optimistic relative to the
  per-resistor common-mode count; both numbers are emitted so a
  reviewer can apply the stricter view (relevant when Rp/Rn are small
  and the bus approaches 32 UL).
- The common-mode model assumes the full GPD appears as common-mode at
  the receiver and a symmetric +/-VOD/2 swing about the driver offset;
  real drivers have asymmetric output stages.
- The speed-length curve is a guideline; cable loss, gauge, and
  insulation (see [S272] §9) shift the practical plateau.
- True-failsafe receivers change the bias requirement; adjust
  `bias.failsafeThresholdV` only from the receiver datasheet.