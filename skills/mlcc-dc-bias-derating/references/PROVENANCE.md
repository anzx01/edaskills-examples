# Provenance

## Inspiration source

- Repository: `CDFER/Ceramic-Capacitor-Derating`
  (https://github.com/CDFER/Ceramic-Capacitor-Derating), a Jupyter
  notebook + Murata SimSurfing CSV dataset that plots capacitance
  density vs DC bias for assorted MLCCs.
- License status at review time: the README's "License" section states
  "MIT License" in writing, but the repository ships **no LICENSE
  file**. Under this library's house precedent a written README license
  declaration is accepted as the author's stated intent, while the
  missing LICENSE file is recorded here as a defect of the upstream
  packaging. This ambiguity is one more reason the bundle takes the
  zero-copy route below.

## What was taken (ideas only)

- The engineering idea: read a vendor DC-bias curve CSV and evaluate
  the effective capacitance at an operating bias instead of trusting
  the nominal value.
- The SimSurfing CSV **file layout** (`#` comment header lines
  including a `...degC` temperature declaration, then
  `DC Bias[V],Capacitance[F],` and numeric rows with trailing empty
  cells) was inspected from the upstream examples purely to define a
  compatible input contract. A file format is an interface fact, not
  copied expression.

## What was NOT taken

- **Zero copy**: no upstream code, notebook cells, prose, plots or
  CSV data were vendored, ported or paraphrased. The pandas dependency
  is not used; the interpolation, CSV parsing, validation and report
  pipeline are an independent Node >= 20 stdlib implementation written
  for this library.
- **No vendor data**: the upstream SimSurfing CSVs are Murata-generated
  measurements with their own terms; none ship here. The bundled
  `references/fixtures/synthetic-bias.csv` and `synthetic-temp.csv` are
  hand-constructed synthetic teaching curves (four bias points, three
  temperature points) chosen so every self-test anchor has an exact
  closed form. Real vendor CSVs are supplied by the user at run time.

## Public engineering facts used

Piecewise-linear interpolation, the definition of capacitance
retention under DC bias, and parallel-capacitor arithmetic are
unprotectable mathematics. The separable bias × temperature
approximation is a modeling choice of this bundle, documented as an
approximation in SKILL.md and references/derivation.md.

## Verification

17 known-answer self-tests run on every invocation: interpolation
midpoints and exact nodes on the synthetic curves, the combined
6.0125 µF / 60.125 % anchor, parallel count and required-nominal closed
forms, |V| mapping for negative bias, and the no-extrapolation /
missing-column / uncovered-temperature rejection paths.

## License

All original code, docs and fixtures in this bundle are MIT (see
SKILL.md frontmatter).