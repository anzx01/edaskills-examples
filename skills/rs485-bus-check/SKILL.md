---
name: rs485-bus-check
description: Offline TIA/EIA-485 bus physical-layer budget screen — computes end-termination matching against cable Z0 with an electrical-length gate, failsafe-bias idle voltage from the Rp/Rn divider against the 200 mV receiver threshold, the 32-unit-load budget and 54-ohm driver test load, worst-case common-mode (ground potential difference + driver offset) against the -7..+12 V receiver range, and stub length plus the speed-vs-length guideline, from one JSON bus description, emitting a verdicted report and a margins CSV.
license: MIT
---

# rs485-bus-check

Screen one RS-485 (TIA/EIA-485) multidrop bus at the physical layer before
layout or commissioning: termination, failsafe bias, node loading,
common-mode range, and stub lengths. The script is fully offline
(Node >= 20, standard library only, zero dependencies, no network) and
prints exactly one `edaskills.report.v1` JSON report to stdout.

## What the script computes

Five engines, all from one input JSON:

1. **Termination** — end resistors vs cable characteristic impedance
   (default 120 ohm). Both ends within the configurable tolerance
   (default +/-20%, guideline) -> OK. Missing termination is an **error**
   only when the cable is electrically long: length > tr x v / 10
   (rise time x propagation velocity / 10). A short/slow unterminated bus
   gets a warning, not an error. Two matched end resistors present
   Z0/2 as the differential termination load to the bias engine.
2. **Failsafe bias** — Rp to Vcc, Rn to GND at one point.
   `Rt_eff = parallel(termination load, all receiver input resistances)`;
   `V_idle = Vcc x Rt_eff / (Rp + Rn + Rt_eff)`. Below the threshold
   (default 0.2 V, the TIA-485 receiver mandate) -> error; below
   1.2x threshold -> warning. True-failsafe receivers may relax the
   threshold via `bias.failsafeThresholdV` per their datasheet. The idle
   bias current is also reported.
3. **Node loading** — 1 UL = 12 kohm; per-node UL in {1, 1/2, 1/4, 1/8}.
   Receivers plus the bias network must stay within 32 UL (mandate).
   The bias network is counted as **one series differential path**,
   `12000 / (Rp + Rn)` UL — a declared screening convention consistent
   with the series-divider idle model (rails are AC grounds). The
   stricter per-resistor count (`12000/Rp + 12000/Rn`) is reported
   alongside in `bus.json` for transparency; TI SLLA272D notes failsafe
   biasing can contribute up to 20 UL under that stricter view. The
   total DC driver load (terminations || receivers || bias series path)
   must be >= 54 ohm, the TIA-485 driver test load (TI SLLA070D Fig 14).
4. **Common mode** — worst-case bus common-mode at the receiver:
   high = +GPD + driverOffset + VOD/2, low = -GPD + driverOffset - VOD/2,
   against the -7..+12 V receiver range (mandate). Negative headroom ->
   error; headroom below 0.5 V (guideline) -> warning. Defaults
   driverOffset 2.5 V and VOD 2 V are typical 5-V values (guidelines,
   configurable); the standard mandates |VOD| 1.5..5 V and offset
   -1..+3 V, not these typicals.
5. **Stub length** — limit = tr x v / 10 (TI SLLA272D eq 1). Over the
   limit -> error `STUB_LONG`; within 1.2x of the limit -> warning
   `STUB_MARGINAL` (the standard marginal band, chosen over a 2x band).
   Default tr = 0.1/baud (10% of the unit interval, corroborated by TI
   Table 6-1); default v = 2e8 m/s. Separately, cable length is compared
   against the TI speed-vs-length **guideline** curve (10 Mbps ~12 m,
   1 Mbps ~120 m, 100 kbps ~1200 m plateau): exceeding it is a warning
   only, never an error.

Every hardcoded value, its public source, and a hand-check per table are
in `references/standard-tables.md`. Standard mandates vs configurable
industry-typical guidelines are labeled there and in the item messages.

Artifacts written to `--out-dir`:

- `bus.json` — normalized input, all computed limits (idle voltage, bias
  current, both bias-UL counts, driver load, common-mode extremes, gate
  and stub limits, speed-length guideline), self-test results, items.
- `margins.csv` — `check,measured,required,margin,verdict` rows for
  termination deviation, bias idle voltage, bias current, unit loads,
  driver load, common-mode high/low, max stub, cable-length guideline,
  and the electrical-length gate.

## Self-tests

