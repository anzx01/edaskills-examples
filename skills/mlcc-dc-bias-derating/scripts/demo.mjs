#!/usr/bin/env node
/**
 * mlcc-dc-bias-derating: offline effective-capacitance screening for
 * Class-II MLCCs under DC bias and temperature, from vendor curve CSVs
 * (Murata SimSurfing export layout) that the user supplies.
 *
 * Math (independent rewrite, public engineering facts):
 *   C(V)   = piecewise-linear interpolation of the DC-bias curve
 *   k(T)   = 1 + rate(T)/100 from an optional temperature-characteristic
 *            curve (separable approximation, bias x temperature coupling
 *            is ignored and documented as such)
 *   Ceff   = C(V) * k(T)
 *   keep   = Ceff / Cnominal
 *   Cnom_required = Ctarget / keep;  N_parallel = ceil(Ctarget / Ceff)
 * No extrapolation: bias or temperature outside the supplied curves is
 * an explicit error, never an invented number.
 *
 * Pure stdlib Node >= 20, no network, no pandas. The bundled fixture CSVs
 * are hand-constructed synthetic teaching data, NOT vendor measurements
 * (see references/PROVENANCE.md). Known-answer self-tests every run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = 'mlcc-dc-bias-derating';
const TOOL_VERSION = '1.0.0';

class ScreenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const FIXTURE_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));

/** Linear interpolation on strictly increasing x; refuses extrapolation. */
export function interpLinear(points, x, rangeCode) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new ScreenError('MISSING_COLUMN', 'curve needs at least 2 points');
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!Number.isFinite(x)) {
    throw new ScreenError('INVALID_INPUT', `query must be finite, got ${x}`);
  }
  if (x < first[0] || x > last[0]) {
    throw new ScreenError(
      rangeCode,
      `query ${x} is outside the curve range [${first[0]}, ${last[0]}]; extrapolation is refused, supply a curve that covers the operating point`
    );
  }
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      if (x1 === x0) return y0;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** Split one CSV line, dropping trailing empty cells (SimSurfing ',,'). */
function csvCells(line) {
  const cells = line.split(',').map((c) => c.trim());
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** Parse data rows after the header into [x, y] pairs, strictly rising x. */
function parseRows(lines, headerIndex, label) {
  const points = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const cells = csvCells(line);
    if (cells.length < 2) {
      throw new ScreenError(
        'MISSING_COLUMN',
        `${label}: row ${i + 1} has fewer than 2 cells: "${line}"`
      );
    }
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ScreenError(
        'MISSING_COLUMN',
        `${label}: row ${i + 1} is not numeric: "${line}"`
      );
    }
    if (points.length > 0 && x <= points[points.length - 1][0]) {
      throw new ScreenError(
        'MISSING_COLUMN',
        `${label}: x values must be strictly increasing (got ${x} after ${points[points.length - 1][0]})`
      );
    }
    points.push([x, y]);
  }
  if (points.length < 2) {
    throw new ScreenError(
      'MISSING_COLUMN',
      `${label}: needs at least 2 data rows, got ${points.length}`
    );
  }
  return points;
}

/**
 * Parse a SimSurfing-style DC-bias CSV: '#' comment lines (one declares
 * the curve temperature, e.g. "#capacitance  25.0degC  AC0.01Vrms"),
 * then the header "DC Bias[V],Capacitance[F]" and numeric rows.
 * Returns { points: [V, F][], declaredTempC: number|null }.
 */
export function parseBiasCsv(text) {
  const lines = String(text).split(/\r?\n/);
  let declaredTempC = null;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('#')) {
      const m = line.match(/(-?\d+(?:\.\d+)?)\s*degC/i);
      if (m && declaredTempC === null) declaredTempC = Number(m[1]);
      continue;
    }
    if (/dc\s*bias\s*\[v\]/i.test(line)) {
      if (!/capacitance\s*\[f\]/i.test(line)) {
        throw new ScreenError(
          'MISSING_COLUMN',
          `bias CSV header must contain "DC Bias[V]" and "Capacitance[F]" (SI farads); got "${line}"`
        );
      }
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    throw new ScreenError(
      'MISSING_COLUMN',
      'bias CSV has no "DC Bias[V],Capacitance[F]" header line'
    );
  }
  const points = parseRows(lines, headerIndex, 'bias CSV');
  for (const [, c] of points) {
    if (c <= 0) {
      throw new ScreenError(
        'MISSING_COLUMN',
        `bias CSV capacitance must be positive, got ${c} F`
      );
    }
  }
  return { points, declaredTempC };
}

