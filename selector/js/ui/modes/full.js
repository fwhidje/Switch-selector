// modes/full.js — the full-option facet mode: every requirement control at
// once, results re-solved on each change. A mountable renderer of the solve()
// contract; accepts an initial draft (the guided mode's handoff) and writes
// its controls from it. model_id is NOT here — exact-model lookup is its own
// mode. Candidate cards are structured kitlists (no JSON in the default view).

import {
  variablesByGroup,
  getVariable,
  storageOf,
  isCountAtLevel,
  acceptedConditions,
  portModel,
} from "../../core/registry.js";
import { getModels } from "../../core/kb.js";
import { solve, facetDomains } from "../../core/solver.js";
import {
  el,
  controlFor,
  readControl,
  writeControl,
  toQuery,
  emptyDraft,
  candidateCard,
  renderOpenVariables,
  poeDemandSection,
  syncDemandRows,
  readDemandRows,
  writeDemandRows,
  row,
  numInput,
} from "../shared.js";

const RENDER_CAP = 20;

// The ports grid and PoE demand rows are demand-GATHERING sections that render
// with their presentation group; the constraints they produce come from
// core/query.js via the shared draft.
const GROUP_SECTIONS = { Interfaces: ["ports"], PoE: ["poeDemand"] };

/** distinct (role, medium, speed) present across model + module port groups */
export function enumeratePortCombos(kb, speedOrder) {
  const set = new Map();
  const add = (g) =>
    (g.speeds ?? []).forEach((sp) =>
      set.set(`${g.role}|${g.medium}|${sp}`, { role: g.role, medium: g.medium, speed: sp }),
    );
  for (const m of getModels(kb)) (m.ports ?? []).forEach(add);
  for (const src of kb._sources ?? [])
    for (const nm of src.catalog?.network_modules ?? []) (nm.ports ?? []).forEach(add);
  const roleRank = { access: 0, uplink: 1 };
  return [...set.values()].sort(
    (a, b) =>
      roleRank[a.role] - roleRank[b.role] ||
      a.medium.localeCompare(b.medium) ||
      speedOrder.indexOf(a.speed) - speedOrder.indexOf(b.speed),
  );
}

/** Role-agnostic per-(medium, speed) rows + an advanced role-pinning grid.
 *  Medium is part of the default ask (matches the guided mode's tiles: copper
 *  vs fiber is a real requirement, access vs uplink falls out of the solve). */
export function portsSection(mediumSpeeds, portCombos) {
  const wrap = el("div", "ports-section");
  wrap.appendChild(el("div", "section-head", "ports — minimum count at speed (any role)"));
  for (const { medium, speed } of mediumSpeeds) {
    const input = numInput("port_count", "min", "0");
    input.dataset.portMedium = medium;
    input.dataset.portSpeed = speed;
    wrap.appendChild(
      row(
        `${medium}/${speed}`,
        "minimum ports of this medium able to run this speed — access or uplink; the solver decides",
        false,
        input,
      ),
    );
  }
  const adv = el("details");
  adv.appendChild(el("summary", "section-head", "advanced: pin role / medium"));
  for (const c of portCombos) {
    const input = numInput("port_count", "min", "0");
    input.dataset.portRole = c.role;
    input.dataset.portMedium = c.medium;
    input.dataset.portSpeed = c.speed;
    adv.appendChild(
      row(
        `${c.role}/${c.medium}/${c.speed}`,
        "minimum ports of this role/medium able to run this speed",
        false,
        input,
      ),
    );
  }
  wrap.appendChild(adv);
  return wrap;
}

