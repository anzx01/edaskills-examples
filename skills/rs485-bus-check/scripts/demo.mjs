#!/usr/bin/env node
// rs485-bus-check — offline TIA/EIA-485 bus physical-layer budget screen.
//
// Computes, from one JSON bus description:
//   1. termination      — end resistors vs cable Z0, electrical-length gate
//   2. failsafe_bias    — idle differential voltage from the bias divider
//   3. node_loading     — unit-load budget (32 UL) and 54-ohm driver load
//   4. common_mode      — worst-case bus common-mode vs -7..+12 V receiver range
//   5. stub_length      — stub limit tr*v/10 plus speed-vs-length guideline
//
// Node >= 20, standard library only, no network, no dependencies.
// CLI: node scripts/demo.mjs --out-dir <dir> [--input <json>]
// stdout: exactly one edaskills.report.v1 JSON report.
// Exit codes: 0 pass / pass_with_warnings, 1 fail, 2 usage or input error.
//
// Every numeric constant is sourced in references/standard-tables.md.
// Standard mandates vs configurable industry-typical guidelines are labeled
// in the messages and in that reference file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = 'rs485-bus-check';
const TOOL_VERSION = '1.0.0';
const EPS = 1e-9;

// --- Constants (sources: references/standard-tables.md) -------------------

// TIA/EIA-485-A receiver unit load: 1 UL ~ 12 kohm input resistance.
// TI SLLA070D unit-load figure; SLLA272D section 8. Standard mandate.
const UL_OHM = 12000;
// TIA/EIA-485-A: up to 32 unit loads on one bus. Standard mandate.
const MAX_UNIT_LOADS = 32;
// TIA/EIA-485-A driver test load: 54 ohm (two 120-ohm terminations in
// parallel = 60 ohm, plus 32 UL in parallel = 375 ohm -> ~51.7 ohm; the
// standard test circuit uses 54 ohm). TI SLLA070D Figure 14. Mandate.
const DRIVER_TEST_LOAD_OHM = 54;
// Receiver input threshold: +/-200 mV. TI SLLA272D section 4. Mandate.
const DEFAULT_FAILSAFE_V = 0.2;
// Receiver common-mode range -7 V .. +12 V. TIA/EIA-485-A via TI SLLA070D
// Figure 13 and SLLA272D section 2. Standard mandate.
const DEFAULT_CM_MIN_V = -7;
const DEFAULT_CM_MAX_V = 12;
// Typical twisted-pair characteristic impedance 120 ohm (22-24 AWG UTP).
// TI SLLA272D section 5. Industry-typical default, configurable.
const DEFAULT_Z0_OHM = 120;
// Typical propagation velocity ~2e8 m/s (~0.67 c). Configurable guideline;
// TI SLLA272D Table 6-1 uses 0.78 c for its example cable.
const DEFAULT_PROP_VELOCITY_MPS = 2e8;
// Default driver rise time = 10% of one unit interval (0.1 / baud).
// Corroborated by TI SLLA272D Table 6-1 (100 ns at 1 Mbps, 250 ns at
// 250 kbps, 500 ns at 200 kbps). Configurable guideline.
const RISE_TIME_UI_FRACTION = 0.1;
// Critical length = tr * v / 10. Stub rule: TI SLLA272D equation (1),
// standard-derived guideline. The same formula gates when missing
// termination becomes an error (documented extrapolation, guideline).
const LENGTH_DIVISOR = 10;
// Speed-vs-length guideline curve: 4000 ft plateau (~1219.2 m) up to
// ~100 kbps, constant rate*length product above (10 Mbps at 40 ft).
// TI SLLA272D sections 2 and 9. Guideline only -> warning, never error.
const FT_TO_M = 0.3048;
const SPEED_LENGTH_PLATEAU_M = 4000 * FT_TO_M; // 1219.2 m
const SPEED_LENGTH_PRODUCT = 1e7 * 40 * FT_TO_M; // 1.2192e8 m*bps
// Default termination matching tolerance +/-20%. Configurable guideline
// (TI SLLA272D section 6 discusses resistor tolerance trade-offs).
const DEFAULT_TERM_TOLERANCE = 0.2;
// Default common-mode headroom warning threshold 0.5 V. Guideline.
const DEFAULT_CM_HEADROOM_V = 0.5;
// Default marginal band multiplier. Contract convention, configurable.
const DEFAULT_MARGINAL_RATIO = 1.2;
// Typical 5-V driver offset (Vcc/2) and differential output 2 V.
// Configurable guidelines; the standard mandates 1.5..5 V |VOD| and
// -1..+3 V offset (TI SLLA070D Figure 12), not these typical values.
const DEFAULT_DRIVER_OFFSET_V = 2.5;
const DEFAULT_VOD_V = 2;
const MAX_NODE_GROUPS = 64;
const MAX_NODE_COUNT = 512;
const ALLOWED_UNIT_LOADS = [1, 0.5, 0.25, 0.125];

// --- Errors ----------------------------------------------------------------

class ScreenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- Pure computation functions (exported for reuse and self-tests) --------

/** Parallel combination of resistances. Empty list -> Infinity (open). */
export function parallelResistance(resistancesOhm) {
  if (!Array.isArray(resistancesOhm)) {
    throw new ScreenError('BAD_RESISTANCE', 'resistances must be an array');
  }
  let inverseSum = 0;
  for (const r of resistancesOhm) {
    if (r === null || r === undefined || r === Infinity) continue;
    if (!Number.isFinite(r) || r <= 0) {
      throw new ScreenError(
        'BAD_RESISTANCE',
        `resistance must be positive and finite, got ${r}`
      );
    }
    inverseSum += 1 / r;
  }
  return inverseSum === 0 ? Infinity : 1 / inverseSum;
}

/** Default driver rise time: 10% of the unit interval (guideline). */
export function defaultRiseTimeS(baudBps) {
  if (!Number.isFinite(baudBps) || baudBps <= 0) {
    throw new ScreenError('BAD_BAUD', `baud must be positive, got ${baudBps}`);
  }
  return RISE_TIME_UI_FRACTION / baudBps;
}

/**
 * Critical electrical length tr*v/10 (meters). Used both as the stub
 * limit (TI SLLA272D eq 1) and as the gate above which a bus counts as
 * electrically long (documented guideline extrapolation).
 */
