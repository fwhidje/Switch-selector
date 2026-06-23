// app.js — basic facet UI over the variant solver. The only DOM module.
//
// Controls are generated from the registry by axis KIND (ordered enums get an
// at-least/exactly toggle; numerics get min/max; monotonic capabilities get
// required/any; discriminating get full choices). The parametrised port_count
// axis becomes a "Ports" grid of min inputs over the (role,medium,speed) combos
// present in the data. Every change re-solves; dead facet values are disabled.

import { loadRegistry, getAxes, legalValues, portModel, configVariables } from "../core/registry.js";
import { loadKB, getModels } from "../core/kb.js";
import { solve, availableValues } from "../core/solver.js";

const REGISTRY_URL = "../C9300/switching-axes.json";
const KB_URL = "../C9300/c9300_knowledge_base.json";

let registry = null;
let kb = null;
let speedOrder = [];
let portCombos = []; // [{role, medium, speed}]

async function init() {
  const status = document.getElementById("status");
  try {
    [registry, kb] = await Promise.all([loadRegistry(REGISTRY_URL), loadKB(KB_URL)]);
    speedOrder = portModel(registry)?.selector_enums?.port_speed?.order ?? [];
    portCombos = enumeratePortCombos(kb);
    status.textContent = `Loaded ${kb.models.length} models · registry v${registry.registry_version}`;
    buildControls();
    run();
  } catch (err) {
    status.textContent = `Failed to load data: ${err.message}`;
    status.classList.add("error");
  }
}

// distinct (role, medium, speed) present across model + module port groups
function enumeratePortCombos(kb) {
  const set = new Map();
  const add = (g) => (g.speeds ?? []).forEach((sp) => set.set(`${g.role}|${g.medium}|${sp}`, { role: g.role, medium: g.medium, speed: sp }));
  for (const m of getModels(kb)) (m.ports ?? []).forEach(add);
  for (const nm of kb.catalog?.network_modules ?? []) (nm.ports ?? []).forEach(add);
  const roleRank = { access: 0, uplink: 1 };
  return [...set.values()].sort((a, b) =>
    (roleRank[a.role] - roleRank[b.role]) || a.medium.localeCompare(b.medium) ||
    (speedOrder.indexOf(a.speed) - speedOrder.indexOf(b.speed)));
}

// --- build controls ---------------------------------------------------------
function buildControls() {
  const form = document.getElementById("controls");
  form.innerHTML = "";
  for (const axis of getAxes(registry)) {
    if (axis.name === "port_count") continue; // handled in the ports grid
    form.appendChild(controlFor(axis));
  }
  form.appendChild(portsSection());
  form.appendChild(configSection());
  form.addEventListener("input", run);
  form.addEventListener("change", run);
}

function row(labelText, title, ...controls) {
  const wrap = document.createElement("label");
  wrap.className = "control";
  const name = document.createElement("span");
  name.className = "axis-name";
  name.textContent = labelText;
  if (title) name.title = title;
  wrap.appendChild(name);
  const box = document.createElement("span");
  box.className = "control-inputs";
  controls.forEach((c) => box.appendChild(c));
  wrap.appendChild(box);
  return wrap;
}

function controlFor(axis) {
  // ordered enum (poe_type): value select + at-least/exactly toggle
  if (axis.kind === "ordered") {
    const sel = select(axis.name, "ordered", [["", "any"], ...legalValues(axis).map((v) => [v, v])]);
    const cond = document.createElement("select");
    cond.dataset.condFor = axis.name;
    cond.className = "cond";
    for (const [v, t] of [[">=", "at least"], ["==", "exactly"]]) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; cond.appendChild(o);
    }
    return row(axis.name, axis.notes, sel, cond);
  }
  if (axis.type === "integer") {
    return row(axis.name, axis.notes, numInput(axis.name, "min", "min"), numInput(axis.name, "max", "max"));
  }
  if (axis.type === "boolean") {
    const opts = axis.kind === "monotonic-capability"
      ? [["", "any"], ["true", "required"]]
      : [["", "any"], ["true", "yes"], ["false", "no"]];
    return row(axis.name, axis.notes, select(axis.name, "boolean", opts));
  }
  // discriminating enum (series, stacking_technology, license_regime)
  return row(axis.name, axis.notes, select(axis.name, "enum", [["", "any"], ...legalValues(axis).map((v) => [v, v])]));
}