export function mount(root, ctx) {
  const { registry, kb } = ctx;
  const speedOrder = portModel(registry)?.selector_enums?.port_speed?.order ?? [];
  const portCombos = enumeratePortCombos(kb, speedOrder);
  const mediumSpeeds = [
    ...new Map(
      portCombos.map((c) => [`${c.medium}|${c.speed}`, { medium: c.medium, speed: c.speed }]),
    ).values(),
  ].sort(
    (a, b) =>
      a.medium.localeCompare(b.medium) || speedOrder.indexOf(a.speed) - speedOrder.indexOf(b.speed),
  );
  const poeLevels = (getVariable(registry, "poe_type")?.order ?? []).filter((l) => l !== "none");
  let showAll = false;

  root.innerHTML = "";
  const left = el("section");
  left.id = "panel-left";
  left.appendChild(el("h2", null, "Constraints"));
  const form = el("form");
  form.id = "controls";
  form.autocomplete = "off";
  left.appendChild(form);

  const right = el("section");
  right.id = "panel-right";
  const head = el("div", "results-head");
  head.appendChild(el("h2", null, "Results"));
  const summary = el("span", "summary");
  summary.id = "summary";
  head.appendChild(summary);
  right.appendChild(head);
  const queryLine = el("p", "query-line");
  queryLine.appendChild(el("strong", null, "query:"));
  queryLine.appendChild(document.createTextNode(" "));
  const querySpan = el("span");
  querySpan.id = "query";
  queryLine.appendChild(querySpan);
  right.appendChild(queryLine);
  const openVars = el("div", "open-variables");
  openVars.id = "open-variables";
  right.appendChild(openVars);
  const candidates = el("div");
  candidates.id = "candidates";
  right.appendChild(candidates);
  const eliminated = el("details");
  eliminated.id = "eliminated";
  right.appendChild(eliminated);

  root.appendChild(left);
  root.appendChild(right);

  // controls from the registry: model-dimension + configuration variables,
  // minus identity (lookup mode's job), parametrised ports, and response-only
  for (const { group, variables } of variablesByGroup(registry)) {
    const details = el("details", "filter-group");
    details.open = true;
    details.appendChild(el("summary", "filter-group-head", group));
    const body = el("div", "filter-group-body");
    for (const v of variables) {
      if (storageOf(v) === "identity" || isCountAtLevel(v)) continue;
      if (acceptedConditions(v).length === 0) continue;
      body.appendChild(controlFor(v, kb));
    }
    for (const section of GROUP_SECTIONS[group] ?? []) {
      if (section === "ports") body.appendChild(portsSection(mediumSpeeds, portCombos));
      if (section === "poeDemand") body.appendChild(poeDemandSection(poeLevels));
    }
    details.appendChild(body);
    form.appendChild(details);
  }

  if (ctx.handoff) {
    writeForm(ctx.handoff);
    ctx.handoff = null;
  }

  form.addEventListener("input", () => {
    showAll = false;
    run();
  });
  form.addEventListener("change", () => {
    showAll = false;
    run();
  });
  run();

  function readDraft() {
    const draft = emptyDraft();
    for (const elm of form.querySelectorAll("[data-variable]:not([data-port-speed])")) {
      const entry = readControl(elm, form);
      if (!entry) continue;
      const name = elm.dataset.variable;
      const prev = draft.scalars[name];
      draft.scalars[name] = prev ? (Array.isArray(prev) ? [...prev, entry] : [prev, entry]) : entry;
    }
    for (const elm of form.querySelectorAll("[data-port-speed]")) {
      const v = Number(elm.value);
      if (!elm.value || v <= 0) continue;
      draft.ports.push({
        role: elm.dataset.portRole,
        medium: elm.dataset.portMedium,
        speed: elm.dataset.portSpeed,
        min: v,
      });
    }
    draft.poeDemand = readDemandRows(form.querySelector("#poe-demand"));
    return draft;
  }

  function writeForm(draft) {
    for (const [name, entry] of Object.entries(draft.scalars)) {
      const entries = Array.isArray(entry) ? entry : [entry];
      for (const one of entries)
        for (const elm of form.querySelectorAll(`[data-variable="${name}"]:not([data-port-speed])`))
          writeControl(elm, one, form);
    }
    for (const p of draft.ports) {
      const sel = p.role
        ? `[data-port-speed="${p.speed}"][data-port-role="${p.role}"][data-port-medium="${p.medium}"]`
        : `[data-port-speed="${p.speed}"][data-port-medium="${p.medium}"]:not([data-port-role])`;
      const elm = form.querySelector(sel);
      if (elm) elm.value = String(p.min);
    }
    if (draft.poeDemand.length)
      writeDemandRows(form.querySelector("#poe-demand"), draft.poeDemand, poeLevels);
  }

  function run() {
    syncDemandRows(form.querySelector("#poe-demand"), poeLevels);
    const query = toQuery(readDraft(), registry);
    const result = solve(query, kb, registry);
    renderQuery(query);
    renderResults(result);
    renderOpenVariables(openVars, result);
    updateFacets(query, result);
  }

  function renderQuery(query) {
    querySpan.textContent = query.length
      ? query
          .map((c) =>
            c.variable === "port_count"
              ? `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} >= ${c.value}`
              : `${c.variable} ${c.condition} ${c.value}`,
          )
          .join("  ·  ")
      : "(no constraints — all models)";
  }

  function renderResults(result) {
    summary.textContent = `${result.candidates.length} match · ${result.eliminated.length} eliminated`;

    candidates.innerHTML = "";
    const shown = showAll ? result.candidates : result.candidates.slice(0, RENDER_CAP);
    shown.forEach((cand, i) => candidates.appendChild(candidateCard(cand, i === 0)));
    if (!showAll && result.candidates.length > RENDER_CAP) {
      const more = el("button", "show-more-btn", `show all ${result.candidates.length} matches`);
      more.type = "button";
      more.addEventListener("click", () => {
        showAll = true;
        run();
      });
      candidates.appendChild(more);
    }

    eliminated.innerHTML = "";
    eliminated.appendChild(el("summary", null, `eliminated (${result.eliminated.length})`));
    const ul = el("ul");
    for (const e of result.eliminated) ul.appendChild(el("li", null, `${e.id} — ${e.reason}`));
    eliminated.appendChild(ul);
  }

  function updateFacets(query, result) {
    const domains = facetDomains(query, kb, registry, result);
    for (const sel of form.querySelectorAll(
      'select[data-kind="enum"], select[data-kind="ordered"]',
    )) {
      const live = domains.get(sel.dataset.variable);
      if (!live) continue;
      let liveCount = 0;
      for (const opt of sel.options) {
        if (opt.value === "") {
          opt.disabled = false;
          continue;
        }
        const ok = live.has(opt.value);
        opt.disabled = !ok;
        if (ok) liveCount++;
      }
      sel.classList.toggle("collapsed", liveCount <= 1);
    }
  }
}