export function electricalLengthLimitM(riseTimeS, propVelocityMps) {
  if (!Number.isFinite(riseTimeS) || riseTimeS <= 0) {
    throw new ScreenError('BAD_RISE_TIME', 'rise time must be positive');
  }
  if (!Number.isFinite(propVelocityMps) || propVelocityMps <= 0) {
    throw new ScreenError('BAD_VELOCITY', 'propagation velocity must be positive');
  }
  return (riseTimeS * propVelocityMps) / LENGTH_DIVISOR;
}

/** Stub length limit — same tr*v/10 rule (TI SLLA272D eq 1). */
export function stubLimitM(riseTimeS, propVelocityMps) {
  return electricalLengthLimitM(riseTimeS, propVelocityMps);
}

/** True when cable length exceeds the tr*v/10 critical length. */
export function isElectricallyLong(lengthM, riseTimeS, propVelocityMps) {
  return lengthM > electricalLengthLimitM(riseTimeS, propVelocityMps) + EPS;
}

/** Differential load of the end terminations (both -> Z0/2 for matched R). */
export function terminationLoadOhm(termination) {
  const ends = termination.ends;
  if (ends === 'both') return termination.resistanceOhm / 2;
  if (ends === 'one') return termination.resistanceOhm;
  return Infinity;
}

/** Receiver input resistance for a unit-load fraction: 12 kohm / UL. */
export function receiverResistanceOhm(unitLoad) {
  if (!ALLOWED_UNIT_LOADS.includes(unitLoad)) {
    throw new ScreenError(
      'BAD_UNIT_LOAD',
      `unitLoad must be one of 1, 1/2, 1/4, 1/8, got ${unitLoad}`
    );
  }
  return UL_OHM / unitLoad;
}

/**
 * Idle differential bus voltage from the failsafe bias divider:
 * V_idle = Vcc * Rt_eff / (Rp + Rn + Rt_eff).
 * Rt_eff = Infinity (no load) -> Vcc. TI SLLA272D section 7 model.
 */
export function biasIdleVoltageV(vccV, pullupOhm, pulldownOhm, rtEffOhm) {
  if (!Number.isFinite(vccV) || vccV <= 0) {
    throw new ScreenError('BAD_BIAS', 'bias supply must be positive');
  }
  if (
    !Number.isFinite(pullupOhm) ||
    pullupOhm <= 0 ||
    !Number.isFinite(pulldownOhm) ||
    pulldownOhm <= 0
  ) {
    throw new ScreenError('BAD_BIAS', 'bias resistors must be positive');
  }
  if (rtEffOhm === Infinity) return vccV;
  if (!Number.isFinite(rtEffOhm) || rtEffOhm <= 0) {
    throw new ScreenError('BAD_RESISTANCE', 'effective load must be positive');
  }
  return (vccV * rtEffOhm) / (pullupOhm + pulldownOhm + rtEffOhm);
}

/** Idle current drawn by the bias divider (A). */
export function biasCurrentA(vccV, pullupOhm, pulldownOhm, rtEffOhm) {
  const series = pullupOhm + pulldownOhm + (rtEffOhm === Infinity ? 0 : rtEffOhm);
  return biasIdleVoltageV(vccV, pullupOhm, pulldownOhm, rtEffOhm) / 
    (rtEffOhm === Infinity ? series : rtEffOhm);
}

/**
 * Bias network unit loads, counted as ONE series differential path:
 * UL_bias = 12 kohm / (Rp + Rn). Declared screening convention
 * (guideline) consistent with the series-divider idle model; the two
 * rails are AC grounds, so Rp and Rn appear in series across A/B.
 * TI SLLA272D section 8 notes failsafe biasing can contribute up to
 * 20 UL under a stricter per-resistor common-mode count; both numbers
 * are reported in bus.json for transparency.
 */
export function biasUnitLoads(pullupOhm, pulldownOhm) {
  if (
    !Number.isFinite(pullupOhm) ||
    pullupOhm <= 0 ||
    !Number.isFinite(pulldownOhm) ||
    pulldownOhm <= 0
  ) {
    throw new ScreenError('BAD_BIAS', 'bias resistors must be positive');
  }
  return UL_OHM / (pullupOhm + pulldownOhm);
}

/** Total bus unit loads: receivers + bias series path. */
export function totalUnitLoads(nodes, pullupOhm, pulldownOhm) {
  let ul = 0;
  for (const node of nodes) {
    ul += node.count * node.unitLoad;
  }
  if (pullupOhm != null && pulldownOhm != null) {
    ul += biasUnitLoads(pullupOhm, pulldownOhm);
  }
  return ul;
}

/**
 * Total DC load seen by the driver: terminations || receivers || bias
 * series path. Screening convention: compared against the 54-ohm
 * TIA-485 driver test load (TI SLLA070D Figure 14).
 */
export function driverLoadOhm(termLoadOhm, receiverResistancesOhm, biasSeriesOhm) {
  const parts = [termLoadOhm, ...receiverResistancesOhm];
  if (biasSeriesOhm != null) parts.push(biasSeriesOhm);
  return parallelResistance(parts);
}

/**
 * Worst-case bus common-mode extremes at the receiver:
 *   high = +GPD + driverOffset + VOD/2
 *   low  = -GPD + driverOffset - VOD/2
 * headroom = min(cmMax - high, low - cmMin). TI SLLA272D section 11
 * (ground potential difference adds common-mode noise).
 */
export function worstCaseCommonMode(
  gpdV,
  driverOffsetV,
  vodV,
  cmMinV = DEFAULT_CM_MIN_V,
  cmMaxV = DEFAULT_CM_MAX_V
) {
  const highV = gpdV + driverOffsetV + vodV / 2;
  const lowV = -gpdV + driverOffsetV - vodV / 2;
  return {
    highV,
    lowV,
    headroomV: Math.min(cmMaxV - highV, lowV - cmMinV),
  };
}

/**
 * Speed-vs-length guideline (meters): 1219.2 m plateau (4000 ft) up to
 * ~100 kbps, then constant rate*length product (10 Mbps at 40 ft,
 * 1 Mbps at ~120 m). TI SLLA272D sections 2 and 9. Guideline only.
 */
