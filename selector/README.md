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
- **No per-switch logic.** A new switch is new JSON. License **tier/term** are shown but never picked
  (upper-layer concern); the kitlist surfaces the matching license group(s) for the chosen regime.

## Out of scope (deferred)

QSFP/SFP breakout (a future configurable with its own cable SKU); pricing and price-based ranking
(the default order is a deterministic stub); collapsing `redundant_psu_capable` into the PSU pair;
the MCP server; the natural-language guided agent; non-C9300 families.
