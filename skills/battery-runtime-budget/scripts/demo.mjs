#!/usr/bin/env node
/**
 * battery-runtime-budget: offline load-profile runtime budgeting.
 * Piecewise-constant duty-cycle integration, temperature/age derating,
 * optional Peukert correction for lead-acid, regulator efficiency chain
 * with quiescent current, reserve margin and a brownout check against a
 * piecewise-linear discharge curve. Pure stdlib Node >= 20, no network.
 * Independent implementation of standard engineering mathematics; see
 * references/PROVENANCE.md. Known-answer self-tests run on every call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = 'battery-runtime-budget';

class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Screening capacity-vs-temperature tables (house approximation, NOT
// vendor data; piecewise-linear between points, clamped outside range).
const CHEMISTRY = {
  'li-ion': {
    fullV: 4.2,
    cutoffV: 3.0,
    tempTable: [
      [-20, 0.6],
      [0, 0.8],
      [25, 1.0],
      [45, 0.95],
      [60, 0.9],
    ],
  },
  lifepo4: {
    fullV: 3.65,
    cutoffV: 2.5,
    tempTable: [
      [-20, 0.5],
      [0, 0.75],
      [25, 1.0],
      [45, 0.97],
      [60, 0.92],
    ],
  },
  nimh: {
    fullV: 1.4,
    cutoffV: 1.0,
    tempTable: [
      [-20, 0.5],
      [0, 0.7],
      [25, 1.0],
      [45, 0.95],
      [60, 0.85],
    ],
  },
  'lead-acid': {
    fullV: 2.15,
    cutoffV: 1.75,
    tempTable: [
      [-20, 0.5],
      [0, 0.7],
      [25, 1.0],
      [45, 1.0],
      [60, 0.95],
    ],
  },
};

export function temperatureFactor(table, tempC) {
  const lo = table[0][0];
  const hi = table[table.length - 1][0];
  const t = Math.min(hi, Math.max(lo, tempC));
  let factor = table[table.length - 1][1];
  for (let i = 1; i < table.length; i += 1) {
    if (t <= table[i][0]) {
      const [t0, f0] = table[i - 1];
      const [t1, f1] = table[i];
      factor = f0 + ((t - t0) / (t1 - t0)) * (f1 - f0);
      break;
    }
  }
  return { factor, extrapolated: tempC < lo || tempC > hi };
}

/**
 * Peukert effective capacity at discharge current I:
 * t = H·(I_r/I)^k with I_r = C/H, so C_eff(I) = C·(I_r/I)^(k-1).
 * k = 1 reduces to the ideal C/I runtime.
 */
export function peukertCapacityMah(
  usableMah,
  ratedMah,
  ratedHours,
  k,
  currentMa
) {
  if (currentMa <= 0) return usableMah;
  const ratedCurrent = ratedMah / ratedHours;
  return usableMah * (ratedCurrent / currentMa) ** (k - 1);
}

/** Piecewise-linear open-circuit voltage vs state of charge (0..1). */
export function vocAtSoc(soc, fullV, nominalV, cutoffV) {
  const s = Math.min(1, Math.max(0, soc));
  if (s >= 0.5) return nominalV + ((s - 0.5) / 0.5) * (fullV - nominalV);
  return cutoffV + (s / 0.5) * (nominalV - cutoffV);
}