/**
 * Parse a temperature-characteristic CSV: header
 * "Temperature[degC],Capacitance change rate[%]" (SimSurfing layout) and
 * numeric rows. Returns { points: [degC, %][] }.
 */
export function parseTempCsv(text) {
  const lines = String(text).split(/\r?\n/);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('#') || line === '') continue;
    if (/temp(?:erature)?\s*\[degc\]/i.test(line)) {
      if (!/capacitance\s+change\s+rate\s*\[%\]/i.test(line)) {
        throw new ScreenError(
          'MISSING_COLUMN',
          `temperature CSV header must contain "Temperature[degC]" and "Capacitance change rate[%]"; got "${line}"`
        );
      }
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    throw new ScreenError(
      'MISSING_COLUMN',
      'temperature CSV has no "Temperature[degC],Capacitance change rate[%]" header line'
    );
  }
  return { points: parseRows(lines, headerIndex, 'temperature CSV') };
}

/** Read a CSV from inline text or a path (relative to baseDir). */
function readCsv(input, textKey, pathKey, baseDir) {
  if (typeof input[textKey] === 'string' && input[textKey].trim() !== '') {
    return input[textKey];
  }
  const p = input[pathKey];
  if (typeof p !== 'string' || p.trim() === '') return null;
  const full = path.resolve(baseDir ?? FIXTURE_DIR, p);
  if (!fs.existsSync(full)) {
    throw new ScreenError('MISSING_COLUMN', `CSV file not found: ${full}`);
  }
  return fs.readFileSync(full, 'utf8');
}

/**
 * Core screening. input: { biasCsv | biasCsvText, tempCsv | tempCsvText,
 * biasV, temperatureC, nominalCapF, targetEffectiveF, csvBaseDir?,
 * options?: { tempToleranceC } }. All capacitances in farads.
 */
export function screenDerating(input) {
  if (!input || typeof input !== 'object') {
    throw new ScreenError('INVALID_INPUT', 'input object missing');
  }
  const { biasV, temperatureC, nominalCapF, targetEffectiveF } = input;
  for (const [name, v] of [
    ['biasV', biasV],
    ['temperatureC', temperatureC],
    ['nominalCapF', nominalCapF],
    ['targetEffectiveF', targetEffectiveF],
  ]) {
    if (!Number.isFinite(v)) {
      throw new ScreenError(
        'INVALID_INPUT',
        `${name} must be a finite number, got ${v}`
      );
    }
  }
  if (nominalCapF <= 0 || targetEffectiveF <= 0) {
    throw new ScreenError(
      'INVALID_INPUT',
      'nominalCapF and targetEffectiveF must be positive'
    );
  }
  const tol = input.options?.tempToleranceC ?? 0.5;
  if (!Number.isFinite(tol) || tol < 0) {
    throw new ScreenError(
      'INVALID_INPUT',
      `options.tempToleranceC must be >= 0, got ${tol}`
    );
  }
  const baseDir = input.csvBaseDir;
  const biasText = readCsv(input, 'biasCsvText', 'biasCsv', baseDir);
  if (biasText === null) {
    throw new ScreenError(
      'MISSING_COLUMN',
      'input.biasCsv (path) or input.biasCsvText (inline CSV) is required'
    );
  }
  const bias = parseBiasCsv(biasText);
  const tempText = readCsv(input, 'tempCsvText', 'tempCsv', baseDir);
  const temp = tempText === null ? null : parseTempCsv(tempText);

  // Class-II MLCC loss depends on field magnitude; the vendor curve is
  // swept with positive bias, so a negative operating bias maps to |V|.
  const usedBiasV = Math.abs(biasV);
  const cAtBiasF = interpLinear(bias.points, usedBiasV, 'BIAS_OUT_OF_RANGE');
  const cZeroF = bias.points[0][1];

  let tempRatePct = 0;
  let tempSource;
  if (temp) {
    tempRatePct = interpLinear(temp.points, temperatureC, 'TEMP_OUT_OF_RANGE');
    tempSource = 'temperature curve';
  } else if (bias.declaredTempC === null) {
    throw new ScreenError(
      'TEMP_OUT_OF_RANGE',
      'bias CSV declares no curve temperature and no temperatureCsv was supplied; cannot judge temperature coverage'
    );
  } else if (Math.abs(temperatureC - bias.declaredTempC) > tol) {
    throw new ScreenError(
      'TEMP_OUT_OF_RANGE',
      `operating temperature ${temperatureC} degC is not covered: the bias curve is declared at ${bias.declaredTempC} degC (tolerance ${tol}); supply a temperature-characteristic CSV instead of guessing`
    );
  } else {
    tempSource = `bias curve declared at ${bias.declaredTempC} degC`;
  }
  const tempFactor = 1 + tempRatePct / 100;
  if (tempFactor <= 0) {
    throw new ScreenError(
      'MISSING_COLUMN',
      `temperature curve implies non-positive capacitance (rate ${tempRatePct}%)`
    );
  }
  const effectiveF = cAtBiasF * tempFactor;
  const biasRetention = cAtBiasF / cZeroF;
  const retention = effectiveF / nominalCapF;
  const requiredNominalF = targetEffectiveF / retention;
  const parallelCount = Math.ceil(targetEffectiveF / effectiveF);
  return {
    usedBiasV,
    negativeBiasMapped: biasV < 0,
    temperatureC,
    tempSource,
    tempRatePct,
    tempFactor,
    cZeroBiasF: cZeroF,
    cAtBiasF,
    effectiveF,
    biasRetention,
    retention,
    nominalCapF,
    targetEffectiveF,
    requiredNominalF,
    parallelCount,
    parallelEffectiveF: parallelCount * effectiveF,
    separableModel: temp !== null,
  };
}

