# Knowledge base — things to complete

Tracks fields in the switching KBs that are **not yet sourced from authoritative
Cisco documentation**. Each is flagged in the data via a model's `_incomplete`
array and surfaced by `selector/tools/validate-kb.mjs` as a WARNING (the build
stays green; warnings are not failures). Remove an item here and from the
model's `_incomplete` once the value is confirmed.

## C9350 (`DB/switching/C9350/c9350_knowledge_base.json`)

These three models appear in the **datasheet** (Table 6) but are **not in the
ordering guide**, and some PoE/PSU facts are absent from both. No values were
invented; placeholders are clearly marked in-file.

| Model | Field(s) | Why incomplete | Where to source |
|---|---|---|---|
| `C9350-48HM` | `poe_budget_matrix`, `default_primary` | 48HM is absent from datasheet **Table 9** (PoE budget per PSU), and not in the ordering guide. Only the headline `poe_budget_watts` (4320W) is sourced (48HM datasheet page). `poe_budget_matrix` is left empty; `valid_primary`/`default_primary` are placeholders. | CCW (Cisco Commerce) PoE/PSU config, or a future datasheet revision that adds 48HM to Table 9. |
| `C9350-24Y` | `default_primary` | 24Y (non-PoE fiber) is not in the ordering guide; its default PSU is not stated. `default_primary` (and `valid_primary`) are placeholders (`PWR-C2-500WAC-I`). | CCW default-PSU for 24Y. |
| `C9350-12Y` | `default_primary` | 12Y (non-PoE fiber) is not in the ordering guide; its default PSU is not stated. `default_primary` (and `valid_primary`) are placeholders (`PWR-C2-500WAC-I`). | CCW default-PSU for 12Y. |

### Notes
- The other 12 C9350 models are fully datasheet/OG-sourced (ports, PoE budget +
  per-PSU matrix from Table 9, default PSU from OG Table 1).
- `C9350-48HM`'s `valid_primary` is set to `[850W, 1600W]` by analogy to the
  other 90W UPOE+ models pending confirmation — treat as unconfirmed until the
  CCW values land.
- Display-only attributes that the datasheet omits for some SKUs (e.g.
  `mtbf_hours` for several models) are simply left off; they are not filterable
  and are not tracked as `_incomplete`.

## MS130 (`DB/switching/MS/ms_knowledge_base.json`)

All 11 MS130 models (`8`/`8P`/`8P-I`/`8X`/`12X`/`24`/`24P`/`24X`/`48`/`48P`/`48X`)
flag `_incomplete: ["power_supply_watts"]`. The pasted MS130 datasheet excerpts give
no PSU/power-adapter part number or nameplate wattage rating anywhere — only
`Power Input` (voltage × current) and `Power Load (idle/max)`, which is the switch's
own consumption, not the supply's rated capacity. Per confirmed user direction, each
model's synthetic catalog PSU (`<model>-PSU-SYN`, e.g. `MS130-8P-PSU-SYN`) uses that
model's own stated Power Load (max) as a conservative proxy for `watts`.

| Field | Why incomplete | Where to source |
|---|---|---|
| `power_supply_watts` (all 11 models) | No PSU/adapter part number or nameplate wattage disclosed in the datasheet excerpts provided. | An accessories/ordering-guide-style table with real PSU/adapter SKUs and rated wattages (not the main spec-sheet table used for this pass). |

### Notes
- These switches have no separate orderable PSU at all (fixed external adapter or
  fixed internal supply, no bay, no redundancy) — the synthetic catalog entries
  exist only so the standard `configurables.power_supplies` shape applies (same
  convention as the C9200CX fixed/internal PSU placeholders).
- No stacking on MS130 (confirmed: no stacking row anywhere in the datasheet
  excerpts); `stacking_capable`/`stackpower_capable` are `false` and fully sourced,
  not tracked here.

## How to verify
`node selector/tools/validate-kb.mjs` — prints an `INCOMPLETE` warning block
listing every flagged field, then `PASS` (exit 0) when no hard violations remain.