function validate(input) {
  const b = input.battery ?? {};
  const chem = CHEMISTRY[b.chemistry];
  if (!chem)
    throw new BudgetError(
      'BAD_CHEMISTRY',
      `battery.chemistry must be one of ${Object.keys(CHEMISTRY).join(', ')}`
    );
  if (!(Number.isFinite(b.capacityMah) && b.capacityMah > 0))
    throw new BudgetError('BAD_CAPACITY', 'battery.capacityMah must be > 0');
  const nominal = b.nominalVoltageV;
  if (!(Number.isFinite(nominal) && nominal > 0))
    throw new BudgetError('BAD_VOLTAGE', 'battery.nominalVoltageV must be > 0');
  const full = b.fullVoltageV ?? chem.fullV;
  const cutoff = b.cutoffVoltageV ?? chem.cutoffV;
  if (!(full > nominal && nominal > cutoff && cutoff > 0))
    throw new BudgetError(
      'BAD_VOLTAGE',
      'need fullVoltageV > nominalVoltageV > cutoffVoltageV > 0'
    );
  const series = b.seriesCells ?? 1;
  const parallel = b.parallelStrings ?? 1;
  if (
    !Number.isInteger(series) ||
    !Number.isInteger(parallel) ||
    series < 1 ||
    parallel < 1
  )
    throw new BudgetError(
      'BAD_TOPOLOGY',
      'seriesCells and parallelStrings must be integers >= 1'
    );
  const rint = b.internalResistanceOhm ?? 0;
  if (!(Number.isFinite(rint) && rint >= 0))
    throw new BudgetError(
      'BAD_RESISTANCE',
      'internalResistanceOhm must be >= 0'
    );
  const d = input.derating ?? {};
  const age = d.ageFactor ?? 1;
  if (!(age > 0 && age <= 1))
    throw new BudgetError(
      'BAD_AGE_FACTOR',
      'derating.ageFactor must be in (0, 1]'
    );
  const reserve = input.reserveMarginPct ?? 0;
  if (!(reserve >= 0 && reserve < 100))
    throw new BudgetError(
      'BAD_RESERVE',
      'reserveMarginPct must be in [0, 100)'
    );
  const regs = input.regulators ?? [];
  let eta = 1;
  let iq = 0;
  for (const r of regs) {
    if (!(r.efficiency > 0 && r.efficiency <= 1))
      throw new BudgetError(
        'BAD_EFFICIENCY',
        `regulator "${r.name ?? '?'}" efficiency must be in (0, 1]`
      );
    const q = r.quiescentMa ?? 0;
    if (!(q >= 0))
      throw new BudgetError('BAD_EFFICIENCY', 'quiescentMa must be >= 0');
    eta *= r.efficiency;
    iq += q;
  }
  const rail = input.railVoltageV ?? nominal * series;
  if (!(rail > 0))
    throw new BudgetError('BAD_RAIL', 'railVoltageV must be > 0');
  const segments = input.loadProfile?.segments;
  if (!Array.isArray(segments) || segments.length === 0)
    throw new BudgetError(
      'EMPTY_PROFILE',
      'loadProfile.segments must be non-empty'
    );
  for (const s of segments) {
    if (!(Number.isFinite(s.currentMa) && s.currentMa >= 0))
      throw new BudgetError(
        'NEGATIVE_CURRENT',
        `segment "${s.name ?? '?'}" currentMa must be finite and >= 0`
      );
    if (!(Number.isFinite(s.durationS) && s.durationS > 0))
      throw new BudgetError(
        'BAD_DURATION',
        `segment "${s.name ?? '?'}" durationS must be > 0`
      );
  }
  const tempC = d.temperatureC ?? 25;
  if (!Number.isFinite(tempC))
    throw new BudgetError(
      'BAD_TEMPERATURE',
      'derating.temperatureC must be finite'
    );
  const k = b.peukertExponent ?? 1;
  const ratedHours = b.ratedDischargeHours ?? 20;
  if (b.chemistry === 'lead-acid') {
    if (!(k >= 1 && k <= 2))
      throw new BudgetError('BAD_PEUKERT', 'peukertExponent must be in [1, 2]');
    if (!(ratedHours > 0))
      throw new BudgetError('BAD_PEUKERT', 'ratedDischargeHours must be > 0');
  }
  return {
    chem,
    b,
    series,
    parallel,
    rint,
    age,
    reserve,
    eta,
    iq,
    rail,
    segments,
    tempC,
    k,
    ratedHours,
    full,
    cutoff,
    nominal,
  };
}

/**
 * Budget one load profile. Returns items/errors/warnings plus the full
 * numeric result; engineering findings are items, contract violations
 * throw BudgetError.
 */