function portsSection() {
  const wrap = document.createElement("div");
  wrap.className = "ports-section";
  const h = document.createElement("div");
  h.className = "section-head";
  h.textContent = "ports — minimum count at speed";
  wrap.appendChild(h);
  for (const c of portCombos) {
    const el = numInput("port_count", "min", "0");
    el.dataset.portRole = c.role; el.dataset.portMedium = c.medium; el.dataset.portSpeed = c.speed;
    wrap.appendChild(row(`${c.role}/${c.medium}/${c.speed}`, "minimum ports able to run this speed", el));
  }
  return wrap;
}

// config-variables (license tier/term): refine the kitlist, never filter
function configSection() {
  const wrap = document.createElement("div");
  wrap.className = "ports-section";
  const h = document.createElement("div");
  h.className = "section-head";
  h.textContent = "configuration — refines kitlist, does not filter";
  wrap.appendChild(h);
  const cvs = configVariables(registry);
  for (const [name, def] of Object.entries(cvs)) {
    if (name === "_comment") continue;
    const opts = [["", "any"], ...(def.legal_values ?? []).map((v) => [String(v), String(v)])];
    const sel = select(name, def.type === "integer" ? "config-int" : "config-enum", opts);
    wrap.appendChild(row(name, def.notes, sel));
  }
  return wrap;
}

function numInput(axis, bound, placeholder) {
  const el = document.createElement("input");
  el.type = "number"; el.min = "0"; el.placeholder = placeholder;
  el.dataset.axis = axis; el.dataset.kind = "integer"; el.dataset.bound = bound;
  return el;
}
function select(axis, kind, optionPairs) {
  const el = document.createElement("select");
  el.dataset.axis = axis; el.dataset.kind = kind;
  for (const [value, label] of optionPairs) {
    const o = document.createElement("option"); o.value = value; o.textContent = label; el.appendChild(o);
  }
  return el;
}

// --- read query -------------------------------------------------------------
function readQuery() {
  const q = [];
  // scalar controls
  for (const el of document.querySelectorAll('#controls [data-axis]:not([data-port-speed])')) {
    const raw = el.value;
    if (raw === "" || raw == null) continue;
    const axis = el.dataset.axis;
    if (el.dataset.kind === "integer") {
      q.push({ axis, condition: el.dataset.bound === "max" ? "<=" : ">=", value: Number(raw), severity: "hard" });
    } else if (el.dataset.kind === "boolean") {
      q.push({ axis, condition: "==", value: raw === "true", severity: "hard" });
    } else if (el.dataset.kind === "ordered") {
      const cond = document.querySelector(`#controls [data-cond-for="${axis}"]`)?.value ?? ">=";
      q.push({ axis, condition: cond, value: raw, severity: "hard" });
    } else if (el.dataset.kind === "config-int") {
      q.push({ axis, condition: "==", value: Number(raw), severity: "config" }); // never filters
    } else if (el.dataset.kind === "config-enum") {
      q.push({ axis, condition: "==", value: raw, severity: "config" }); // never filters
    } else {
      q.push({ axis, condition: "==", value: raw, severity: "hard" });
    }
  }
  // port controls
  for (const el of document.querySelectorAll("#controls [data-port-speed]")) {
    const v = Number(el.value);
    if (!el.value || v <= 0) continue;
    q.push({
      axis: "port_count",
      where: { role: el.dataset.portRole, medium: el.dataset.portMedium, speed: el.dataset.portSpeed },
      condition: ">=", value: v, severity: "hard",
    });
  }
  return q;
}

// --- run + render -----------------------------------------------------------
function run() {
  if (!registry || !kb) return;
  const query = readQuery();
  const result = solve(query, kb, registry);
  renderQuery(query);
  renderResults(result);
  updateFacets(query);
}

function renderQuery(query) {
  const el = document.getElementById("query");
  el.textContent = query.length
    ? query.map((c) => c.axis === "port_count"
        ? `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} >= ${c.value}`
        : `${c.axis} ${c.condition} ${c.value}`).join("  ·  ")
    : "(no constraints — all models)";
}