`selfTests()` runs on **every** invocation: 19 named cases covering the
bias divider hand case (exact 30000/143360 V) and TI's 523-ohm worked
example, bias idle current, unit-load counting including the
bias-as-series-UL convention, the 54-ohm driver-load boundary, the
electrical-length gate on both sides, short-bus warning behavior, stub
limit hand cases including a TI Table 6-1 row, common-mode range
boundary (exactly 12 V), the speed-length guideline curve, rise-time
default and override, termination tolerance, three validation
rejections, the default fixture's exact numbers, and the end-to-end
fail fixture. Any failure adds a `SELFTEST_FAILED` error; all passing
adds one `SELFTEST_OK` info.

## Run

```bash
# Default fixture (100 kbps, 500 m, 16 x 1/8 UL nodes, 120 ohm both ends,
# 680/680 ohm bias at 5 V, 0.5 m stubs, GPD 2 V):
node scripts/demo.mjs --out-dir /tmp/rs485-out
# -> exit 0, verdict pass_with_warnings (0 errors, 2 warnings:
#    BIAS_FAILSAFE_MARGINAL at 0.20926 V idle, DRIVER_LOAD_MARGINAL at
#    56.92 ohm), artifacts bus.json + margins.csv.

# Fail fixture (no termination on a long bus, 10k/10k bias, 40 x 1 UL):
node scripts/demo.mjs --out-dir /tmp/rs485-fail --input scripts/fixtures/fail-bus.json
# -> exit 1, verdict fail, exactly 3 errors: TERMINATION, BIAS_FAILSAFE
#    (0.07389 V idle), UNIT_LOAD (40.6 UL); 0 warnings.
```

Missing `--out-dir` or an unreadable `--input` prints usage/error to
stderr and exits 2. Invalid input content produces an error item
(e.g. `BAD_UNIT_LOAD`, `BAD_LENGTH`) in the report, never a crash.

## Input shape

```jsonc
{
  "bus": {
    "baudBps": 100000,        // required, > 0
    "lengthM": 500,           // required, >= 0 (cable end-to-end)
    "z0Ohm": 120,             // optional, default 120 (guideline)
    "propVelocityMps": 2e8,   // optional, default 2e8 m/s (guideline)
    "riseTimeS": null,        // optional, default 0.1/baud (guideline)
    "marginalRatio": 1.2      // optional, warning band multiplier > 1
  },
  "termination": {
    "ends": "both",           // "both" | "one" | "none"
    "resistanceOhm": 120,     // required unless ends = "none"
    "toleranceRatio": 0.2     // optional, +/-20% matching (guideline)
  },
  "bias": {                   // optional; omit -> BIAS_ABSENT warning
    "vccV": 5,
    "pullupOhm": 680,         // Rp: A line to Vcc
    "pulldownOhm": 680,       // Rn: B line to GND
    "failsafeThresholdV": 0.2 // optional; raise only per true-failsafe
  },                          // receiver datasheet
  "nodes": [                  // required, non-empty; groups of identical nodes
    { "name": "field-nodes", "count": 16, "unitLoad": 0.125, "stubM": 0.5 }
  ],
  "commonMode": {             // optional block, all fields optional
    "gpdV": 2,                // ground potential difference, default 0
    "driverOffsetV": 2.5,     // typical Vcc/2 (guideline)
    "vodV": 2,                // typical differential output (guideline)
    "cmMinV": -7,             // receiver range (mandate defaults)
    "cmMaxV": 12,
    "headroomV": 0.5          // warning margin (guideline)
  }
}
```

`unitLoad` must be exactly 1, 0.5, 0.25, or 0.125. Node counts are
integers (max 512 per group, 64 groups).

## When to use

- Reviewing an RS-485 multidrop bus schematic or cable plan: termination
  placement/values, bias network sizing, transceiver loading, stub
  lengths, and grounding budget before fabrication or commissioning.
- Sizing failsafe bias resistors against a known node population.
- Deciding whether a missing termination or a long stub actually matters
  at the chosen baud rate and driver edge speed.

Sibling skills: `lceda-signal-integrity-review` covers PCB return paths
and serpentine/length matching; `lceda-emc-precompliance-core` covers
emissions risk; `usb-c-cc-check` covers USB Type-C CC resistors — this
skill is only the TIA-485 bus physical-layer budget.

## Not for

- PROFIBUS/Modbus protocol timing, framing, or address configuration.
- Isolated transceiver barrier design (use `creepage-clearance-check`).
- Cable shielding, grounding topology for EMC, or emissions compliance.
- Signaling above 10 Mbps or non-TIA-485 physical layers.