export function budgetRuntime(input) {
  const items = [];
  let errors = 0;
  let warnings = 0;
  const add = (severity, code, message) => {
    if (severity === 'error') errors += 1;
    if (severity === 'warning') warnings += 1;
    items.push({ severity, code, message });
  };
  const v = validate(input);
  const packNominalV = v.nominal * v.series;
  const packFullV = v.full * v.series;
  const packCutoffV = v.cutoff * v.series;
  const packCapacityMah = v.b.capacityMah * v.parallel;
  const packR = (v.rint * v.series) / v.parallel;

  const tf =
    input.derating?.temperatureFactor !== undefined
      ? { factor: input.derating.temperatureFactor, extrapolated: false }
      : temperatureFactor(v.chem.tempTable, v.tempC);
  if (!(tf.factor > 0 && tf.factor <= 1.2))
    throw new BudgetError(
      'BAD_TEMPERATURE_FACTOR',
      'temperatureFactor override must be in (0, 1.2]'
    );
  if (tf.extrapolated)
    add(
      'warning',
      'TEMP_EXTRAPOLATION',
      `temperature ${v.tempC} C outside screening table range; factor clamped to ${tf.factor.toFixed(3)}`
    );
  const reserveFraction = v.reserve / 100;
  const usableMah = packCapacityMah * tf.factor * v.age * (1 - reserveFraction);
  const leadAcid = v.b.chemistry === 'lead-acid';
  if (
    !leadAcid &&
    v.b.peukertExponent !== undefined &&
    v.b.peukertExponent !== 1
  )
    add(
      'info',
      'PEUKERT_IGNORED',
      'Peukert correction applies to lead-acid only; exponent ignored for this chemistry'
    );
  const k = leadAcid ? v.k : 1;

  const cycleS = v.segments.reduce((a, s) => a + s.durationS, 0);
  const rows = v.segments.map((s) => {
    const batteryMa = (s.currentMa * v.rail) / (v.eta * packNominalV) + v.iq;
    const mah = (batteryMa * s.durationS) / 3600;
    const cEff = leadAcid
      ? peukertCapacityMah(
          usableMah,
          packCapacityMah,
          v.ratedHours,
          k,
          batteryMa
        )
      : usableMah;
    return {
      name: s.name ?? 'segment',
      loadMa: s.currentMa,
      batteryMa,
      durationS: s.durationS,
      dutyPct: (s.durationS / cycleS) * 100,
      mahPerCycle: mah,
      peukertCapacityMah: cEff,
      continuousRuntimeH: batteryMa > 0 ? cEff / batteryMa : Infinity,
      fractionPerCycle: batteryMa > 0 ? mah / cEff : 0,
    };
  });
  const mahPerCycle = rows.reduce((a, r) => a + r.mahPerCycle, 0);
  const fractionPerCycle = rows.reduce((a, r) => a + r.fractionPerCycle, 0);
  if (!(fractionPerCycle > 0))
    throw new BudgetError('ZERO_LOAD', 'profile draws no battery current');
  const cyclesToEmpty = 1 / fractionPerCycle;
  const runtimeHours = (cyclesToEmpty * cycleS) / 3600;
  const avgBatteryMa = mahPerCycle / (cycleS / 3600);
  const worst = rows.reduce((a, r) =>
    r.continuousRuntimeH < a.continuousRuntimeH ? r : a
  );

  // Brownout: terminal voltage of the worst segment along the discharge
  // curve, compared with the regulator/system minimum input.
  const minInputV = input.minInputVoltageV ?? packCutoffV;
  const vTerm = (soc, ma) =>
    vocAtSoc(soc, packFullV, packNominalV, packCutoffV) - (ma / 1000) * packR;
  let brownoutSoc = null;
  for (let s = 1; s >= 0; s -= 0.001) {
    if (vTerm(s, worst.batteryMa) < minInputV) {
      brownoutSoc = s;
      break;
    }
  }
  const vAtReserve = vTerm(reserveFraction, worst.batteryMa);
  const brownout = {
    minInputV,
    worstSegment: worst.name,
    worstBatteryMa: worst.batteryMa,
    brownoutSoc,
    reserveSoc: reserveFraction,
    terminalVAtReserve: vAtReserve,
    marginV: vAtReserve - minInputV,
  };
  if (brownoutSoc !== null && brownoutSoc > reserveFraction + 1e-9)
    add(
      'error',
      'BROWNOUT_RISK',
      `worst segment "${worst.name}" (${worst.batteryMa.toFixed(2)} mA) drops below ${minInputV.toFixed(2)} V at SoC ${(brownoutSoc * 100).toFixed(1)}%, before the ${(reserveFraction * 100).toFixed(0)}% reserve is reached`
    );
  else
    add(
      'info',
      'BROWNOUT_OK',
      `worst-segment terminal voltage at reserve SoC is ${vAtReserve.toFixed(3)} V vs minimum ${minInputV.toFixed(2)} V (margin ${(vAtReserve - minInputV).toFixed(3)} V)`
    );
  for (const r of rows)
    if (vTerm(1, r.batteryMa) < minInputV)
      add(
        'warning',
        'PULSE_DROOP',
        `segment "${r.name}" droops below minimum input even at full charge; check pulse capability separately`
      );
  add(
    'info',
    'RUNTIME_OK',
    `runtime ${runtimeHours.toFixed(3)} h (${(runtimeHours / 24).toFixed(2)} days): usable ${usableMah.toFixed(1)} mAh, avg battery current ${avgBatteryMa.toFixed(3)} mA, ${cyclesToEmpty.toFixed(1)} duty cycles`
  );
  return {
    items,
    errors,
    warnings,
    result: {
      pack: {
        nominalV: packNominalV,
        fullV: packFullV,
        cutoffV: packCutoffV,
        capacityMah: packCapacityMah,
        resistanceOhm: packR,
      },
      factors: {
        temperatureFactor: tf.factor,
        ageFactor: v.age,
        reserveFraction,
        efficiencyChain: v.eta,
        quiescentMa: v.iq,
        peukertExponent: k,
      },
      usableMah,
      cycleSeconds: cycleS,
      avgBatteryMa,
      mahPerCycle,
      cyclesToEmpty,
      runtimeHours,
      runtimeDays: runtimeHours / 24,
      worstSegment: {
        name: worst.name,
        continuousRuntimeH: worst.continuousRuntimeH,
      },
      brownout,
      segments: rows,
    },
  };
}