// ------------------------------------------------------------- self-tests --

// Synthetic teaching curves (NOT vendor data). Piecewise-linear anchors:
//   bias:  0V->10uF, 5V->8uF, 10V->5uF, 16V->3uF  (declared 25 degC)
//   temp:  -55C->-10%, 25C->0%, 85C->-15%
// Hand-derived closed forms on these segments:
//   C(2.5V)=9uF; C(7.5V)=6.5uF; rate(55C)=-7.5%
//   Ceff(7.5V,55C)=6.5uF*0.925=6.0125uF; keep=0.60125 vs 10uF nominal
//   N=ceil(12/6.0125)=2; Cnom_req=12uF/0.60125=19.95842uF
const SYNTH_BIAS_CSV = `#SYNTHETIC-TEACHING-DATA,,
#not a vendor measurement,,
#c_dcbias_capacitance,,
#capacitance  25.0degC  AC0.01Vrms,,
DC Bias[V],Capacitance[F],
0.0,10.0e-6,
5.0,8.0e-6,
10.0,5.0e-6,
16.0,3.0e-6,
`;

const SYNTH_TEMP_CSV = `#SYNTHETIC-TEACHING-DATA,,
#c_temp_capacitance,,
Temperature[degC],Capacitance change rate[%],
-55.0,-10.0,
25.0,0.0,
85.0,-15.0,
`;

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
  const expect = (cond, detail) => {
    if (!cond) throw new Error(detail);
  };
  const near = (a, b, rel, label) =>
    expect(
      Math.abs(a - b) <= rel * Math.abs(b),
      `${label}: ${a} vs ${b} (rel ${rel})`
    );
  const throwsCode = (fn, code) => {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = e.code === code;
    }
    expect(threw, `expected ${code}`);
  };

  const bias = parseBiasCsv(SYNTH_BIAS_CSV);
  const temp = parseTempCsv(SYNTH_TEMP_CSV);
  check('bias CSV declares 25 degC', () =>
    expect(bias.declaredTempC === 25, `got ${bias.declaredTempC}`)
  );
  check('C(2.5V) = 9 uF (segment midpoint)', () =>
    near(interpLinear(bias.points, 2.5, 'BIAS_OUT_OF_RANGE'), 9e-6, 1e-12, 'C')
  );
  check('C(7.5V) = 6.5 uF (segment midpoint)', () =>
    near(
      interpLinear(bias.points, 7.5, 'BIAS_OUT_OF_RANGE'),
      6.5e-6,
      1e-12,
      'C'
    )
  );
  check('C(10V) = 5 uF (exact node)', () =>
    near(interpLinear(bias.points, 10, 'BIAS_OUT_OF_RANGE'), 5e-6, 1e-12, 'C')
  );
  check('rate(55C) = -7.5% (segment midpoint)', () =>
    near(
      interpLinear(temp.points, 55, 'TEMP_OUT_OF_RANGE'),
      -7.5,
      1e-12,
      'rate'
    )
  );
  check('bias 16.1V refused (no extrapolation)', () =>
    throwsCode(
      () => interpLinear(bias.points, 16.1, 'BIAS_OUT_OF_RANGE'),
      'BIAS_OUT_OF_RANGE'
    )
  );
  check('temp 100C refused (no extrapolation)', () =>
    throwsCode(
      () => interpLinear(temp.points, 100, 'TEMP_OUT_OF_RANGE'),
      'TEMP_OUT_OF_RANGE'
    )
  );

  const base = {
    biasCsvText: SYNTH_BIAS_CSV,
    tempCsvText: SYNTH_TEMP_CSV,
    biasV: 7.5,
    temperatureC: 55,
    nominalCapF: 10e-6,
    targetEffectiveF: 12e-6,
  };
  const r = screenDerating(base);
  check('Ceff(7.5V, 55C) = 6.0125 uF', () =>
    near(r.effectiveF, 6.0125e-6, 1e-12, 'Ceff')
  );
  check('retention = 0.60125 vs 10 uF nominal', () =>
    near(r.retention, 0.60125, 1e-12, 'keep')
  );
  check('bias-only retention C(7.5)/C(0) = 0.65', () =>
    near(r.biasRetention, 0.65, 1e-12, 'biasKeep')
  );
  check('N = ceil(12/6.0125) = 2 in parallel', () =>
    expect(r.parallelCount === 2, `got ${r.parallelCount}`)
  );
  check('required nominal = 19.95842 uF', () =>
    near(r.requiredNominalF, 12e-6 / 0.60125, 1e-12, 'Cnom_req')
  );
  check('negative bias maps to |V| (field magnitude)', () => {
    const neg = screenDerating({ ...base, biasV: -7.5 });
    near(neg.effectiveF, r.effectiveF, 1e-12, 'Ceff(-7.5V)');
    expect(neg.negativeBiasMapped === true, 'flag');
  });
  check('25C without temp CSV is covered (declared temp)', () => {
    const noTemp = screenDerating({
      ...base,
      tempCsvText: '',
      temperatureC: 25,
    });
    near(noTemp.effectiveF, 6.5e-6, 1e-12, 'Ceff(7.5V,25C)');
  });
  check('85C without temp CSV refused', () =>
    throwsCode(
      () => screenDerating({ ...base, tempCsvText: '', temperatureC: 85 }),
      'TEMP_OUT_OF_RANGE'
    )
  );
  check('header missing Capacitance[F] refused', () =>
    throwsCode(
      () => parseBiasCsv('DC Bias[V],Capacitance[uF],\n0,10,\n5,8,\n'),
      'MISSING_COLUMN'
    )
  );
  check('non-increasing bias rows refused', () =>
    throwsCode(
      () =>
        parseBiasCsv(
          'DC Bias[V],Capacitance[F],\n0,10e-6,\n5,8e-6,\n5,7e-6,\n'
        ),
      'MISSING_COLUMN'
    )
  );
  return results;
}

