// modes/guided.js — tile-based step-by-step mode. Walks the decision
// variables in the registry's ask_priority order; every choice is a BUTTON
// (single-choice tiles advance on click; the composite PoE and Ports steps
// use count menus and a Done). Steps with a presentation.depends_on only
// appear once their dependency is answered accordingly (registry data, not
// hardcoded flow). Dead values grey from the residual domain; the
// uplink-module tiles ARE the live residual domain. Ends with the kitlist
// rendered inline (top candidates) plus a button to the full-option view.

import {
  getVariables, getVariable, storageOf, isCountAtLevel, acceptedConditions,
  mustResolve, dependsOn, legalValues, portModel,
} from "../../core/registry.js";
import { solve, facetDomains } from "../../core/solver.js";
import { el, badge, toQuery, emptyDraft, candidateCard } from "../shared.js";
import { enumeratePortCombos } from "./full.js";

const POE_FOLD = new Set(["poe_capable", "poe_type", "poe_budget_watts"]);
const PORT_FOLD = new Set(["total_port_count", "port_count"]);
const POE_PRESETS = [24, 48];
const COPPER_PRESETS = [8, 12, 24, 48];
const FIBER_PRESETS = [2, 4, 8];
const FINALE_CARDS = 3;

export function mount(root, ctx) {
  const { registry, kb } = ctx;
  const speedOrder = portModel(registry)?.selector_enums?.port_speed?.order ?? [];
  const bySpeed = (a, b) => speedOrder.indexOf(a) - speedOrder.indexOf(b);
  const combos = enumeratePortCombos(kb, speedOrder);
  const copperSpeeds = [...new Set(combos.filter((c) => c.medium === "copper").map((c) => c.speed))].sort(bySpeed);
  const fiberSpeeds = [...new Set(combos.filter((c) => c.medium === "fiber").map((c) => c.speed))].sort(bySpeed);
  const mgigSpeeds = copperSpeeds.filter((s) => s !== "1g");
  const poeLevels = (getVariable(registry, "poe_type")?.order ?? []).filter((l) => l !== "none");

  const draft = emptyDraft();
  let currentKey = null;
  let subState = {}; // per-step transient view state (count menus, sub-views)

  // --- step definitions (static; visibility is evaluated per render) --------
  const stepDefs = buildStepDefs();
  function buildStepDefs() {
    const vars = getVariables(registry)
      .filter((v) => storageOf(v) !== "identity" && acceptedConditions(v).length > 0)
      .sort((a, b) => (a.presentation?.ask_priority ?? 999) - (b.presentation?.ask_priority ?? 999));
    const defs = [];
    let poeDone = false, portsDone = false;
    for (const v of vars) {
      if (POE_FOLD.has(v.name)) {
        if (!poeDone) { defs.push({ key: "poe", kind: "poe", title: "PoE" }); poeDone = true; }
        continue;
      }
      if (PORT_FOLD.has(v.name) || isCountAtLevel(v)) {
        if (!portsDone) { defs.push({ key: "ports", kind: "ports", title: "Ports" }); portsDone = true; }
        continue;
      }
      defs.push({ key: v.name, kind: "variable", title: v.name, v });
    }
    defs.push({ key: "summary", kind: "summary", title: "Result" });
    return defs;
  }

  const pinnedValue = (name) => {
    const e = draft.scalars[name];
    const one = Array.isArray(e) ? e[0] : e;
    return one && one.condition === "==" ? one.value : undefined;
  };
  function depSatisfied(dep) {
    const val = pinnedValue(dep.variable);
    if (val === undefined) return false;
    return dep.value === "any" ? true : val === dep.value;
  }
  const stepVisible = (s) => {
    if (s.kind !== "variable") return true;
    const dep = dependsOn(s.v);
    return !dep || depSatisfied(dep);
  };
  const stepKeys = () => stepDefs.filter(stepVisible).map((s) => s.key);

  function advance() {
    subState = {};
    const k = stepKeys();
    const i = k.indexOf(currentKey);
    currentKey = k[Math.min(i + 1, k.length - 1)] ?? k[0];
    renderStep();
  }
  function goBack() {
    subState = {};
    const k = stepKeys();
    const i = k.indexOf(currentKey);
    currentKey = k[Math.max(i - 1, 0)] ?? k[0];
    renderStep();
  }

  // --- tiles ------------------------------------------------------------------
  function tile(label, opts, onClick) {
    const b = el("button", "tile" +
      (opts?.selected ? " selected" : "") +
      (opts?.configured ? " configured" : "") +
      (opts?.muted ? " muted" : ""));
    b.type = "button";
    if (opts?.dead) b.disabled = true;
    b.appendChild(el("span", "tile-label", label));
    if (opts?.sub) b.appendChild(el("span", "tile-sub", opts.sub));
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function countMenu(title, presets, current, onPick, onCancel) {
    const wrap = el("div", "count-menu");
    wrap.appendChild(el("p", "step-notes", title));
    const grid = el("div", "tile-grid");
    for (const n of presets) grid.appendChild(tile(`${n}`, { selected: current === n }, () => onPick(n)));
    wrap.appendChild(grid);
    const custom = el("div", "count-custom");
    const input = el("input");
    input.type = "number"; input.min = "1"; input.placeholder = "custom count";
    if (current && !presets.includes(current)) input.value = String(current);
    const pick = () => { const n = Number(input.value); if (n > 0) onPick(n); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pick(); } });
    const ok = el("button", "primary", "OK");
    ok.type = "button";
    ok.addEventListener("click", pick);
    const cancel = el("button", null, "cancel");
    cancel.type = "button";
    cancel.addEventListener("click", onCancel);
    custom.append(input, ok, cancel);
    wrap.appendChild(custom);
    setTimeout(() => input.focus(), 0);
    return wrap;
  }

  // --- shell ------------------------------------------------------------------
  root.innerHTML = "";
  const wrap = el("section", "guided-mode");
  root.appendChild(wrap);
  currentKey = stepKeys()[0];
  renderStep();

  function matchCount() {
    return solve(toQuery(draft, registry), kb, registry).candidates.length;
  }

  function answeredChips() {
    const parts = [];
    for (const [name, entry] of Object.entries(draft.scalars)) {
      const list = Array.isArray(entry) ? entry : [entry];
      for (const one of list) parts.push(`${name} ${one.condition} ${one.value}`);
    }
    for (const p of draft.ports) parts.push(`${[p.medium, p.speed].filter(Boolean).join(" ")} × ${p.min}`);
    for (const d of draft.poeDemand) parts.push(`${d.count}× ${d.level}`);
    return parts;
  }

  function renderStep() {
    wrap.innerHTML = "";
    const defs = stepDefs.filter(stepVisible);
    const step = defs.find((s) => s.key === currentKey) ?? defs[0];
    currentKey = step.key;
    const panel = el("div", "step-panel");

    const head = el("div", "step-head");
    head.appendChild(el("span", "step-progress",
      `step ${defs.indexOf(step) + 1} / ${defs.length}`));
    const h = el("h2", null, step.title);
    if (step.kind === "variable" && mustResolve(step.v)) h.appendChild(badge());
    head.appendChild(h);
    panel.appendChild(head);

    const chips = answeredChips();
    if (chips.length) {
      const line = el("div", "step-answers");
      line.appendChild(el("span", "kit-alts-label", "so far:"));
      for (const c of chips) line.appendChild(el("span", "kit-alt", c));
      panel.appendChild(line);
    }

    const body = el("div", "step-body");
    panel.appendChild(body);

    if (step.kind !== "summary") {
      const n = matchCount();
      const status = el("p", "step-status", `${n} model${n === 1 ? "" : "s"} still match`);
      status.classList.toggle("dead-end", n === 0);
      panel.appendChild(status);
    }

    const nav = el("div", "step-nav");
    const backBtn = el("button", null, "← back");
    backBtn.type = "button";
    backBtn.disabled = defs.indexOf(step) === 0;
    backBtn.addEventListener("click", goBack);
    nav.appendChild(backBtn);

    switch (step.kind) {
      case "variable": renderVariableStep(step.v, body, nav); break;
      case "poe": renderPoeStep(body, nav); break;
      case "ports": renderPortsStep(body, nav); break;
      case "summary": renderFinale(body); break;
    }
    panel.appendChild(nav);
    wrap.appendChild(panel);
  }

  function dontCareTile(names, extraClear) {
    return tile("don't care", { muted: true }, () => {
      for (const n of names) delete draft.scalars[n];
      extraClear?.();
      advance();
    });
  }

  // --- variable step: value tiles, click = pin + advance ---------------------
  function renderVariableStep(v, body, nav) {
    if (v.notes) body.appendChild(el("p", "step-notes", v.notes.split(". ").slice(0, 2).join(". ") + "."));
    const grid = el("div", "tile-grid");
    const current = pinnedValue(v.name);

    // residual domain: what can still be picked given everything else
    const rest = structuredClone(draft);
    delete rest.scalars[v.name];
    const domains = facetDomains(toQuery(rest, registry), kb, registry);
    const live = domains.get(v.name);

    let values, labelOf = (x) => String(x);
    if (v.type === "boolean") {
      values = v.kind === "discriminating" ? [true, false] : [true];
      labelOf = (x) => (x ? "Yes" : "No");
      if (v.name === "uplink_modular") labelOf = (x) => (x ? "Yes — modular uplinks" : "No — fixed uplinks");
    } else if (legalValues(v).length) {
      values = legalValues(v);
      if (v.type === "integer") labelOf = (x) => `${x} yr`;
    } else {
      // open enum (uplink_module, cables): the live residual domain IS the tile set
      values = [...(live ?? [])].sort();
    }

    const liveVals = values.filter((x) => !live || live.has(x));
    for (const x of values) {
      const dead = live ? !live.has(x) : false;
      grid.appendChild(tile(labelOf(x), { selected: current === x, dead }, () => {
        draft.scalars[v.name] = { condition: "==", value: x };
        advance();
      }));
    }
    grid.appendChild(dontCareTile([v.name]));
    body.appendChild(grid);
    if (liveVals.length === 1)
      body.appendChild(el("p", "step-notes determined", `only one possibility for the current matches: ${labelOf(liveVals[0])}`));
    if (values.length === 0)
      body.appendChild(el("p", "step-notes determined", "no options for the current matches — use don't care"));
    void nav;
  }

  // --- PoE step: level tiles -> count menu; None; Done ------------------------
  function renderPoeStep(body, nav) {
    if (subState.poeMenu) {
      const level = subState.poeMenu;
      const existing = draft.poeDemand.find((d) => d.level === level);
      body.appendChild(countMenu(`How many ${level} ports?`, POE_PRESETS, existing?.count,
        (n) => {
          draft.poeDemand = draft.poeDemand.filter((d) => d.level !== level);
          draft.poeDemand.push({ count: n, level });
          delete draft.scalars.poe_capable; // configuring PoE overrides an earlier "None"
          subState = {};
          renderStep();
        },
        () => { subState = {}; renderStep(); }));
      return;
    }
    body.appendChild(el("p", "step-notes",
      "Pick a PoE level to state how many ports need it (mixed levels allowed — sizes the PSU). None = explicitly no PoE (cheaper non-PoE switch)."));
    const grid = el("div", "tile-grid");
    const noPoe = pinnedValue("poe_capable") === false;
    grid.appendChild(tile("None", { selected: noPoe, sub: "no PoE needed" }, () => {
      draft.poeDemand = [];
      draft.scalars.poe_capable = { condition: "==", value: false };
      advance();
    }));
    for (const level of poeLevels) {
      const d = draft.poeDemand.find((x) => x.level === level);
      grid.appendChild(tile(level, { configured: !!d, sub: d ? `${d.count} ports` : "click to set ports" },
        () => { subState = { poeMenu: level }; renderStep(); }));
    }
    grid.appendChild(dontCareTile(["poe_capable"], () => { draft.poeDemand = []; }));
    body.appendChild(grid);
    const done = el("button", "primary", "done →");
    done.type = "button";
    done.addEventListener("click", advance);
    nav.appendChild(done);
  }

  // --- Ports step: categories -> (speed tiles) -> count menu; Done ------------
  const upsertPort = (medium, speed, min) => {
    draft.ports = draft.ports.filter((p) => !(p.medium === medium && p.speed === speed));
    draft.ports.push({ medium, speed, min });
  };
  const portCount = (medium, speed) => draft.ports.find((p) => p.medium === medium && p.speed === speed)?.min;

  function renderPortsStep(body, nav) {
    if (subState.portMenu) {
      const { medium, speed, presets, backTo } = subState.portMenu;
      body.appendChild(countMenu(`How many ${medium} ports able to run ${speed}?`, presets, portCount(medium, speed),
        (n) => { upsertPort(medium, speed, n); subState = { portView: backTo }; renderStep(); },
        () => { subState = { portView: backTo }; renderStep(); }));
      return;
    }

    const view = subState.portView ?? "categories";
    const speedTiles = (speeds, medium, presets, backTo) => {
      const grid = el("div", "tile-grid");
      for (const s of speeds) {
        const n = portCount(medium, s);
        grid.appendChild(tile(s, { configured: n != null, sub: n != null ? `${n} ports` : "click to set ports" },
          () => { subState = { portMenu: { medium, speed: s, presets, backTo } }; renderStep(); }));
      }
      return grid;
    };

    if (view === "mgig" || view === "fiber") {
      const medium = view === "mgig" ? "copper" : "fiber";
      body.appendChild(el("p", "step-notes", view === "mgig"
        ? "Multigigabit copper — pick the speed(s) you need, set a port count per speed."
        : "Fiber — pick the speed(s) you need, set a port count per speed (access or uplink; the solver decides)."));
      body.appendChild(speedTiles(view === "mgig" ? mgigSpeeds : fiberSpeeds, medium,
        view === "mgig" ? COPPER_PRESETS : FIBER_PRESETS, view));
      const done = el("button", "primary", "done →");
      done.type = "button";
      done.addEventListener("click", () => { subState = {}; renderStep(); });
      nav.appendChild(done);
      return;
    }

    body.appendChild(el("p", "step-notes",
      "What port types do you need? Counts are minimums; access vs uplink falls out of the solve."));
    const grid = el("div", "tile-grid");
    const g1 = portCount("copper", "1g");
    grid.appendChild(tile("1G Copper", { configured: g1 != null, sub: g1 != null ? `${g1} ports` : "standard access ports" },
      () => { subState = { portMenu: { medium: "copper", speed: "1g", presets: COPPER_PRESETS, backTo: "categories" } }; renderStep(); }));
    const mgigConf = mgigSpeeds.map((s) => [s, portCount("copper", s)]).filter(([, n]) => n != null);
    grid.appendChild(tile("MGig", {
      configured: mgigConf.length > 0,
      sub: mgigConf.length ? mgigConf.map(([s, n]) => `${s}: ${n}`).join(" · ") : `copper ${mgigSpeeds.join("/")}`,
    }, () => { subState = { portView: "mgig" }; renderStep(); }));
    const fiberConf = fiberSpeeds.map((s) => [s, portCount("fiber", s)]).filter(([, n]) => n != null);
    grid.appendChild(tile("Fiber", {
      configured: fiberConf.length > 0,
      sub: fiberConf.length ? fiberConf.map(([s, n]) => `${s}: ${n}`).join(" · ") : "access or uplink optics",
    }, () => { subState = { portView: "fiber" }; renderStep(); }));
    grid.appendChild(tile("don't care", { muted: true }, () => { draft.ports = []; advance(); }));
    body.appendChild(grid);
    const done = el("button", "primary", "done →");
    done.type = "button";
    done.addEventListener("click", advance);
    nav.appendChild(done);
  }

  // --- finale: kitlist inline + hand-off button --------------------------------
  function renderFinale(body) {
    const query = toQuery(draft, registry);
    const result = solve(query, kb, registry);
    const n = result.candidates.length;
    body.appendChild(el("p", "step-status", `${n} model${n === 1 ? "" : "s"} match your requirements`));
    const open = result.open_variables.filter((o) => o.must_resolve);
    if (open.length)
      body.appendChild(el("p", "step-notes",
        "Still to resolve for an orderable BOM: " + open.map((o) => o.name).join(", ") + "."));

    const shown = result.candidates.slice(0, FINALE_CARDS);
    const cards = el("div", "finale-cards");
    shown.forEach((cand, i) => cards.appendChild(candidateCard(cand, i === 0)));
    body.appendChild(cards);
    if (n > FINALE_CARDS)
      body.appendChild(el("p", "step-notes", `showing the top ${FINALE_CARDS} of ${n} — the full view has them all.`));

    const go = el("button", "primary", "open in full options →");
    go.type = "button";
    go.addEventListener("click", () => {
      ctx.handoff = structuredClone(draft);
      location.hash = "#full";
    });
    body.appendChild(go);
  }
}
