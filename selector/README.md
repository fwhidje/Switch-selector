# C9300 Selector

A pure, generic **constraint solver** plus a **basic facet UI** for the Cisco Catalyst 9300 family.
Vanilla JavaScript (ES modules), **no build step** — runs as static files and deploys to GitHub
Pages as-is. The solver core is DOM-free and IO-free so a future MCP server can reuse it unchanged.

## Run it

```bash
# from the repository root (needs HTTP, not file://)
python3 -m http.server
# then open http://localhost:8000/selector/
```

## Validate the data

The three knowledge files are a projection chain — **registry → schema → KB**. The validator is the
mechanical guard that keeps them consistent:

```bash
cd selector && npm run validate          # node tools/validate-kb.mjs
```

It runs in CI (`.github/workflows/validate-kb.yml`) on every push/PR.

## Layout

```
js/core/   pure, importable engine (no DOM)
  registry.js  accessors over ../C9300/switching-axes.json (the filterable vocabulary + kind/role)
  kb.js        load + id-index ../C9300/c9300_knowledge_base.json (catalog, groups, models)
  resolve.js   port pools, configured variants, pool-feasibility (max-flow), and the resolved BOM
  solver.js    solve(query, kb, registry) -> { candidates, default, eliminated }; availableValues()
tools/
  validate-kb.mjs   registry/schema/KB consistency validator
js/ui/
  app.js       the only DOM module: builds controls from the registry, calls solve(), renders kits
```

## The model (registry v0.4.0)

- **One narrowing engine over _configured variants_.** A variant = a model with one fitted uplink
  option. Filtering and configuring are the same narrowing; survivors carry a resolved kitlist.
- **Unified ports.** Capability is data: `model.ports` (role=access) + the fitted module's `ports`
  (role=uplink) form a variant's pool. Each port group is `{count, role, medium, speeds[]}`;
  subsumption is the speed set (a 25G SFP28 port lists `[1g,10g,25g]`). The parametrised
  **`port_count`** axis counts ports whose `speeds[]` include a requested speed, and simultaneous
  multi-speed demand is checked for **pool feasibility** against the shared physical ports (so "2×25
  and 2×10" on an 8-port module passes, but "8×25 and 8×10" — 16 ports — fails).
- **Axis metadata.** Every axis declares a `kind` (`ordered` | `count-at-level` |
  `monotonic-capability` | `discriminating` | `numeric` | `boolean`) and a `role` (`requirement` |
  `config-variable`). The UI builds controls from this: ordered `poe_type` gets an *at-least / exactly*
  toggle; numerics get min/max; monotonic capabilities get *required / any*; enums get value pickers
  with **dead options disabled** (and single-value axes collapsed) via `availableValues()`.
- **License tier is a filter; term is a config-variable.** `license_tier` is a stored enum-set of the
  tiers a model offers (mirrors `license_regime`): choosing *advantage* drops DNA `-E`, keeps `-A` and
  Meraki `-M`, and the kitlist resolves the advantage SKU. `license_term` and `psu_redundancy` are
  `config_variables` — they refine the kitlist without eliminating models.
- **Configurator defaults.** Each model ships a single `default_primary` PSU (from Cisco's default-PSU
  table; `-M` uses its sole valid primary). To meet a higher PoE load the configurator **adds a
  secondary** and upsizes the primary only when no secondary covers it; `psu_redundancy` forces a pair.
  Stack/stackpower cables default to the group `none_option` (shortest cable if one is taken). These
  default/preference rules live in the configurator (`resolve.js`), not in the KB or the agent.
- **No per-switch logic.** A new switch is new JSON.

## Out of scope (deferred)

QSFP/SFP breakout (a future configurable with its own cable SKU); pricing and price-based ranking
(the default order is a deterministic stub); the MCP server; the natural-language guided agent;
non-C9300 families.