// -------------------------------------------------------------------- main --

const fmt = (v) => Number(v.toPrecision(6));

export function run(input, outDir) {
  const tests = selfTests();
  const failed = tests.filter((t) => !t.ok);
  const items = [];
  let errors = 0;
  let warnings = 0;
  let result = null;
  const tally = (it) => {
    if (it.severity === 'error') errors += 1;
    if (it.severity === 'warning') warnings += 1;
  };
  try {
    result = screenDerating(input);
    items.push({
      severity: 'info',
      code: 'DERATING_RESULT',
      message: `Ceff(${fmt(result.usedBiasV)} V, ${fmt(result.temperatureC)} degC) = ${fmt(result.effectiveF * 1e6)} uF (${fmt(result.retention * 100)}% of ${fmt(result.nominalCapF * 1e6)} uF nominal; bias-only keep ${fmt(result.biasRetention * 100)}%); target ${fmt(result.targetEffectiveF * 1e6)} uF -> ${result.parallelCount} x this part in parallel (${fmt(result.parallelEffectiveF * 1e6)} uF) or nominal >= ${fmt(result.requiredNominalF * 1e6)} uF at the same keep ratio`,
    });
    if (result.negativeBiasMapped) {
      items.push({
        severity: 'info',
        code: 'NEGATIVE_BIAS_MAPPED',
        message: `negative operating bias mapped to |V| = ${fmt(result.usedBiasV)} V: Class-II loss follows field magnitude and vendor curves are swept positive`,
      });
    }
    if (result.separableModel) {
      items.push({
        severity: 'info',
        code: 'SEPARABLE_MODEL',
        message:
          'bias and temperature curves combined multiplicatively (separable approximation); bias x temperature coupling in real Class-II dielectrics is not modeled',
      });
    }
    if (result.retention < 0.5) {
      const it = {
        severity: 'warning',
        code: 'SEVERE_DERATING',
        message: `only ${fmt(result.retention * 100)}% of nominal capacitance survives at the operating point: consider a larger package, higher voltage rating or a different dielectric before stacking parts`,
      };
      tally(it);
      items.push(it);
    }
    const zeroMismatch =
      Math.abs(result.cZeroBiasF - result.nominalCapF) / result.nominalCapF;
    if (zeroMismatch > 0.2) {
      const it = {
        severity: 'warning',
        code: 'NOMINAL_MISMATCH',
        message: `curve zero-bias capacitance ${fmt(result.cZeroBiasF * 1e6)} uF differs from declared nominal ${fmt(result.nominalCapF * 1e6)} uF by ${fmt(zeroMismatch * 100)}%: verify the CSV belongs to this part (vendor curves reflect small-signal measurement conditions)`,
      };
      tally(it);
      items.push(it);
    }
  } catch (e) {
    if (e instanceof ScreenError) {
      errors += 1;
      items.push({ severity: 'error', code: e.code, message: e.message });
    } else {
      throw e;
    }
  }
  for (const t of failed) {
    errors += 1;
    items.push({
      severity: 'error',
      code: 'SELFTEST_FAILED',
      message: `known-answer regression "${t.name}": ${t.detail}`,
    });
  }
  if (failed.length === 0) {
    items.push({
      severity: 'info',
      code: 'SELFTEST_OK',
      message: `${tests.length} known-answer self-tests passed (synthetic-curve interpolation anchors / separable combination / parallel count / no-extrapolation and missing-column rejections)`,
    });
  }
  const artifacts = [];
  if (outDir && result) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'derating.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    );
    artifacts.push('derating.json');
    const rows = [
      ['bias_V', fmt(result.usedBiasV)],
      ['temperature_C', fmt(result.temperatureC)],
      ['temp_rate_pct', fmt(result.tempRatePct)],
      ['c_zero_bias_uF', fmt(result.cZeroBiasF * 1e6)],
      ['c_at_bias_uF', fmt(result.cAtBiasF * 1e6)],
      ['c_effective_uF', fmt(result.effectiveF * 1e6)],
      ['bias_retention_pct', fmt(result.biasRetention * 100)],
      ['retention_pct', fmt(result.retention * 100)],
      ['nominal_uF', fmt(result.nominalCapF * 1e6)],
      ['target_effective_uF', fmt(result.targetEffectiveF * 1e6)],
      ['required_nominal_uF', fmt(result.requiredNominalF * 1e6)],
      ['parallel_count', result.parallelCount],
      ['parallel_effective_uF', fmt(result.parallelEffectiveF * 1e6)],
    ];
    fs.writeFileSync(
      path.join(outDir, 'derating.csv'),
      `parameter,value\n${rows.map((r) => r.join(',')).join('\n')}\n`,
      'utf8'
    );
    artifacts.push('derating.csv');
  }
  const verdict =
    errors > 0 ? 'fail' : warnings > 0 ? 'pass_with_warnings' : 'pass';
  return {
    schema: 'edaskills.report.v1',
    tool: TOOL,
    toolVersion: TOOL_VERSION,
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
  const file = path.resolve(
    inputPath ?? fileURLToPath(new URL('fixtures/input.json', import.meta.url))
  );
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Relative CSV paths resolve against the input JSON's own directory so
  // the demo runs from any cwd (repo root included).
  if (input && typeof input === 'object' && !input.csvBaseDir) {
    input.csvBaseDir = path.dirname(file);
  }
  const report = run(input, path.resolve(outDir));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