// disable enum values that would dead-end given the rest of the query
function updateFacets(query) {
  for (const sel of document.querySelectorAll('#controls select[data-kind="enum"], #controls select[data-kind="ordered"]')) {
    const axis = sel.dataset.axis;
    const live = availableValues(query, axis, kb, registry);
    if (!live) continue;
    let liveCount = 0;
    for (const opt of sel.options) {
      if (opt.value === "") { opt.disabled = false; continue; }
      const ok = live.has(opt.value);
      opt.disabled = !ok;
      if (ok) liveCount++;
    }
    sel.classList.toggle("collapsed", liveCount <= 1);
  }
}

function renderResults(result) {
  document.getElementById("summary").textContent =
    `${result.candidates.length} match · ${result.eliminated.length} eliminated`;

  const list = document.getElementById("candidates");
  list.innerHTML = "";
  result.candidates.forEach((cand, i) => list.appendChild(renderCandidate(cand, i === 0)));

  const elim = document.getElementById("eliminated");
  elim.innerHTML = "";
  const sum = document.createElement("summary");
  sum.textContent = `eliminated (${result.eliminated.length})`;
  elim.appendChild(sum);
  const ul = document.createElement("ul");
  for (const e of result.eliminated) {
    const li = document.createElement("li");
    li.textContent = `${e.id} — ${e.reason}`;
    ul.appendChild(li);
  }
  elim.appendChild(ul);
}

function renderCandidate(cand, isDefault) {
  const r = cand.resolved;
  const card = document.createElement("article");
  card.className = "candidate" + (isDefault ? " default" : "");

  const h = document.createElement("h3");
  h.textContent = cand.model.id + (isDefault ? "  ★ default" : "");
  card.appendChild(h);
  const desc = document.createElement("p");
  desc.className = "desc";
  desc.textContent = cand.model.description;
  card.appendChild(desc);

  const kit = document.createElement("ul");
  kit.className = "kit";
  // uplinks
  const up = r.uplinks.modular
    ? `uplink modules: ${r.uplinks.options.filter((o) => o.moduleId).map((o) => o.id).join(", ") || "(none valid)"}`
    : `fixed uplinks: ${summarisePorts(r.uplinks.options[0]?.ports)}`;
  kit.appendChild(li(up));
  // power — single vs redundant PSU options (redundancy is a config choice now)
  if (r.power) {
    const budget = r.power.meets_requested_budget === null ? "" : r.power.meets_requested_budget ? " · meets budget" : " · CANNOT meet budget";
    const single = r.power.single_options.length;
    const red = r.power.redundant_options.length;
    kit.appendChild(li(`PSU: ${single} single + ${red} redundant pair(s)${r.power.redundant_capable ? "" : " (no redundancy)"}${budget}`));
  }
  // license — resolved per chosen tier/term where applicable
  if (r.license) {
    const tierNote = r.license.tier_selectable ? "tier selectable" : `tier ${r.license.tier_locked ?? "?"}`;
    const groups = r.license.groups.map((g) => {
      const term = g.chosen_term
        ? (g.chosen_term.subscription_sku
            ? ` → ${g.chosen_term.subscription_sku}${g.chosen_term.not_applicable ? " (term n/a)" : ""}`
            : ` (no ${g.chosen_term.term_years}yr SKU)`)
        : ` [${g.term_choices_years.join("/") || "—"}yr]`;
      return `${g.tier}/${g.regime}${term}`;
    }).join("; ");
    kit.appendChild(li(`license (${tierNote}): ${groups || "(none for chosen regime)"}`));
  }
  // accessories
  const acc = [];
  if (r.accessories.stack_cables) acc.push("stack-cables");
  if (r.accessories.stackpower_cables) acc.push("stackpower-cables");
  if (r.accessories.ssd_accessory) acc.push("ssd");
  if (acc.length) kit.appendChild(li(`accessories: ${acc.join(", ")}`));
  card.appendChild(kit);

  // raw BOM
  const details = document.createElement("details");
  const s = document.createElement("summary");
  s.textContent = "raw kitlist";
  const pre = document.createElement("pre");
  pre.className = "bundle";
  pre.textContent = JSON.stringify(r, null, 2);
  details.appendChild(s); details.appendChild(pre);
  card.appendChild(details);
  return card;
}

const li = (t) => { const e = document.createElement("li"); e.textContent = t; return e; };
const summarisePorts = (ports) => (ports ?? []).map((p) => `${p.count}x ${p.medium} ${p.speeds.join("/")}`).join(", ") || "—";

init();
