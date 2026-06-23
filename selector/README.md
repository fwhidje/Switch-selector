# C9300 Selector (Stage 1, pass 1)

A first, basic implementation of the Networking Equipment Selector for the Cisco
Catalyst 9300 family: a small **pure solver** plus a **basic facet UI** over it.
All vanilla JavaScript (ES modules), **no build step** — it runs as static files
and deploys to GitHub Pages as-is.

## Run it

The app fetches the knowledge base over HTTP, so it needs a server (not `file://`):

```bash
# from the repository root
python3 -m http.server
# then open http://localhost:8000/selector/
```

On GitHub Pages, enable Pages for the repo and visit `…/selector/`.

## How it's organised

The discipline (per the project guideline): the **solver core is pure** — no DOM,
no I/O inside the engine — so the *same* core can back a Stage-2 MCP server later
with only a thin wrapper. The **axis registry is the single source**, projected
into both the UI controls and the internal query vocabulary.

```
js/core/   pure, importable engine (no DOM)
  registry.js  accessors over ../C9300/switching-axes.json (the filterable vocabulary)
  kb.js        load + id-index ../C9300/c9300_knowledge_base.json (catalog, groups, models)
  resolve.js   generic capability resolution (uplink look-through, PoE matrix) + kitlist
  solver.js    solve(query, kb, registry) -> { candidates, default, eliminated }
js/ui/
  app.js       the only DOM module: builds controls from the registry, calls solve()
```

## What the solver does (and deliberately does not)

- It **filters** all models on the query's hard constraints, **ranks** survivors,
  and returns the set with a default — entirely generically, by axis type. No
  per-switch logic lives in code; a new switch is new JSON.
- A query is a list of `{ axis, condition, value, severity }`. The facet UI emits
  all-`hard` constraints; `>=` for integers, `==` for booleans/enums.
- `uplink_*` axes are never stored on a switch — they resolve by look-through into
  the referenced network-module group's `uplink_capacity` (or the inline block on
  fixed-uplink models). That's why they're still filterable.
- Output per candidate is the **resolved kitlist**: switch + PSU group / PoE matrix
  + uplink module options + the license group(s) for the chosen regime + accessories.

Out of scope here (upper-layer or later): the guided flow, an MCP server, license
**tier** selection (essentials/advantage is shown, never picked), price-based
ranking (no price data yet — the default order is a documented stub), and
TypeScript.