// -------------------------------------------------------------- self-tests --

function selfTests() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const codes = (r) => r.items.map((i) => i.code);
  const ideal = {
    battery: { chemistry: 'li-ion', capacityMah: 1000, nominalVoltageV: 3.7 },
    derating: { temperatureC: 25, ageFactor: 1 },
    regulators: [{ name: 'ideal', efficiency: 1 }],
    railVoltageV: 3.7,
    reserveMarginPct: 0,
    loadProfile: {
      segments: [{ name: 'const', currentMa: 100, durationS: 3600 }],
    },
  };

  check('1000 mAh @ 100 mA constant = 10 h ideal', () => {
    const r = budgetRuntime(ideal);
    expect(r.errors === 0, `errors: ${codes(r)}`);
    expect(
      Math.abs(r.result.runtimeHours - 10) < 1e-9,
      `runtime ${r.result.runtimeHours} != 10`
    );
  });

  check('derated runtime equals hand-computed 5.184 h', () => {
    // T=0C li-ion factor 0.8, age 0.9, reserve 20% -> usable 576 mAh;
    // eta 0.9 at rail=nominal -> battery 111.111 mA; 576/111.111 = 5.184 h.
    const r = budgetRuntime({
      ...ideal,
      derating: { temperatureC: 0, ageFactor: 0.9 },
      regulators: [{ name: 'buck', efficiency: 0.9 }],
      reserveMarginPct: 20,
    });
    expect(r.errors === 0, `errors: ${codes(r)}`);
    expect(
      Math.abs(r.result.usableMah - 576) < 1e-9,
      `usable ${r.result.usableMah} != 576`
    );
    expect(
      Math.abs(r.result.runtimeHours - 5.184) < 1e-9,
      `runtime ${r.result.runtimeHours} != 5.184`
    );
  });

  check('Peukert lead-acid 7 Ah, k=1.2, 700 mA = 8.7055 h', () => {
    // t = H*(I_r/I)^k = 20*(350/700)^1.2 = 8.705506 h by hand.
    const r = budgetRuntime({
      battery: {
        chemistry: 'lead-acid',
        capacityMah: 7000,
        nominalVoltageV: 2.0,
        peukertExponent: 1.2,
        ratedDischargeHours: 20,
      },
      derating: { temperatureC: 25, ageFactor: 1 },
      regulators: [{ name: 'ideal', efficiency: 1 }],
      railVoltageV: 2.0,
      reserveMarginPct: 0,
      loadProfile: {
        segments: [{ name: 'const', currentMa: 700, durationS: 3600 }],
      },
    });
    expect(r.errors === 0, `errors: ${codes(r)}`);
    expect(
      Math.abs(r.result.runtimeHours - 20 * 0.5 ** 1.2) < 1e-6,
      `runtime ${r.result.runtimeHours} != 8.705506`
    );
  });

  check('two-segment duty cycle averages to 10 h', () => {
    const r = budgetRuntime({
      ...ideal,
      loadProfile: {
        segments: [
          { name: 'idle', currentMa: 50, durationS: 3600 },
          { name: 'active', currentMa: 150, durationS: 3600 },
        ],
      },
    });
    expect(r.errors === 0, `errors: ${codes(r)}`);
    expect(
      Math.abs(r.result.runtimeHours - 10) < 1e-9,
      `runtime ${r.result.runtimeHours} != 10`
    );
    expect(
      Math.abs(r.result.avgBatteryMa - 100) < 1e-9,
      'avg current != 100 mA'
    );
  });

  check('2P pack doubles runtime', () => {
    const r = budgetRuntime({
      ...ideal,
      battery: { ...ideal.battery, parallelStrings: 2 },
    });
    expect(Math.abs(r.result.runtimeHours - 20) < 1e-9, '2P != 20 h');
  });

  check('negative current rejected with NEGATIVE_CURRENT', () => {
    let caught = null;
    try {
      budgetRuntime({
        ...ideal,
        loadProfile: {
          segments: [{ name: 'bad', currentMa: -1, durationS: 10 }],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code === 'NEGATIVE_CURRENT', `got ${caught?.code}`);
  });

  check('zero capacity rejected with BAD_CAPACITY', () => {
    let caught = null;
    try {
      budgetRuntime({
        ...ideal,
        battery: { ...ideal.battery, capacityMah: 0 },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code === 'BAD_CAPACITY', `got ${caught?.code}`);
  });

  check('zero efficiency rejected with BAD_EFFICIENCY', () => {
    let caught = null;
    try {
      budgetRuntime({
        ...ideal,
        regulators: [{ name: 'bad', efficiency: 0 }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code === 'BAD_EFFICIENCY', `got ${caught?.code}`);
  });

  check('empty profile rejected with EMPTY_PROFILE', () => {
    let caught = null;
    try {
      budgetRuntime({ ...ideal, loadProfile: { segments: [] } });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code === 'EMPTY_PROFILE', `got ${caught?.code}`);
  });

  check('high-impedance pack flags BROWNOUT_RISK before reserve', () => {
    // R=0.5 ohm, 1000 mA -> 0.5 V droop; Vterm = 2.5 + 1.4*SoC crosses
    // 3.1 V at SoC 0.4286 > 0.2 reserve -> error.
    const r = budgetRuntime({
      ...ideal,
      battery: { ...ideal.battery, internalResistanceOhm: 0.5 },
      minInputVoltageV: 3.1,
      reserveMarginPct: 20,
      loadProfile: {
        segments: [{ name: 'pulse', currentMa: 1000, durationS: 3600 }],
      },
    });
    expect(codes(r).includes('BROWNOUT_RISK'), 'expected BROWNOUT_RISK');
    expect(
      Math.abs(r.result.brownout.brownoutSoc - 0.4286) < 0.002,
      `brownout SoC ${r.result.brownout.brownoutSoc}`
    );
  });

  check('out-of-range temperature warns TEMP_EXTRAPOLATION', () => {
    const r = budgetRuntime({
      ...ideal,
      derating: { temperatureC: -30, ageFactor: 1 },
    });
    expect(
      codes(r).includes('TEMP_EXTRAPOLATION'),
      'expected extrapolation warning'
    );
    expect(
      Math.abs(r.result.factors.temperatureFactor - 0.6) < 1e-9,
      'clamped factor != 0.6'
    );
  });

  check('Peukert ignored for li-ion with info code', () => {
    const r = budgetRuntime({
      ...ideal,
      battery: { ...ideal.battery, peukertExponent: 1.3 },
    });
    expect(codes(r).includes('PEUKERT_IGNORED'), 'expected PEUKERT_IGNORED');
    expect(Math.abs(r.result.runtimeHours - 10) < 1e-9, 'runtime changed');
  });

  return results;
}

// -------------------------------------------------------------------- main --

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function run(input, outDir) {
  const tests = selfTests();
  const failed = tests.filter((t) => !t.ok);
  const items = [];
  let errors = 0;
  let warnings = 0;
  let result = null;
  try {
    const r = budgetRuntime(input);
    result = r.result;
    for (const it of r.items) {
      if (it.severity === 'error') errors += 1;
      if (it.severity === 'warning') warnings += 1;
      items.push(it);
    }
  } catch (e) {
    if (e instanceof BudgetError) {
      errors += 1;
      items.push({ severity: 'error', code: e.code, message: e.message });
    } else throw e;
  }
  for (const t of failed) {
    errors += 1;
    items.push({
      severity: 'error',
      code: 'SELFTEST_FAILED',
      message: `known-answer regression "${t.name}": ${t.detail}`,
    });
  }
  if (failed.length === 0)
    items.push({
      severity: 'info',
      code: 'SELFTEST_OK',
      message: `${tests.length} known-answer self-tests passed (ideal/derated/Peukert/duty-cycle/brownout/validation)`,
    });
  const artifacts = [];
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'runtime.json'),
      `${JSON.stringify({ tool: TOOL, toolVersion: '1.0.0', result, selfTests: tests, items }, null, 2)}\n`,
      'utf8'
    );
    artifacts.push('runtime.json');
    if (result) {
      const head =
        'name,load_ma,battery_ma,duration_s,duty_pct,mah_per_cycle,peukert_capacity_mah,continuous_runtime_h';
      const rows = result.segments.map((s) =>
        [
          s.name,
          s.loadMa.toFixed(4),
          s.batteryMa.toFixed(4),
          s.durationS.toFixed(2),
          s.dutyPct.toFixed(3),
          s.mahPerCycle.toFixed(6),
          s.peukertCapacityMah.toFixed(3),
          Number.isFinite(s.continuousRuntimeH)
            ? s.continuousRuntimeH.toFixed(4)
            : 'inf',
        ]
          .map(csvEscape)
          .join(',')
      );
      fs.writeFileSync(
        path.join(outDir, 'segments.csv'),
        `${head}\n${rows.join('\n')}\n`,
        'utf8'
      );
      artifacts.push('segments.csv');
    }
  }
  const verdict =
    errors > 0 ? 'fail' : warnings > 0 ? 'pass_with_warnings' : 'pass';
  return {
    schema: 'edaskills.report.v1',
    tool: TOOL,
    toolVersion: '1.0.0',
    ranAt: new Date().toISOString(),
    verdict,
    errors,
    warnings,
    items,
    artifacts,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  let inputPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') outDir = argv[++i];
    else if (argv[i] === '--input') inputPath = argv[++i];
  }
  if (!outDir) {
    process.stderr.write('usage: demo.mjs --out-dir <dir> [--input <json>]\n');
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = inputPath ?? path.join(here, 'fixtures', 'input.json');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const report = run(input, outDir);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
