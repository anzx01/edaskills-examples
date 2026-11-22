# Derivation notes (hand-checked closed forms)

## Model

Class-II (X5R/X7R/...) MLCCs lose capacitance with applied DC field.
Vendors publish a small-signal capacitance sweep `C(V)` at a declared
temperature, and separately a temperature characteristic
`rate(T)` in percent at zero bias. This bundle combines them
separably:

```
Ceff(V, T) = C(V) * (1 + rate(T)/100)
```

This is an approximation: real dielectrics couple bias and temperature.
It is the standard first-order screening model and is flagged as
`SEPARABLE_MODEL` in every report that uses both curves.

## Interpolation

On a segment `(x0, y0) -> (x1, y1)`:

```
y(x) = y0 + (y1 - y0) * (x - x0) / (x1 - x0)
```

Queries outside `[x_first, x_last]` raise `BIAS_OUT_OF_RANGE` /
`TEMP_OUT_OF_RANGE`. Extrapolating a ferroelectric dielectric curve
into an unswept region would fabricate data, so it is refused.

Without a temperature curve, the operating temperature must equal the
bias curve's declared temperature within `tempToleranceC` (default
0.5 °C); otherwise the point is not covered and the run fails.

## Sizing arithmetic

```
retention        = Ceff / Cnominal
requiredNominal  = Ctarget / retention        (same-family scaling)
parallelCount    = ceil(Ctarget / Ceff)
```

`requiredNominal` assumes a larger part in the same dielectric /
package / voltage family keeps the same retention ratio — a screening
estimate. `parallelCount` uses the actually characterized part and is
exact arithmetic on the interpolated value.

## Synthetic fixture anchors (all exact closed forms)

Bias curve (declared 25 °C): `(0, 10 µF), (5, 8 µF), (10, 5 µF),
(16, 3 µF)`. Temperature curve: `(-55, -10 %), (25, 0 %), (85, -15 %)`.

| Query | Segment | Closed form | Result |
|---|---|---|---|
| C(2.5 V) | 0→5 V | 10 + (8−10)·(2.5/5) | 9 µF |
| C(7.5 V) | 5→10 V | 8 + (5−8)·(2.5/5) | 6.5 µF |
| C(10 V) | node | — | 5 µF |
| rate(55 °C) | 25→85 °C | 0 + (−15−0)·(30/60) | −7.5 % |
| Ceff(7.5 V, 55 °C) | — | 6.5 · 0.925 | 6.0125 µF |
| retention vs 10 µF | — | 6.0125/10 | 0.60125 |
| bias-only keep | — | 6.5/10 | 0.65 |
| N for 12 µF | — | ceil(12/6.0125) = ceil(1.99584) | 2 |
| required nominal | — | 12/0.60125 | 19.95842 µF |

Rejection anchors: 16.1 V and 100 °C lie past the curve ends; 85 °C
with only the 25 °C bias curve is uncovered; a `Capacitance[uF]` header
violates the farads-only contract; repeated bias rows violate strict
monotonicity. Each is asserted by a self-test on every run.

## CSV contract details

- `#` lines are comments; the first `...degC` match declares the bias
  curve temperature.
- The bias header must contain `DC Bias[V]` and `Capacitance[F]`
  (case-insensitive). Other units are rejected, not silently converted.
- Trailing empty cells (SimSurfing writes `0.0,5.89E-6,`) are dropped.
- Rows must be numeric with strictly increasing bias; capacitance must
  be positive.
- The optional temperature header must contain `Temperature[degC]`
  (or `Temp[degC]`) and `Capacitance change rate[%]`.