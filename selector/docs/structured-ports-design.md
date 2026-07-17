# Structured ports + kind/role — design note (Stage 1)

> **Historical note (pre-v1.0.0 registry).** Option B below was adopted and is live. The
> `role: requirement | config-variable` vocabulary this note introduced was later unified into the
> decision-variable registry (`DB/switching/switching-axes.json` v1.0.0): "axes" became
> model-dimension variables, config-variables became configuration-dimension variables with
> bindings and default rules. See the root guideline §4. Kept unchanged as the design record for
> the port model itself, which still holds.

Concrete shape for the Root-B fix, shown on real models before the 57-model migration.

## Problem, in the current data
| model | current `axis_values` (port part) | issue |
|---|---|---|
| `C9300-48UXM-E` | `total:48, multigig_10g:12` | 36× 1G-copper is **implicit**; "the 12 mGig also do 1G" implicit |
| `C9300-24T-E` | `total:24` (nothing else) | 24× copper RJ-45 has **no descriptor at all** |
| `C9300-24S-E` | `total:24, access_1g_fiber:24` | nearly identical to 24T → **can't ask "copper not fiber"** |
| `C9300X-12Y-E` | `access_1g/10g/25g_fiber:12` | only place subsumption is already declared (overlap) |

Three shapes (`multigig_*`, `access_*_fiber`, look-through `uplink_*`), no `medium`, implicit 1G copper.

## The canonical descriptor
One row per `(role, medium, speed)`, `count` = number of physical ports that **can operate** at that
speed (subsumption declared as overlapping counts — generalising the convention fiber already uses).
`speed` is an **ordered** enum: `100m < 1g < 2.5g < 5g < 10g < 25g < 40g < 100g`.
`role ∈ {access, uplink}`, `medium ∈ {copper, fiber}`. **Access ports live on the model; uplink ports
come from the fitted module (per variant)**, so `model.ports` holds access only.

```jsonc
// C9300-48UXM-E  (36×1G + 12×mGig-10G copper; all 48 do 1G)
"ports": [
  { "role": "access", "medium": "copper", "speed": "1g",   "count": 48 },
  { "role": "access", "medium": "copper", "speed": "2.5g", "count": 12 },
  { "role": "access", "medium": "copper", "speed": "5g",   "count": 12 },
  { "role": "access", "medium": "copper", "speed": "10g",  "count": 12 }
]
// C9300-24T-E — now explicit and distinct from fiber
"ports": [ { "role": "access", "medium": "copper", "speed": "1g", "count": 24 } ]
// C9300-24S-E
"ports": [ { "role": "access", "medium": "fiber", "speed": "1g", "count": 24 } ]
// C9300X-12Y-E  (12× SFP28, 1/10/25)
"ports": [
  { "role": "access", "medium": "fiber", "speed": "1g",  "count": 12 },
  { "role": "access", "medium": "fiber", "speed": "10g", "count": 12 },
  { "role": "access", "medium": "fiber", "speed": "25g", "count": 12 }
]
```
"24 copper data ports, no fiber" → `port_count{access,copper,1g} >= 24` **and** `port_count{access,fiber,*} == 0`.
`total_port_count` stays as its own simple axis (physical port count).

## Two ways to declare this in the registry — the fork

**A) Regularised flat axes.** Keep one named axis per combination, just consistent:
`access_copper_1g`, `access_copper_10g`, `access_fiber_25g`, `uplink_10g`, …
- *Pro:* minimal change to the existing flat-axis solver/UI; smallest blast radius.
- *Con:* still a long, growing list of axes; the "structure" is only a naming convention; the UI/MCP
  surface stays wide; adding a speed adds axes.

**B) One parametrised port axis (recommended).** Registry declares the enums (`role`, `medium`,
ordered `speed`) once and a single `port_count` axis of kind *count-at-level*. A query carries a
selector: `{ axis: "port_count", where: {role, medium, speed}, condition: ">=", value }`.
- *Pro:* kills the three-shapes problem at the root; one consistent mechanism; compact, self-describing
  MCP surface (an agent reasons over `role×medium×speed`, not 15 axis names); adding a speed is data.
- *Con:* the solver gains a selector-match (vs flat key compare); the UI enumerates the
  `(role,medium,speed)` combos present in data to build controls. More up-front engine/UI work.

Both store the **same `ports` array** on models — so the data migration is identical either way; the
fork only changes how the *registry/solver/UI* address it.

## Kind/Role metadata (applies regardless of the fork)
Each axis gains `kind` (`ordered` | `count-at-level` | `monotonic-capability` | `discriminating` |
`numeric`) and `role` (`requirement` | `config-variable`). `poe_type` becomes `ordered`;
`redundant_psu_capable` is dropped (dissolves into the PSU pair); license `tier`/`term` become
`config-variable`. Numeric axes gain `<=`.
