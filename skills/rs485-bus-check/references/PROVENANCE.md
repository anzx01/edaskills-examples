# Provenance — rs485-bus-check

Access date for all sources: **2026-11-22**.

## Methodology sources (primary, publicly available)

All electrical rules, formulas, and numeric constants were independently
re-implemented from the following public application notes. The PDFs
were downloaded and their text extracted and read directly during
development; no text is copied into this bundle — only facts, formulas,
and independently written code.

1. **Texas Instruments SLLA272D — "The RS-485 Design Guide"**
   (Feb 2008, revised May 2021).
   URL: https://www.ti.com/lit/an/slla272d/slla272d.pdf
   Used for: 32 UL / -7..+12 V / 10 Mbps at 40 ft / 4000 ft at 100 kbps
   headline limits (section 2); 1.5 V into 54 ohm driver and 200 mV
   receiver threshold (section 4); 120 ohm UTP Z0 and cable examples
   (section 5); termination practice and stub equation (1)
   L_stub <= (tr/10) x v x c plus Table 6-1 worked rows (section 6);
   failsafe bias divider model, eq (2) noise margin, and the 523-ohm
   worked example (section 7); unit-load definition ~12 kohm, 1/8 UL
   parts, and "failsafe biasing contributes up to 20 unit loads"
   (section 8); 10% jitter criterion, conservative length x rate < 1e7
   rule-of-thumb, and the ~1200 m DC-resistance plateau (section 9);
   ground potential difference as common-mode noise (section 11).
   Copyrighted document; facts and formulas are not copyrightable
   expression. No prose copied.

2. **Texas Instruments SLLA070D — "RS-422 and RS-485 Standards Overview
   and System Configurations"** (June 2002, revised May 2010).
   URL: https://www.ti.com/lit/an/slla070d/slla070d.pdf
   Used for: TIA/EIA-485-A generator limits — |VOD| 1.5..5 V loaded,
   offset -1..+3 V (Figure 12), common-mode loading test -7..+12 V with
   375 ohm / 60 ohm circuit (Figure 13), the **54 ohm + 50 pF driver
   test load** (Figure 14), and the unit-load boundary figure
   (1 mA at +12 V, 0.8 mA at -7 V -> ~12 kohm). No prose copied.

The TIA/EIA-485-A standard itself is paywalled and was **not** accessed;
every "mandate" label in this bundle refers to limits as reproduced in
the two public TI documents above, which are the industry-standard
secondary references for the specification.

## Upstream code repositories consulted

GitHub API search `rs485 calculator` (2026-11-22) returned only
unrelated projects; licenses were checked via
`https://api.github.com/repos/<owner>/<repo>` (`.license.spdx_id`):

| Repository | License (API) | Disposition |
|---|---|---|
| austral-electronics/ThunderballH7 | none (null) | Hardware product, not a bus-budget checker. Not opened, not used. |
| zinuzoid/zCalculator-RS485-Multiprocessor | none (null) | Unrelated calculator. Not opened, not used. |
| Valtoris-Electronics/modbus-rtu-crc16-calculator | MIT | Modbus CRC tool, out of scope. Not used. |

**Zero-copy statement:** no code was copied from any upstream
repository, and no GPL-licensed or unlicensed source was opened or
adapted. All computation code in `scripts/demo.mjs` is original work
written for this bundle from the public application-note methodology.

The bundle layout, report contract (`edaskills.report.v1`), self-test
harness pattern, and CLI conventions follow the in-repo MIT-licensed
template skill `lceda-skills/creepage-clearance-check`, as mandated by
the shared skill contract brief.

## Attempted but unavailable

- Maxim/ADI application tutorials 763 ("Determining Failsafe Bias
  Resistor Values") and 723 — analog.com fetches timed out repeatedly
  on 2026-11-22. Not used; TI SLLA272D section 7 covers the same bias
  divider methodology and was used instead. No values in this bundle
  rely on memory of those documents.

## Original design decisions (declared conventions, not standard text)

- Bias network counted as one series differential path
  (12000/(Rp+Rn) UL) for the 32 UL screen; the stricter per-resistor
  count is reported alongside. Rationale and the TI "up to 20 UL"
  caveat are documented in SKILL.md and standard-tables.md.
- Electrical-length gate for missing termination reuses the stub rule
  tr x v / 10 (extrapolation, labeled guideline).
- Stub marginal band uses the contract-standard 1.2x ratio (chosen
  over a 2x band).
- Speed-vs-length curve implemented as min(1219.2 m, 1.2192e8/baud);
  TI's more conservative length x rate < 1e7 text rule is documented
  but deliberately not enforced (it would flag the 500 m / 100 kbps
  reference design that TI's own headline limits allow).