export function speedLengthGuidelineM(baudBps) {
  if (!Number.isFinite(baudBps) || baudBps <= 0) {
    throw new ScreenError('BAD_BAUD', `baud must be positive, got ${baudBps}`);
  }
  return Math.min(SPEED_LENGTH_PLATEAU_M, SPEED_LENGTH_PRODUCT / baudBps);
}

// --- Input validation -------------------------------------------------------

function num(value, code, label, { min = null, positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScreenError(code, `${label} must be a finite number, got ${value}`);
  }
  if (positive && value <= 0) {
    throw new ScreenError(code, `${label} must be positive, got ${value}`);
  }
  if (min !== null && value < min) {
    throw new ScreenError(code, `${label} must be >= ${min}, got ${value}`);
  }
  return value;
}

function optNum(obj, key, fallback, code, label, opts) {
  const raw = obj?.[key];
  if (raw === undefined || raw === null) return fallback;
  return num(raw, code, label, opts);
}

export function validate(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScreenError('BAD_INPUT', 'input must be a JSON object');
  }
  const bus = input.bus;
  if (bus === null || typeof bus !== 'object') {
    throw new ScreenError('BAD_INPUT', 'input.bus object is required');
  }
  const baudBps = num(bus.baudBps, 'BAD_BAUD', 'bus.baudBps', { positive: true });
  const lengthM = num(bus.lengthM, 'BAD_LENGTH', 'bus.lengthM', { min: 0 });
  const z0Ohm = optNum(bus, 'z0Ohm', DEFAULT_Z0_OHM, 'BAD_Z0', 'bus.z0Ohm', {
    positive: true,
  });
  const propVelocityMps = optNum(
    bus,
    'propVelocityMps',
    DEFAULT_PROP_VELOCITY_MPS,
    'BAD_VELOCITY',
    'bus.propVelocityMps',
    { positive: true }
  );
  const riseTimeS = optNum(
    bus,
    'riseTimeS',
    defaultRiseTimeS(baudBps),
    'BAD_RISE_TIME',
    'bus.riseTimeS',
    { positive: true }
  );
  const marginalRatio = optNum(
    bus,
    'marginalRatio',
    DEFAULT_MARGINAL_RATIO,
    'BAD_MARGINAL',
    'bus.marginalRatio',
    { positive: true }
  );
  if (marginalRatio <= 1) {
    throw new ScreenError('BAD_MARGINAL', 'bus.marginalRatio must be > 1');
  }

  const termRaw = input.termination;
  if (termRaw === null || typeof termRaw !== 'object') {
    throw new ScreenError('BAD_TERMINATION', 'input.termination object is required');
  }
  const ends = termRaw.ends;
  if (!['both', 'one', 'none'].includes(ends)) {
    throw new ScreenError(
      'BAD_TERMINATION',
      `termination.ends must be "both", "one" or "none", got ${JSON.stringify(ends)}`
    );
  }
  const resistanceOhm =
    ends === 'none'
      ? null
      : num(termRaw.resistanceOhm, 'BAD_TERMINATION', 'termination.resistanceOhm', {
          positive: true,
        });
  const toleranceRatio = optNum(
    termRaw,
    'toleranceRatio',
    DEFAULT_TERM_TOLERANCE,
    'BAD_TERMINATION',
    'termination.toleranceRatio',
    { positive: true }
  );
  if (toleranceRatio >= 1) {
    throw new ScreenError('BAD_TERMINATION', 'termination.toleranceRatio must be < 1');
  }
  const termination = { ends, resistanceOhm, toleranceRatio };

  let bias = null;
  if (input.bias !== undefined && input.bias !== null) {
    const b = input.bias;
    if (typeof b !== 'object' || Array.isArray(b)) {
      throw new ScreenError('BAD_BIAS', 'input.bias must be an object');
    }
    bias = {
      vccV: num(b.vccV, 'BAD_BIAS', 'bias.vccV', { positive: true }),
      pullupOhm: num(b.pullupOhm, 'BAD_BIAS', 'bias.pullupOhm', { positive: true }),
      pulldownOhm: num(b.pulldownOhm, 'BAD_BIAS', 'bias.pulldownOhm', {
        positive: true,
      }),
      failsafeThresholdV: optNum(
        b,
        'failsafeThresholdV',
        DEFAULT_FAILSAFE_V,
        'BAD_THRESHOLD',
        'bias.failsafeThresholdV',
        { positive: true }
      ),
    };
  }

  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new ScreenError('NO_NODES', 'input.nodes must be a non-empty array');
  }
  if (input.nodes.length > MAX_NODE_GROUPS) {
    throw new ScreenError('NO_NODES', `too many node groups (max ${MAX_NODE_GROUPS})`);
  }
  const nodes = input.nodes.map((n, i) => {
    if (n === null || typeof n !== 'object') {
      throw new ScreenError('BAD_NODE', `nodes[${i}] must be an object`);
    }
    const count = num(n.count, 'BAD_NODE', `nodes[${i}].count`, { positive: true });
    if (!Number.isInteger(count) || count > MAX_NODE_COUNT) {
      throw new ScreenError(
        'BAD_NODE',
        `nodes[${i}].count must be an integer <= ${MAX_NODE_COUNT}`
      );
    }
    if (!ALLOWED_UNIT_LOADS.includes(n.unitLoad)) {
      throw new ScreenError(
        'BAD_UNIT_LOAD',
        `nodes[${i}].unitLoad must be one of 1, 0.5, 0.25, 0.125, got ${n.unitLoad}`
      );
    }
    const stubM = optNum(n, 'stubM', 0, 'BAD_STUB', `nodes[${i}].stubM`, { min: 0 });
    const name =
      typeof n.name === 'string' && n.name.length > 0 ? n.name : `group-${i + 1}`;
    return { name, count, unitLoad: n.unitLoad, stubM };
  });

  const cmRaw = input.commonMode ?? {};
  if (typeof cmRaw !== 'object' || Array.isArray(cmRaw)) {
    throw new ScreenError('BAD_CM', 'input.commonMode must be an object');
  }
  const commonMode = {
    gpdV: optNum(cmRaw, 'gpdV', 0, 'BAD_CM', 'commonMode.gpdV', { min: 0 }),
    driverOffsetV: optNum(
      cmRaw,
      'driverOffsetV',
      DEFAULT_DRIVER_OFFSET_V,
      'BAD_CM',
      'commonMode.driverOffsetV'
    ),
    vodV: optNum(cmRaw, 'vodV', DEFAULT_VOD_V, 'BAD_CM', 'commonMode.vodV', {
      positive: true,
    }),
    cmMinV: optNum(cmRaw, 'cmMinV', DEFAULT_CM_MIN_V, 'BAD_CM', 'commonMode.cmMinV'),
    cmMaxV: optNum(cmRaw, 'cmMaxV', DEFAULT_CM_MAX_V, 'BAD_CM', 'commonMode.cmMaxV'),
    headroomV: optNum(cmRaw, 'headroomV', DEFAULT_CM_HEADROOM_V, 'BAD_CM',
      'commonMode.headroomV', { min: 0 }),
  };
  if (commonMode.cmMaxV <= commonMode.cmMinV) {
    throw new ScreenError('BAD_CM', 'commonMode.cmMaxV must exceed cmMinV');
  }

  return {
    bus: { baudBps, lengthM, z0Ohm, propVelocityMps, riseTimeS, marginalRatio },
    termination,
    bias,
    nodes,
    commonMode,
  };
}

