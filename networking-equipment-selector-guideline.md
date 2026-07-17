# Project Guideline: Networking Equipment Selector

> **Purpose of this document.** This is the standing reference for the project — the *what is the goal* and *what is required* that future chats inherit. It defines scope, principles, and the current stage's working detail. Schema design, data extraction, and implementation happen in dedicated chats; this document is what those chats start from.

---

## 1. Project Purpose

Build a tool that takes networking requirements as input and returns exact, orderable Cisco SKUs — including mandatory licensing, accessories, and compatible modules — with the configuration validated for correctness.

---

## 2. Guiding Principles

These hold across all stages. They are the durable commitments; everything else is detail that arises while building.

1. **Data is interface-agnostic.** The knowledge base (switches, compatibility, constraints) is the durable asset. The web UI, the MCP server, and the agent are all *consumers* of the same data and the same query logic. No interface concern leaks into the data layer.

2. **One solver, flat constraint space, no privileged axis.** *(v1.0.0 note: the constraint space now spans the whole configuration — see §4; "axis" survives as the model-dimension case, and constraints are keyed `{variable, condition, severity}`.)* Every requirement — series, port density, PoE, uplink capability, stacking, licensing regime — is a constraint of the form **`{axis, condition, severity}`** (severity: *hard* eliminates candidates, *soft* ranks survivors). The engine filters on all hard constraints, ranks survivors by soft constraints, and returns a set with a default. "Pick a C9300, then configure it" and "here are my requirements, what fits" are **not two modes** — they are the same query with different axes constrained. Series is just an axis: when the user pins it, it is a hard constraint like any other; when they don't, the surviving switch falls out of the solve. No axis is the root; none is privileged.

3. **Build for update-ability.** Every datasheet-derived fact carries provenance (source link, last-checked date, version). Schema choices favor low-effort updates when Cisco revises a datasheet.

4. **Incremental and validated.** One switch model first, schema proven against reality, then expand model-by-model. The schema and the constraint details are *discovered from real models*, not designed in the abstract.

5. **Route fields by volatility, not by a blanket normalization rule.** Intrinsic, stable facts (port density, PoE budget, physical attributes) are duplicated across model entries — they don't drift, and duplication avoids an inheritance/resolution engine in the data layer. Shared, volatile facts (license catalogs, accessory compatibility) are referenced out to shared tables. This is what "hybrid" concretely means here. Each model is a flat, self-contained entry; there is no inheritance between sibling variants (e.g. `-E` vs `-M`).

---

## 3. Data vs. Solver (the core distinction)

The system has two parts, and keeping them separate is the point of Principle 1 and 2:

- **The data** — static facts in JSON. *"C9300-48P has 48 ports." "Meraki-subscription is valid only on `-M` models." "This uplink module occupies the network-module bay."* Written down, never executed.
- **The solver** — one small, generic piece of code that reads those facts plus a user's requirements and returns the surviving switch set (filter on hard constraints → rank by soft → return set with default).

The discipline: **push everything possible into the data, keep the solver small, dumb, and unchanging.** A well-built solver never needs editing when Cisco ships a new switch — you only add JSON. The failure mode to avoid is expressing a compatibility quirk *as logic* (`if stacking and uplink in [...]: reject`) instead of *as data* (the module declares the slot it needs; the generic solver already checks slot conflicts). Logic hidden in code is also invisible to Stage 2's MCP server and Stage 3's agent, which can only see and reason over what lives in the data.

**One solver, layered front-ends.** The solver has exactly **two direct consumers**: Stage 1's web UI and Stage 2's MCP server. Everything agentic lives *behind* the MCP boundary — Stage 3's reasoning agent does **not** call the solver directly; it is a client of the MCP server, which is the single programmatic query surface. So the chain on the agentic side is `solver → MCP server → agent`, while the web UI sits directly on the solver. All paths resolve requirements over the *same* flat constraint space and differ only in how requirements are gathered. This is why the constraint model is the central asset — build it once correctly and the later stages are new front-ends, not new engines.

