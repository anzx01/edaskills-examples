# Procedures: from load capture to runtime budget

The offline core budgets a profile you already measured. Capturing a
trustworthy profile and trustworthy cell data is bench work; this is the
flow an engineer follows around the script.

## 1. Capture the load profile

- Instrument the battery bus (or the regulated rail, noting which) with
  a current probe + scope, a source-measure unit, or a logging power
  analyzer. A multimeter average hides pulses; capture at a sample rate
  that resolves the shortest active state.
- Enumerate every state: sleep, idle, sensing, compute, radio TX/RX,
  display/actuator, startup/inrush, and exceptional states (retry
  storms, OTA updates). Record current, duration and repetition period
  for each; concurrency matters — sum overlapping loads.
- Reduce the capture to piecewise-constant segments for one duty cycle
  (`name`, `currentMa`, `durationS`). Keep the raw capture archived; the
  segment list is a model of it, and models drift.
- Note the rail voltage the currents were measured at; the script
  reflects them to the battery bus through the regulator chain.

## 2. Collect cell and power-path data

- From the cell datasheet: exact part/revision, rated capacity and its
  test conditions (rate, temperature, cutoff), nominal/full/cutoff
  voltages, internal resistance vs SoC/temperature/age, continuous and
  pulse current limits.
- From the power tree: each regulator's efficiency at the actual load
  and input voltage (not one optimistic constant), and quiescent
  currents. The system minimum input voltage (UVLO) sets the brownout
  limit.
- Decide the derating policy explicitly: operating temperature, age/
  cycle factor at end of service life, and reserve margin. Write down
  the source of each factor; the bundled temperature tables are
  screening defaults, not vendor data.

## 3. Run the budget

```bash
node scripts/demo.mjs --out-dir reports --input my-product.json
```

Read the verdict and item codes:

- `BROWNOUT_RISK`: the worst segment crosses the minimum input before
  the reserve SoC. Options: lower-impedance cell, more parallel strings,
  bulk capacitance for the pulse, softer TX ramp, or a lower UVLO —
  then re-measure the pulse, do not just relax the limit.
- `PULSE_DROOP`: droop below minimum even at full charge; the average
  budget is meaningless until pulse capability is proven on the bench.
- `TEMP_EXTRAPOLATION`: the temperature is outside the screening table;
  get vendor curves or chamber data before trusting the factor.
- `NEGATIVE_CURRENT`, `BAD_CAPACITY`, `BAD_EFFICIENCY`, `EMPTY_PROFILE`,
  `BAD_DURATION`, `BAD_RESERVE`, `BAD_TOPOLOGY`: input contract errors;
  fix the JSON, never paper over them.
- `runtime.json` carries the full segment table and `segments.csv` the
  worst-case view: the segment with the shortest continuous-only
  runtime is your stress case.

## 4. Validate and iterate

- Run a real discharge test with the actual profile at the operating
  temperature and compare against the estimate; expect the screening
  model to be optimistic or pessimistic by tens of percent, and record
  the correction factor for the next revision.
- Re-run the budget when the firmware duty cycle, cell, regulator or
  temperature spec changes; old verdicts go stale.
- Charger/BMS/protection design, transport and safety compliance are
  separate activities with qualified review; this bundle does not claim
  them.