// --- Screening engines ------------------------------------------------------

function verdictFor(value, limit, ratio, direction) {
  // direction 'min': value must be >= limit; 'max': value must be <= limit.
  if (direction === 'min') {
    if (value < limit - EPS) return 'fail';
    if (value < limit * ratio - EPS) return 'marginal';
    return 'pass';
  }
  if (value > limit + EPS) return 'fail';
  if (value > limit / ratio + EPS) return 'marginal';
  return 'pass';
}

export function screen(input) {
  const v = validate(input);
  const { bus, termination, bias, nodes, commonMode } = v;
  const ratio = bus.marginalRatio;
  const items = [];
  const checks = [];
  const add = (severity, code, message) => items.push({ severity, code, message });

  // Shared limits.
  const gateM = electricalLengthLimitM(bus.riseTimeS, bus.propVelocityMps);
  const stubMaxM = stubLimitM(bus.riseTimeS, bus.propVelocityMps);
  const long = isElectricallyLong(bus.lengthM, bus.riseTimeS, bus.propVelocityMps);
  const termLoad = terminationLoadOhm(termination);
  const receiverResistances = nodes.flatMap((n) =>
    Array(n.count).fill(receiverResistanceOhm(n.unitLoad))
  );
  const receiverUl = nodes.reduce((s, n) => s + n.count * n.unitLoad, 0);
  const biasSeries = bias ? bias.pullupOhm + bias.pulldownOhm : null;
  const rtEff = parallelResistance([termLoad, ...receiverResistances]);
  const loadOhm = driverLoadOhm(termLoad, receiverResistances, biasSeries);
  const speedLenM = speedLengthGuidelineM(bus.baudBps);

  // 1. Termination + electrical-length gate.
  add(
    'info',
    'ELECTRICAL_LENGTH',
    `Cable ${bus.lengthM} m vs critical length tr*v/10 = ${gateM.toFixed(3)} m ` +
      `(tr = ${bus.riseTimeS} s, v = ${bus.propVelocityMps} m/s): bus is ` +
      `electrically ${long ? 'LONG (termination required)' : 'short (guideline gate)'}.`
  );
  checks.push({
    check: 'electrical_length_gate_m',
    measured: bus.lengthM,
    required: gateM,
    margin: gateM - bus.lengthM,
    verdict: 'info',
  });
  if (termination.ends === 'both') {
    const dev = Math.abs(termination.resistanceOhm - bus.z0Ohm) / bus.z0Ohm;
    const verdict = verdictFor(dev, termination.toleranceRatio, ratio, 'max');
    checks.push({
      check: 'termination_deviation',
      measured: dev,
      required: termination.toleranceRatio,
      margin: termination.toleranceRatio - dev,
      verdict,
    });
    if (verdict === 'fail') {
      add(
        'error',
        'TERMINATION',
        `End resistors ${termination.resistanceOhm} ohm deviate ${(dev * 100).toFixed(1)}% ` +
          `from cable Z0 ${bus.z0Ohm} ohm (tolerance +/-${(termination.toleranceRatio * 100).toFixed(0)}%, guideline).`
      );
    } else if (verdict === 'marginal') {
      add(
        'warning',
        'TERMINATION_MARGINAL',
        `End resistors ${termination.resistanceOhm} ohm deviate ${(dev * 100).toFixed(1)}% ` +
          `from Z0 ${bus.z0Ohm} ohm, near the +/-${(termination.toleranceRatio * 100).toFixed(0)}% tolerance edge.`
      );
    } else {
      add(
        'info',
        'TERMINATION_OK',
        `Both ends terminated with ${termination.resistanceOhm} ohm ` +
          `(Z0 ${bus.z0Ohm} ohm, deviation ${(dev * 100).toFixed(1)}%); ` +
          `differential termination load ${termLoad} ohm.`
      );
    }
  } else {
    checks.push({
      check: 'termination_deviation',
      measured: null,
      required: termination.toleranceRatio,
      margin: null,
      verdict: long ? 'fail' : 'marginal',
    });
    if (long) {
      add(
        'error',
        'TERMINATION',
        `Electrically long bus (${bus.lengthM} m > ${gateM.toFixed(3)} m gate) with ` +
          `termination at ${termination.ends === 'one' ? 'only one end' : 'no end'}; ` +
          'TIA-485 practice requires matched resistors at BOTH cable ends.'
      );
    } else {
      add(
        'warning',
        'TERMINATION_ABSENT',
        `Termination at ${termination.ends === 'one' ? 'only one end' : 'no end'}, but the bus is ` +
          `electrically short (${bus.lengthM} m <= ${gateM.toFixed(3)} m gate); reflections settle ` +
          'within the rise time, so this is a warning, not an error (guideline gate).'
      );
    }
  }

  // 2. Failsafe bias.
  if (bias) {
    const idleV = biasIdleVoltageV(bias.vccV, bias.pullupOhm, bias.pulldownOhm, rtEff);
    const idleA = biasCurrentA(bias.vccV, bias.pullupOhm, bias.pulldownOhm, rtEff);
    const verdict = verdictFor(idleV, bias.failsafeThresholdV, ratio, 'min');
    checks.push({
      check: 'bias_idle_v',
      measured: idleV,
      required: bias.failsafeThresholdV,
      margin: idleV - bias.failsafeThresholdV,
      verdict,
    });
    checks.push({
      check: 'bias_current_ma',
      measured: idleA * 1000,
      required: null,
      margin: null,
      verdict: 'info',
    });
    const detail =
      `V_idle = ${bias.vccV}*${rtEff.toFixed(4)}/(${bias.pullupOhm}+${bias.pulldownOhm}` +
      `+${rtEff.toFixed(4)}) = ${idleV.toFixed(6)} V vs ${bias.failsafeThresholdV} V threshold`;
    if (verdict === 'fail') {
      add(
        'error',
        'BIAS_FAILSAFE',
        `${detail}: idle differential below the 200 mV receiver threshold ` +
          '(TIA-485 mandate; true-failsafe receivers may relax this — raise ' +
          'bias.failsafeThresholdV only per receiver datasheet). Lower Rp/Rn or reduce loading.'
      );
    } else if (verdict === 'marginal') {
      add(
        'warning',
        'BIAS_FAILSAFE_MARGINAL',
        `${detail}: passes but with less than ${ratio}x margin; noise can erode it ` +
          '(TI SLLA272D eq 2 adds noise to the 200 mV requirement).'
      );
    } else {
      add('info', 'BIAS_FAILSAFE_OK', `${detail}: adequate idle margin.`);
    }
    add(
      'info',
      'BIAS_CURRENT',
      `Bias divider draws ${(idleA * 1000).toFixed(4)} mA at idle from ${bias.vccV} V.`
    );
  } else {
    checks.push({
      check: 'bias_idle_v',
      measured: null,
      required: DEFAULT_FAILSAFE_V,
      margin: null,
      verdict: 'marginal',
    });
    add(
      'warning',
      'BIAS_ABSENT',
      'No failsafe bias network declared; idle bus differential is undefined for ' +
        'classic receivers (open/shorted bus can chatter). Acceptable only with ' +
        'true-failsafe receivers (guideline).'
    );
  }

  // 3. Node loading: unit loads and driver DC load.
  const biasUl = bias ? biasUnitLoads(bias.pullupOhm, bias.pulldownOhm) : 0;
  const biasUlPerResistor = bias
    ? UL_OHM / bias.pullupOhm + UL_OHM / bias.pulldownOhm
    : 0;
  const totalUl = receiverUl + biasUl;
  const ulVerdict = verdictFor(totalUl, MAX_UNIT_LOADS, ratio, 'max');
  checks.push({
    check: 'unit_load_ul',
    measured: totalUl,
    required: MAX_UNIT_LOADS,
    margin: MAX_UNIT_LOADS - totalUl,
    verdict: ulVerdict,
  });
  const ulDetail =
    `${receiverUl} UL receivers + ${biasUl.toFixed(4)} UL bias (series-path convention) ` +
    `= ${totalUl.toFixed(4)} UL vs 32 UL limit`;
  if (ulVerdict === 'fail') {
    add(
      'error',
      'UNIT_LOAD',
      `${ulDetail}: exceeds the TIA-485 32-unit-load mandate. Use lower-UL ` +
        'transceivers (1/4, 1/8 UL), raise bias resistors, or add a repeater.'
    );
  } else if (ulVerdict === 'marginal') {
    add('warning', 'UNIT_LOAD_MARGINAL', `${ulDetail}: near the 32 UL limit.`);
  } else {
    add('info', 'UNIT_LOAD_OK', `${ulDetail}.`);
  }
  const loadVerdict = verdictFor(loadOhm, DRIVER_TEST_LOAD_OHM, ratio, 'min');
  checks.push({
    check: 'driver_load_ohm',
    measured: loadOhm,
    required: DRIVER_TEST_LOAD_OHM,
    margin: loadOhm - DRIVER_TEST_LOAD_OHM,
    verdict: loadVerdict,
  });
  const loadDetail =
    `Driver DC load ${loadOhm.toFixed(4)} ohm (terminations || receivers || bias) ` +
    'vs 54 ohm TIA-485 driver test load';
  if (loadVerdict === 'fail') {
    add(
      'error',
      'DRIVER_LOAD',
      `${loadDetail}: below the standard test load, the driver may not sustain ` +
        '1.5 V differential output (TI SLLA070D Figure 14).'
    );
  } else if (loadVerdict === 'marginal') {
    add(
      'warning',
      'DRIVER_LOAD_MARGINAL',
      `${loadDetail}: passes but with less than ${ratio}x margin.`
    );
  } else {
    add('info', 'DRIVER_LOAD_OK', `${loadDetail}.`);
  }

  // 4. Common-mode range.
  const cm = worstCaseCommonMode(
    commonMode.gpdV,
    commonMode.driverOffsetV,
    commonMode.vodV,
    commonMode.cmMinV,
    commonMode.cmMaxV
  );
  const cmVerdict =
    cm.headroomV < -EPS
      ? 'fail'
      : cm.headroomV < commonMode.headroomV - EPS
        ? 'marginal'
        : 'pass';
  checks.push({
    check: 'cm_high_v',
    measured: cm.highV,
    required: commonMode.cmMaxV,
    margin: commonMode.cmMaxV - cm.highV,
    verdict: cmVerdict,
  });
  checks.push({
    check: 'cm_low_v',
    measured: cm.lowV,
    required: commonMode.cmMinV,
    margin: cm.lowV - commonMode.cmMinV,
    verdict: cmVerdict,
  });
  const cmDetail =
    `Worst-case common-mode ${cm.lowV.toFixed(3)} V .. ${cm.highV.toFixed(3)} V ` +
    `(GPD +/-${commonMode.gpdV} V, offset ${commonMode.driverOffsetV} V, VOD ${commonMode.vodV} V) ` +
    `vs receiver range ${commonMode.cmMinV} .. ${commonMode.cmMaxV} V`;
  if (cmVerdict === 'fail') {
    add(
      'error',
      'CM_RANGE',
      `${cmDetail}: exceeds the TIA-485 -7..+12 V mandate (headroom ` +
        `${cm.headroomV.toFixed(3)} V). Reduce ground potential difference or isolate.`
    );
  } else if (cmVerdict === 'marginal') {
    add(
      'warning',
      'CM_RANGE_MARGINAL',
      `${cmDetail}: headroom ${cm.headroomV.toFixed(3)} V is below the ` +
        `${commonMode.headroomV} V guideline margin.`
    );
  } else {
    add('info', 'CM_RANGE_OK', `${cmDetail}: headroom ${cm.headroomV.toFixed(3)} V.`);
  }

  // 5. Stub lengths + speed-vs-length guideline.
  let worstStub = 0;
  let stubVerdict = 'pass';
  for (const n of nodes) {
    worstStub = Math.max(worstStub, n.stubM);
    const verdict = verdictFor(n.stubM, stubMaxM, ratio, 'max');
    if (verdict === 'fail') {
      stubVerdict = 'fail';
      add(
        'error',
        'STUB_LONG',
        `Node group "${n.name}": stub ${n.stubM} m exceeds the tr*v/10 limit ` +
          `${stubMaxM.toFixed(3)} m (TI SLLA272D eq 1); stub reflections corrupt edges.`
      );
    } else if (verdict === 'marginal') {
      if (stubVerdict !== 'fail') stubVerdict = 'marginal';
      add(
        'warning',
        'STUB_MARGINAL',
        `Node group "${n.name}": stub ${n.stubM} m is within ${ratio}x of the ` +
          `${stubMaxM.toFixed(3)} m limit; shorten taps or slow the driver edges.`
      );
    }
  }
  if (stubVerdict === 'pass') {
    add(
      'info',
      'STUB_OK',
      `Longest stub ${worstStub} m <= tr*v/10 limit ${stubMaxM.toFixed(3)} m.`
    );
  }
  checks.push({
    check: 'stub_max_m',
    measured: worstStub,
    required: stubMaxM,
    margin: stubMaxM - worstStub,
    verdict: stubVerdict,
  });
  const speedVerdict = bus.lengthM > speedLenM + EPS ? 'marginal' : 'pass';
  checks.push({
    check: 'cable_length_guideline_m',
    measured: bus.lengthM,
    required: speedLenM,
    margin: speedLenM - bus.lengthM,
    verdict: speedVerdict,
  });
  if (speedVerdict === 'marginal') {
    add(
      'warning',
      'SPEED_LENGTH',
      `Cable ${bus.lengthM} m exceeds the speed-vs-length guideline ` +
        `${speedLenM.toFixed(1)} m at ${bus.baudBps} bps (TI SLLA272D curve: ` +
        '10 Mbps ~12 m, 1 Mbps ~120 m, 100 kbps ~1200 m). Guideline only — ' +
        'lower the baud rate or shorten the cable.'
    );
  } else {
    add(
      'info',
      'SPEED_LENGTH_OK',
      `Cable ${bus.lengthM} m within the ${speedLenM.toFixed(1)} m guideline at ` +
        `${bus.baudBps} bps.`
    );
  }

  const errors = items.filter((i) => i.severity === 'error').length;
  const warnings = items.filter((i) => i.severity === 'warning').length;
  return {
    items,
    errors,
    warnings,
    checks,
    limits: {
      riseTimeS: bus.riseTimeS,
      electricalLengthGateM: gateM,
      electricallyLong: long,
      stubLimitM: stubMaxM,
      terminationLoadOhm: termLoad === Infinity ? null : termLoad,
      rtEffOhm: rtEff === Infinity ? null : rtEff,
      biasIdleV: bias
        ? biasIdleVoltageV(bias.vccV, bias.pullupOhm, bias.pulldownOhm, rtEff)
        : null,
      biasCurrentA: bias
        ? biasCurrentA(bias.vccV, bias.pullupOhm, bias.pulldownOhm, rtEff)
        : null,
      receiverUnitLoads: receiverUl,
      biasUlDifferential: biasUl,
      biasUlPerResistor,
      totalUnitLoads: totalUl,
      driverLoadOhm: loadOhm === Infinity ? null : loadOhm,
      commonMode: cm,
      speedLengthGuidelineM: speedLenM,
    },
    normalized: v,
  };
}