*(Open, not a Stage 1 decision: the web UI could later also route through the MCP server, making MCP the canonical query interface and leaving the solver with a single consumer. Worth keeping in view; doesn't change Stage 1.)*

---

## 4. The Decision-Variable Registry & the Query/Response Contract *(current design — registry v1.0.0)*

> Decided 2026-07-17, after the first full KB pass (six families) proved the data model. Supersedes the **Axis Registry** section below (kept as legacy) and re-centres the selector on one contract. The KB files themselves were untouched by this shift — their `configurables`/`groups`/`catalog` blocks already carried the domains and defaults; what changed is how the registry declares them and how the solver answers.

### Everything is a decision variable over configurations

The solver's answer is not a model — it is a **configuration**: model + fitted uplink option + PSU set + license SKUs + cables. Every requirement and every kitlist choice is a **decision variable** in one flat registry list (`DB/switching/switching-axes.json`). The old axis-vs-config-variable wall is gone; whether something "filters models" or "refines the kitlist" is an observed property declared per variable, not a structural class. Per variable the registry declares:

- **dimension** — `model` (value stored on the model entry: the old "axes") or `configuration` (domain **derived** from the KB via a declared **binding**, e.g. `license_term` ← the license group's `choices_years`, `uplink_module` ← the module group's members).
- **eliminates** — whether a hard constraint on it can remove models (`uplink_module` can — a model whose group lacks the pinned module dies; `license_term` never does — it only resolves the SKU).
- **default** — the defaulting rule: `fixed` / `none_option` / `kb_ref` / `policy:<name>` (policy stays code, but it is *named* here and every resolved default carries a `reason` in the response) — or **`must_resolve`: no safe default exists**, a caller must settle it before the BOM is orderable. **License regime, tier, and term are the must_resolve set** — a wrong silent guess is a confidently wrong quote.
- **presentation** — panel group + ask priority: UI layout is registry data, not code.

### The contract (the actual product)

`solve(query, kb, registry) → { candidates, open_variables, eliminated }`. The selector is **stateless and never asks questions** — it answers with *resolved defaults plus honest residual choice*; dialogue is the caller's job:

- **candidates** — ranked surviving configurations; each carries a resolved default BOM (every default with its reason) whose blocks double as the per-candidate choice domains (uplink options, PSU matrix, license groups/terms, cables).
- **open_variables** — the residual decision space: every variable the query left open, with its remaining domain across the survivors, its default, and its `must_resolve` flag. The UI's greyed facets, the MCP server's "remaining parameters", and the agent's "what should I ask next" are all *this one list*.
- **eliminated** — removed models, each with the violated constraint as reason.

Queries are built in one place (`selector/js/core/query.js`): constraint builders, demand translations (PoE "N ports at level L" rows → derived budget/level/count constraints, from the registry's `level_watts`), and validation. The web UI and the future MCP server are equal callers — neither owns query semantics.

### Worked examples (v1 query language)

*"24 PoE+ ports and at least 2×25G, Meraki-driven" — the agent use case:*
```
{ variable: "poe_budget_watts", condition: ">=", value: 720 }        # derived from 24×poe+
{ variable: "poe_type",         condition: ">=", value: "poe+" }     # derived
{ variable: "total_port_count", condition: ">=", value: 24 }         # derived
{ variable: "port_count", where: { speed: "25g" }, condition: ">=", value: 2 }
{ variable: "license_regime",   condition: "in", value: ["meraki-classic", "meraki-subscription"] }
```
→ candidates with resolved BOMs; `open_variables` reports `license_regime` **must_resolve** with domain `{meraki-classic, meraki-subscription}` — the agent's next question, supplied by the response, not hardcoded anywhere.

*Exact-model lookup (datasheet-summary use case):*
```
{ variable: "model_id", condition: "==", value: "C9300-48UXM-E" }
```
→ one candidate; its BOM blocks *are* the option summary (uplink modules, PSUs, licenses, cables).

*Ports are role-agnostic by default:* `where: {speed}` alone means "N ports able to run this speed, any role" — the solver's pool feasibility decides whether access ports or an uplink module supplies them; `role`/`medium` are optional refinements for when the distinction *is* the requirement.

### Consequences

- **One engine feature = three front-end features.** Residual domains power facet greying, MCP parameter narrowing, and agent follow-up questions — the same computation.
- **Cheap vs. expensive change still holds,** now for variables: adding a model is cheap; adding or changing a registry variable is expensive and deliberate (UI + MCP + maybe solver).
- **Single-switch scope.** The contract answers "what is one valid unit". Multi-switch sizing (96 ports → 2×48 + stack) is a future layer *on top of* this contract, never inside it.
- **UX modes are three renderings of the same response** — the contract came first, then the modes cost little. *(Done 2026-07: the web UI ships a mode-choice landing plus `#lookup` (exact-model option tables), `#full` (all facet controls, structured kitlists, raw JSON only behind a button), and `#guided` (step-by-step in the registry's `ask_priority` order, skippable, ending in the pre-filled full view). A question-based conversational mode is deliberately NOT a fourth UI — that is the Stage-3 agent through MCP.)*

---

## Legacy: The Axis Registry *(superseded by §4 above — registry ≤ 0.10.0)*

> **Legacy.** Kept for history. The axis registry became the decision-variable registry: "axes" survive as the model-dimension variables, the separate `config_variables` block was folded into the same list, and the three-roles split (registry = meaning, schema = shape, models = values) carries over unchanged. The strictness argument below still applies word-for-word — it now covers configuration variables too, which under this legacy design were half-declared and invisible to automated callers (the flaw that motivated v1.0.0).

If every requirement is `{axis, condition, severity}`, then the set of legal **axes** must itself be defined and maintained. A user or agent can only constrain on axes the system knows about. The axis registry is the authoritative list of what is filterable, what each constraint means, and what values are legal — and **nothing becomes filterable without being declared here first.**

### Three roles, no overlap
- **The registry enforces *meaning*** — what can be constrained and how.
- **The JSON schema enforces *shape*** — that model entries are well-formed.
- **Model entries supply *values*** — what each switch actually is on each axis.

The registry is the **source**; the schema is a **projection** of it. From a well-defined registry, most of the JSON schema is mechanically derivable (every axis implies a typed, validated field). You cannot go the other way: the schema alone can't say which fields are axes, what conditions each accepts, or what enum values mean to the solver. The registry carries strictly more information, so it is the authoritative artifact and the schema is partly generated from it — not a second thing hand-maintained in parallel.

### What each axis declares
- **name** — `poe_ports`, `uplink_10g`, `license_regime`, `series`, `stacking`
- **type** — integer, boolean, enum, enum-set
- **legal values** (for enums) — e.g. `license_regime ∈ {dna-term, meraki-classic, meraki-subscription, unified}`
- **accepted conditions** — `>=` for numerics, `==` / `in` for enums

### The axis-vs-attribute test
When a datasheet presents a new property, the decision is **not** "add a field" — it is: *is this a new axis (something users filter on) or just an attribute (something we display but never constrain on)?* Port count is an axis. Switch weight is almost certainly an attribute. **Only axes go in the registry; attributes live loose in the model entry.** Treating every spec as filterable bloats the UI and the MCP surface for no benefit.

### Why strictness matters
The registry is a contract with **three consumers that can't see each other**: the UI builds form controls from it, the MCP server builds tool parameters from it, the agent reasons over it. If it drifts — an axis present in data but undeclared, or an enum value used in a model but never registered — the three consumers silently disagree about what's filterable, and the failure mode is the dangerous one: not a crash, but a *wrong switch confidently returned.* Strictness is what keeps three independently-built front-ends honest about one vocabulary.

### Cheap vs. expensive change
This is the practical payoff of the registry. **Adding a new switch is cheap** — more JSON the existing solver already handles. **Adding a new axis is expensive** — the UI needs a new control, the MCP server a new parameter, possibly the solver a new condition type. So model entries grow freely; the registry grows slowly and deliberately. Knowing which side of this line a change falls on is half of "how do we handle the data."

---

## 5. Stages

### Stage 1 — Selector *(current focus)*
Web interface; user selects requirements, the tool proposes a switch with the correct SKU, licensing, and accessories. Optional guided questionnaire. **Pass 1 scope: a single switch family — the C9300**, chosen first because it is the most complex on the hardware side (stacking, network modules, uplink options, dual licensing tracks). If the schema survives the C9300, simpler families follow with little extra work. *(Status 2026-07: exceeded — six families are in the KB (C9200, C9300, C9350, C9500, C9550, Meraki MS) and the schema survived the expansion; pass 1's validation goal is met.)*

### Stage 2 — MCP server
Expose the same selection/validation logic as an MCP tool so an agent can resolve known requirements (e.g. "C9300, 48 PoE, stacking") into exact SKUs. Primarily a **new interface over Stage 1's data and logic**, not a rebuild. Licensing regime and other axes become query parameters the server accepts.

### Stage 3 — Reasoning agent
Natural-language front-end with nuanced judgment (mixed stacks, expected growth, SDA roadmap, cloud vs on-prem). Requires richer data and decision/logic tables in the back-end. Replaces the form with conversation. The agent *infers* requirements and resolves them **by calling the Stage 2 MCP server** — it is a client of that surface, not a direct caller of the solver.

**Expansion path across stages:** switch families → access points → routers → (possibly) collaboration.

---

## 5. Stage 1 — Working Detail

### Objective
A working web selector for the C9300 family that returns a complete, valid, orderable configuration from a set of user requirements.

### Resolved decisions

**Schema is hybrid, by volatility (Principle 5).** Stable intrinsic facts duplicated per model; shared volatile facts (licenses, accessory compatibility) referenced to shared tables. Flat per-model entries, no inheritance.

**Licensing supports multiple regimes via two behavioral *shapes*, not four types.** DNA-term, Meraki-classic, Meraki-subscription, and Unified are four commercial programs but reduce to two structural shapes — **term-based** and **subscription-based** — plus a regime/program tag for labeling. A switch model links to a license *set* (not a single license); the set may span both shapes.

**The `-M` variant is a distinct model with distinct accessories**, modeled as its own flat entry — not a "management-mode toggle" on the base switch. (Cisco sells it as a separate orderable SKU; the data should match reality.) For non-licensing purposes (performance, port density, PoE load) it mirrors the base model, but those facts are simply duplicated per Principle 5.

**A single `-M` model can offer licenses from two regimes simultaneously** (Meraki-classic term *and* Meraki-subscription).

**Licensing regime is a first-class, user-selectable input — not a derived output.** The user chooses term-vs-subscription (and program, where a model offers more than one). Rationale: the decision depends on customer context (existing equipment, existing dashboard) the tool cannot infer in Stage 1. The regime fork must therefore be exposed in the UI as an input axis, and (Stage 2) exposed as an MCP query parameter. In Stage 3 the agent reasons *toward* a regime value and supplies it through that same MCP parameter — same axis, the supplier shifting from the human (Stage 1 UI) to the agent (Stage 3, via MCP). This is a primary Stage-2/3 seam.

**Regime and switch selection mutually constrain each other** — but this needs no special machinery. Under Principle 2 it is simply two hard constraints on the flat plane: choosing subscription-Meraki filters the switch set to `-M` models; choosing a `-E` switch collapses the available regimes to DNA-term. No axis is privileged; the coupling is just data.

### Deferred decision (decide from real C9300 data, not in the abstract)

**Constraint model baseline is flat `{axis, condition, severity}`.** A *possible* extension — **conditional constraints**, where one axis's value changes another axis's valid domain (e.g. a stacking choice narrowing the offered uplink modules) — is explicitly deferred to the model-building phase. Do **not** pre-build it, and do **not** hack around it in code. If the C9300 data surfaces a real coupling, express it as data (the relevant entities declare the shared resource, e.g. a slot, that the generic solver already reconciles) and, if needed, extend the constraint record to reference another axis's value. Decide from real datasheet evidence.

### `{axis, condition, severity}` — worked examples *(legacy syntax — `axis:` became `variable:` in v1.0.0, see §4; the semantics below still hold)*

*"I need 48 PoE ports and 8×10G uplinks":*
```
{ axis: "poe_ports",      condition: ">= 48",  severity: "hard" }   # eliminates
{ axis: "uplink_10g",     condition: ">= 8",   severity: "hard" }   # eliminates → C9200L gone
```
No series named → series falls out of the solve (forces a C9300-class result).

*"I want a C9300, 48 PoE":*
```
{ axis: "series",         condition: "== C9300", severity: "hard" }
{ axis: "poe_ports",      condition: ">= 48",    severity: "hard" }
```
Same solver — series is just one more hard constraint here.

*Soft constraint (ranking the survivors):*
```
{ axis: "list_price",     condition: "minimize", severity: "soft" }  # default = cheapest valid
```
*Regime↔switch coupling, as an ordinary hard constraint:*
```
{ axis: "license_regime", condition: "== meraki-subscription", severity: "hard" }  # non-(-M) models gone
```

### Workstreams
1. **Axis registry** — The authoritative vocabulary of filterable axes (name, type, legal values, accepted conditions). Emerges alongside the first model, applying the axis-vs-attribute test to each datasheet property. The schema (workstream 2) projects from this; the UI and later the MCP server build their inputs from it.
2. **Data model / schema** — Designed against the C9300 first, derived from the registry where possible. Header carries provenance (datasheet URL, last-checked date, version). Body carries SKUs, intrinsic technical attributes, compatibility references, and constraints. Validate the hybrid structure against one real model before generalizing.
3. **Data extraction** — Pull from Cisco datasheets into JSON: SKUs, specs, compatible modules, licensing, accessories. Establish a repeatable per-datasheet extraction routine.
4. **Selection / constraint solver** — The generic engine: requirements → filter on hard → rank by soft → return set with default. Built as a standalone module so Stage 2 can wrap it unchanged.
5. **Web interface** — Options panel and/or guided questionnaire built from the axis registry; proposed configuration with full SKU list (switch + mandatory license + required accessories). A thin layer over the solver.

### Definition of done (Stage 1, pass 1)
- An axis registry covering every filterable dimension the C9300 family exposes.
- The C9300 family fully represented in the hybrid schema, with provenance.
- Selector returns the correct SKU + a valid license (within the user-chosen regime) + required accessories for valid inputs.
- Invalid/incompatible selections (including regime↔switch conflicts) are caught and surfaced.
- The solver module is cleanly separable from the web UI (Stage 2 readiness).

### First concrete step
Pick one C9300 model. Build its JSON entry end to end (header → SKUs → compatibility references → constraints), and **build the axis registry in parallel** — every property the model surfaces gets the axis-vs-attribute test, and every axis it introduces gets declared. Verify the populated entry against the datasheet rather than transcribing it by hand. Use the pair as the reference for the hybrid approach, the flat constraint model, and the registry, before adding the second model. Let the schema details — and any conditional-constraint need — emerge from this.
