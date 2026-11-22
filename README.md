# Edaskills example skills

Three example [Edaskills](https://edaskills.com) skill bundles, published so
you can see exactly what an Edaskills skill looks like on disk and run the
math yourself before pointing an agent at it.

## What an Edaskills skill is

Each bundle is a self-contained, offline engineering-computation package:

- `SKILL.md`, with a YAML frontmatter (`name`, `description`, `license: MIT`)
  that agent CLIs such as Claude Code load as the skill contract.
- `scripts/demo.mjs`, a single self-contained Node script (Node >= 20, zero
  dependencies, no network) that does the real computation and prints exactly
  one `edaskills.report.v1` JSON report plus artifact files.
- `scripts/fixtures/`, a passing input plus deliberate failure inputs.
- `references/PROVENANCE.md`, the audit trail: which upstream sources and
  standards were consulted, what was and was not copied, and why the result
  is redistributable under MIT.

Every run executes known-answer self-tests first, so the report is auditable:
a verdict only appears if the math still reproduces the hand-checked anchors.

## The three examples

| Skill | What it computes | Known-answer flavor |
|---|---|---|
| [battery-runtime-budget](skills/battery-runtime-budget) | Runtime from a measured duty-cycle load profile, with temperature/age derating, optional Peukert correction, regulator efficiency chain, reserve margin and a brownout screen | The bundled fixture (1440 mAh usable, 1.552 mA average battery current) integrates to 928.1 h, about 38.7 days, with a 0.168 V brownout margin; 12 self-tests run every invocation |
| [mlcc-dc-bias-derating](skills/mlcc-dc-bias-derating) | Effective MLCC capacitance at your bias/temperature operating point by interpolating vendor DC-bias (and optional temperature) curve CSVs, with no-extrapolation rejections | A nominal 10 µF part at 7.5 V bias and 55 °C on the bundled synthetic curves holds 6.0125 µF, 60.125 % retention; reaching 12 µF effective needs 2 parts in parallel; 17 self-tests |
| [rs485-bus-check](skills/rs485-bus-check) | TIA/EIA-485 physical-layer budget: termination vs cable Z0, failsafe bias divider, unit-load budget, common-mode range, stub and speed-length checks | The bundled fixture (16 × 1/8-unit-load nodes, 120 Ω both ends, 680/680 Ω bias, 500 m at 100 kbps) passes every check with 6.5 V common-mode headroom; 19 self-tests |

## Install

The layout is `skills/<slug>/`, so you can point any skills-aware agent CLI
at this directory.

Claude Code, project-level (from a clone of this repo, inside your project):

```bash
mkdir -p .claude/skills
cp -r skills/* .claude/skills/
```

Claude Code, personal:

```bash
cp -r skills/* ~/.claude/skills/
```

The same copy works for Cursor rules/agents, Codex CLI and Gemini CLI skill
directories: each bundle is plain `SKILL.md` plus plain Node scripts, with no
runtime dependency on any specific agent host.

## Run the demo yourself

No agent and no install step needed. From any skill directory (requires
Node >= 20, no dependencies):

```bash
cd skills/battery-runtime-budget
node scripts/demo.mjs --out-dir ./demo-run-out
```

Same command shape for the other two bundles. The script runs its
known-answer self-tests, prints one `edaskills.report.v1` JSON report to
stdout, and writes artifacts (`runtime.json` / `segments.csv`,
`derating.json` / `derating.csv`, `bus.json` / `margins.csv`) into
`--out-dir`. To check your own board numbers, pass `--input <file.json>`
using the fixture in `scripts/fixtures/input.json` as the template.
Exit code is 0 on pass, 1 on a fail verdict, 2 on usage/validation errors.

## Skill pages

| Skill | Page |
|---|---|
| battery-runtime-budget | <https://edaskills.com/skills/battery-runtime-budget> |
| mlcc-dc-bias-derating | <https://edaskills.com/skills/mlcc-dc-bias-derating> |
| rs485-bus-check | <https://edaskills.com/skills/rs485-bus-check> |

More skills, the searchable library and per-skill provenance summaries are at
<https://edaskills.com>.

## License

MIT, see [LICENSE.md](LICENSE.md). Each bundle additionally carries
`license: MIT` in its `SKILL.md` frontmatter and a
`references/PROVENANCE.md` recording which public sources inspired it and
why no upstream code was copied.