// --- Self-tests (run on EVERY invocation) -----------------------------------

export function selfTests() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const near = (a, b, tol, msg) => {
    if (!(Math.abs(a - b) <= tol)) {
      throw new Error(`${msg}: ${a} !~ ${b} (tol ${tol})`);
    }
  };
  const codes = (r) => r.items.filter((i) => i.severity === 'error').map((i) => i.code);
  const warnCodes = (r) =>
    r.items.filter((i) => i.severity === 'warning').map((i) => i.code);
  const base = () => ({
    bus: { baudBps: 100000, lengthM: 500, marginalRatio: 1.2 },
    termination: { ends: 'both', resistanceOhm: 120 },
    bias: { vccV: 5, pullupOhm: 680, pulldownOhm: 680 },
    nodes: [{ name: 'field', count: 16, unitLoad: 0.125, stubM: 0.5 }],
    commonMode: { gpdV: 2 },
  });

  check('parallel resistance hand cases', () => {
    near(parallelResistance([120, 120]), 60, EPS, '120||120');
    near(parallelResistance([108, 108]), 54, EPS, '108||108');
    expect(parallelResistance([]) === Infinity, 'empty -> open');
    near(parallelResistance([60, 6000]), 6000 / 101, 1e-9, '60||6000');
  });

  check('default bias divider exact idle voltage', () => {
    // 16 x 1/8 UL -> 96 kohm each -> 6000 ohm; || 60 ohm -> 6000/101.
    const rt = parallelResistance([60, 6000]);
    near(rt, 59.40594059405941, 1e-9, 'Rt_eff');
    // V = 5*(6000/101)/(1360+6000/101) = 30000/143360.
    near(biasIdleVoltageV(5, 680, 680, rt), 30000 / 143360, 1e-12, 'V_idle');
    near(30000 / 143360, 0.20926339285714285, 1e-12, 'V_idle decimal');
  });

  check('unloaded bias and TI 523-ohm worked example', () => {
    expect(biasIdleVoltageV(5, 680, 680, Infinity) === 5, 'open load -> Vcc');
    // TI SLLA272D section 7: 4.75 V, two 523 ohm, 60 ohm load -> 0.2577 V.
    near(
      biasIdleVoltageV(4.75, 523, 523, 60),
      (4.75 * 60) / 1106,
      1e-12,
      'TI example'
    );
    near((4.75 * 60) / 1106, 0.2576853526220615, 1e-12, 'TI example decimal');
  });

  check('bias idle current exact', () => {
    const rt = parallelResistance([60, 6000]);
    // I = Vcc/(Rp+Rn+Rt) = 5/(1360+6000/101) = 505/143360 A.
    near(biasCurrentA(5, 680, 680, rt), 505 / 143360, 1e-15, 'I_bias');
  });

  check('unit-load counting with series-path bias convention', () => {
    near(biasUnitLoads(680, 680), 12000 / 1360, 1e-12, 'bias UL');
    const nodes = [{ count: 16, unitLoad: 0.125 }];
    near(totalUnitLoads(nodes, 680, 680), 2 + 12000 / 1360, 1e-12, 'total UL');
    near(2 + 12000 / 1360, 10.823529411764707, 1e-12, 'total UL decimal');
    near(receiverResistanceOhm(0.125), 96000, EPS, '1/8 UL -> 96 kohm');
    near(receiverResistanceOhm(1), 12000, EPS, '1 UL -> 12 kohm');
  });

  check('unit-load violation 40 classic nodes', () => {
    const nodes = [{ count: 40, unitLoad: 1 }];
    near(totalUnitLoads(nodes, 10000, 10000), 40.6, 1e-12, '40 + 0.6 UL');
    const input = base();
    input.nodes = [{ name: 'classic', count: 40, unitLoad: 1, stubM: 0.5 }];
    input.bias = { vccV: 5, pullupOhm: 10000, pulldownOhm: 10000 };
    input.termination = { ends: 'none' };
    const r = screen(input);
    expect(codes(r).includes('UNIT_LOAD'), 'UNIT_LOAD expected');
  });

  check('54-ohm driver test load boundary', () => {
    // Default fixture: 60 || 6000 || 1360 = 102000/1792 ohm.
    const load = driverLoadOhm(60, Array(16).fill(96000), 1360);
    near(load, 102000 / 1792, 1e-9, 'default driver load');
    near(102000 / 1792, 56.91964285714286, 1e-9, 'decimal');
    expect(load >= 54, 'above 54 ohm');
    near(driverLoadOhm(108, [], null), 108, EPS, 'single 108');
    near(parallelResistance([108, 108]), 54, EPS, 'exactly 54');
    const input = base();
    input.termination = { ends: 'both', resistanceOhm: 100 };
    // 50 || 6000 || 1360 = 47.06 ohm < 54 -> DRIVER_LOAD error.
    const r = screen(input);
    expect(codes(r).includes('DRIVER_LOAD'), 'DRIVER_LOAD expected at 100 ohm ends');
  });

  check('electrical-length gate both sides', () => {
    // tr = 0.1/1e5 = 1 us; gate = 1e-6*2e8/10 = 20 m.
    near(electricalLengthLimitM(1e-6, 2e8), 20, EPS, 'gate');
    expect(!isElectricallyLong(19, 1e-6, 2e8), '19 m short');
    expect(isElectricallyLong(21, 1e-6, 2e8), '21 m long');
    expect(!isElectricallyLong(20, 1e-6, 2e8), '20 m at gate -> short');
  });

  check('short unterminated bus is warning not error', () => {
    const input = base();
    input.bus.lengthM = 5;
    input.termination = { ends: 'none' };
    const r = screen(input);
    expect(!codes(r).includes('TERMINATION'), 'no TERMINATION error when short');
    expect(warnCodes(r).includes('TERMINATION_ABSENT'), 'warning expected');
    // Bias without termination: Rt = 6000, V = 30000/7360 = 4.076 V (OK).
    near(r.limits.biasIdleV, 30000 / 7360, 1e-9, 'short-bus idle');
  });

  check('stub limit hand cases and TI table row', () => {
    near(stubLimitM(1e-6, 2e8), 20, EPS, 'default stub limit');
    // TI SLLA272D Table 6-1: 100 ns at 0.78 c -> 7 ft (2.338 m).
    near(stubLimitM(100e-9, 0.78 * 299792458), 2.3383811724, 1e-6, 'TI row');
    const input = base();
    input.nodes = [{ name: 'tap', count: 4, unitLoad: 0.125, stubM: 25 }];
    expect(codes(screen(input)).includes('STUB_LONG'), '25 m > 20 m -> error');
    const marginal = base();
    marginal.nodes = [{ name: 'tap', count: 4, unitLoad: 0.125, stubM: 18 }];
    const r = screen(marginal);
    expect(warnCodes(r).includes('STUB_MARGINAL'), '18 m > 20/1.2 -> warning');
    expect(!codes(r).includes('STUB_LONG'), '18 m not an error');
  });

  check('common-mode range boundary', () => {
    // high = gpd + 2.5 + 1; gpd 8.5 -> 12.0 exactly (headroom 0 -> warning).
    const atLimit = worstCaseCommonMode(8.5, 2.5, 2);
    near(atLimit.highV, 12, EPS, 'high at limit');
    near(atLimit.headroomV, 0, EPS, 'zero headroom');
    const input = base();
    input.commonMode = { gpdV: 8.5 };
    expect(warnCodes(screen(input)).includes('CM_RANGE_MARGINAL'), 'boundary warning');
    input.commonMode = { gpdV: 9 };
    const r = screen(input);
    expect(codes(r).includes('CM_RANGE'), 'gpd 9 -> 12.5 V -> error');
    near(r.limits.commonMode.highV, 12.5, EPS, 'high 12.5');
    const ok = worstCaseCommonMode(2, 2.5, 2);
    near(ok.highV, 5.5, EPS, 'default high');
    near(ok.lowV, -0.5, EPS, 'default low');
    near(ok.headroomV, 6.5, EPS, 'default headroom');
  });

  check('speed-vs-length guideline curve', () => {
    near(speedLengthGuidelineM(1e5), 1219.2, 1e-9, '100 kbps plateau');
    near(speedLengthGuidelineM(1e4), 1219.2, 1e-9, '10 kbps plateau');
    near(speedLengthGuidelineM(1e6), 121.92, 1e-9, '1 Mbps');
    near(speedLengthGuidelineM(1e7), 12.192, 1e-9, '10 Mbps');
    const input = base();
    input.bus.lengthM = 1500;
    const r = screen(input);
    expect(warnCodes(r).includes('SPEED_LENGTH'), 'guideline warning');
    expect(!codes(r).includes('SPEED_LENGTH'), 'guideline never errors');
  });

  check('rise-time default and override', () => {
    near(defaultRiseTimeS(1e5), 1e-6, 1e-15, '10% UI at 100 kbps');
    near(defaultRiseTimeS(1e6), 1e-7, 1e-16, '10% UI at 1 Mbps');
    const input = base();
    input.bus.riseTimeS = 500e-9;
    const r = screen(input);
    near(r.limits.stubLimitM, 10, EPS, 'override tr 500 ns -> 10 m');
  });

  check('termination tolerance matching', () => {
    const input = base();
    input.termination = { ends: 'both', resistanceOhm: 200 };
    expect(codes(screen(input)).includes('TERMINATION'), '200 vs 120 -> error');
    const ok = base();
    ok.termination = { ends: 'both', resistanceOhm: 130 };
    expect(!codes(screen(ok)).includes('TERMINATION'), '130 vs 120 (8.3%) OK');
  });

  check('validation rejects bad unit load', () => {
    const input = base();
    input.nodes = [{ name: 'x', count: 4, unitLoad: 0.3, stubM: 0.5 }];
    let code = null;
    try {
      screen(input);
    } catch (err) {
      code = err.code;
    }
    expect(code === 'BAD_UNIT_LOAD', `expected BAD_UNIT_LOAD, got ${code}`);
  });

  check('validation rejects negative length', () => {
    const input = base();
    input.bus.lengthM = -5;
    let code = null;
    try {
      screen(input);
    } catch (err) {
      code = err.code;
    }
    expect(code === 'BAD_LENGTH', `expected BAD_LENGTH, got ${code}`);
  });

  check('validation rejects bad termination enum', () => {
    const input = base();
    input.termination = { ends: 'middle', resistanceOhm: 120 };
    let code = null;
    try {
      screen(input);
    } catch (err) {
      code = err.code;
    }
    expect(code === 'BAD_TERMINATION', `expected BAD_TERMINATION, got ${code}`);
  });

  check('default fixture is pass_with_warnings with exact numbers', () => {
    const r = screen(base());
    expect(r.errors === 0, `expected 0 errors, got ${r.errors}`);
    expect(r.warnings === 2, `expected 2 warnings, got ${r.warnings}`);
    expect(
      warnCodes(r).includes('BIAS_FAILSAFE_MARGINAL') &&
        warnCodes(r).includes('DRIVER_LOAD_MARGINAL'),
      'expected the two marginal warnings'
    );
    near(r.limits.biasIdleV, 0.20926339285714285, 1e-12, 'idle');
    near(r.limits.driverLoadOhm, 56.91964285714286, 1e-9, 'load');
    near(r.limits.totalUnitLoads, 10.823529411764707, 1e-12, 'UL');
  });

  check('end-to-end fail fixture has three documented errors', () => {
    const input = base();
    input.termination = { ends: 'none' };
    input.bias = { vccV: 5, pullupOhm: 10000, pulldownOhm: 10000 };
    input.nodes = [{ name: 'classic', count: 40, unitLoad: 1, stubM: 0.5 }];
    const r = screen(input);
    const c = codes(r).sort();
    expect(
      JSON.stringify(c) ===
        JSON.stringify(['BIAS_FAILSAFE', 'TERMINATION', 'UNIT_LOAD']),
      `expected 3 errors, got ${JSON.stringify(c)}`
    );
    expect(r.warnings === 0, `expected 0 warnings, got ${r.warnings}`);
    // V_idle = 5*300/20300 = 1500/20300 V.
    near(r.limits.biasIdleV, 1500 / 20300, 1e-12, 'fail idle');
  });

  return results;
}

// --- Artifacts and report ----------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function run(input, outDir) {
  const ranAt = new Date().toISOString();
  const tests = selfTests();
  const failedTests = tests.filter((t) => !t.ok);
  let result = null;
  const items = [];

  try {
    result = screen(input);
    items.push(...result.items);
  } catch (err) {
    const code = err instanceof ScreenError ? err.code : 'SCREEN_FAILED';
    items.push({ severity: 'error', code, message: err.message });
  }

  for (const t of failedTests) {
    items.push({
      severity: 'error',
      code: 'SELFTEST_FAILED',
      message: `self-test "${t.name}" failed: ${t.error}`,
    });
  }
  if (failedTests.length === 0) {
    items.push({
      severity: 'info',
      code: 'SELFTEST_OK',
      message:
        `${tests.length}/${tests.length} self-tests passed (bias divider, unit loads, ` +
        '54-ohm driver load, electrical-length gate, stub limit, common-mode range, ' +
        'speed-length guideline, termination tolerance, validation, end-to-end).',
    });
  }

  const errors = items.filter((i) => i.severity === 'error').length;
  const warnings = items.filter((i) => i.severity === 'warning').length;
  const verdict = errors > 0 ? 'fail' : warnings > 0 ? 'pass_with_warnings' : 'pass';
  const artifacts = ['bus.json', 'margins.csv'];

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'bus.json'),
    JSON.stringify(
      {
        tool: TOOL,
        toolVersion: TOOL_VERSION,
        ranAt,
        verdict,
        result: result
          ? { limits: result.limits, normalized: result.normalized }
          : null,
        selfTests: tests,
        items,
      },
      null,
      2
    ) + '\n'
  );
  const rows = [['check', 'measured', 'required', 'margin', 'verdict']];
  for (const c of result ? result.checks : []) {
    rows.push([c.check, c.measured, c.required, c.margin, c.verdict]);
  }
  fs.writeFileSync(
    path.join(outDir, 'margins.csv'),
    rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n'
  );

  return {
    schema: 'edaskills.report.v1',
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    ranAt,
    verdict,
    errors,
    warnings,
    items,
    artifacts,
  };
}

// --- CLI ---------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let outDir = null;
  let inputPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out-dir') outDir = args[++i];
    else if (args[i] === '--input') inputPath = args[++i];
    else {
      process.stderr.write(`unknown argument: ${args[i]}\n`);
      outDir = null;
      break;
    }
  }
  if (!outDir) {
    process.stderr.write(
      'usage: node scripts/demo.mjs --out-dir <dir> [--input <json>]\n'
    );
    process.exit(2);
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedInput = inputPath
    ? path.resolve(inputPath)
    : path.join(scriptDir, 'fixtures', 'input.json');
  let input;
  try {
    input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read input ${resolvedInput}: ${err.message}\n`);
    process.exit(2);
  }
  const report = run(input, path.resolve(outDir));
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(report.verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}