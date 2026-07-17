// app.js — facet UI over the query/response contract. The only DOM module.
//
// A thin RENDERER of the solver contract: controls are generated from the
// registry (panel layout from presentation metadata, control type from KIND;
// must_resolve variables carry a badge), every change re-solves, facet values
// are greyed from the residual domains, and the response's open_variables are
// rendered as the "still open" strip. Query construction (incl. the PoE
// demand translation) lives in core/query.js — this file only reads the form.

import {
  loadRegistry, getVariable, legalValues, variablesByGroup, mustResolve,
  isConfigurationDimension, binding, storageOf, isCountAtLevel, acceptedConditions,
} from "../core/registry.js";
import { loadKBs, getModels } from "../core/kb.js";
import { solve, facetDomains } from "../core/solver.js";
import { constraint, portConstraint, translatePoeDemand } from "../core/query.js";

const REGISTRY_URL = "../DB/switching/switching-axes.json";
const FAMILIES_URL = "../DB/switching/families.json";

let registry = null;
let kb = null;
let speedOrder = [];
let portCombos = []; // [{role, medium, speed}] present in the data (advanced grid)
let portSpeeds = []; // distinct speeds present (role-agnostic default rows)
let poeLevels = []; // ordered PoE levels excluding 'none'

// Special demand sections keyed by the registry's presentation group: the
// ports grid and the PoE demand rows are UI-side GATHERING for constraints
// core/query.js derives — they belong with their group but are not variables.
const GROUP_SECTIONS = { "Interfaces": ["ports"], "PoE": ["poeDemand"] };

async function init() {
  const status = document.getElementById("status");
  try {
    const familiesRes = await fetch(FAMILIES_URL);
    if (!familiesRes.ok) throw new Error(`families fetch failed: ${familiesRes.status} ${FAMILIES_URL}`);
    const families = await familiesRes.json();
    const kbUrls = families.map((f) => `../DB/switching/${f.dir}/${f.kbFile}`);
    [registry, kb] = await Promise.all([loadRegistry(REGISTRY_URL), loadKBs(kbUrls)]);
    speedOrder = registry.port_model?.selector_enums?.port_speed?.order ?? [];
    portCombos = enumeratePortCombos(kb);
    portSpeeds = [...new Set(portCombos.map((c) => c.speed))]
      .sort((a, b) => speedOrder.indexOf(a) - speedOrder.indexOf(b));
    poeLevels = (getVariable(registry, "poe_type")?.order ?? []).filter((l) => l !== "none");
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
  for (const src of kb._sources ?? [])
    for (const nm of src.catalog?.network_modules ?? []) (nm.ports ?? []).forEach(add);
  const roleRank = { access: 0, uplink: 1 };
  return [...set.values()].sort((a, b) =>
    (roleRank[a.role] - roleRank[b.role]) || a.medium.localeCompare(b.medium) ||
    (speedOrder.indexOf(a.speed) - speedOrder.indexOf(b.speed)));
}

// open-enum domains gathered from the data (datalist suggestions)
function knownValues(variable) {
  if (storageOf(variable) === "identity") return getModels(kb).map((m) => m.id);
  const src = binding(variable)?.source;
  const out = new Set();
  for (const s of kb._sources ?? []) {
    if (src === "network_module_group") for (const nm of s.catalog?.network_modules ?? []) out.add(nm.id);
    if (src === "stack_cable_group") for (const c of s.catalog?.stack_cables ?? []) out.add(c.id);
    if (src === "stackpower_cable_group") for (const c of s.catalog?.stackpower_cables ?? []) out.add(c.id);
  }
  return [...out].sort();
}

// --- build controls ---------------------------------------------------------
function buildControls() {
  const form = document.getElementById("controls");
  form.innerHTML = "";

  for (const { group, variables } of variablesByGroup(registry)) {
    const details = document.createElement("details");
    details.open = true;
    details.className = "filter-group";

    const summary = document.createElement("summary");
    summary.className = "filter-group-head";
    summary.textContent = group;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "filter-group-body";

    for (const v of variables) {
      if (isCountAtLevel(v)) continue; // gathered by the ports section below
      if (acceptedConditions(v).length === 0) continue; // psu_config: response-only
      const control = controlFor(v);
      if (control) body.appendChild(control);
    }
    for (const section of GROUP_SECTIONS[group] ?? []) {
      if (section === "ports") body.appendChild(portsSection());
      if (section === "poeDemand") body.appendChild(poeDemandSection());
    }

    details.appendChild(body);
    form.appendChild(details);
  }

  form.addEventListener("input", run);
  form.addEventListener("change", run);
}

function row(labelText, title, badge, ...controls) {
  const wrap = document.createElement("label");
  wrap.className = "control";
  const name = document.createElement("span");
  name.className = "axis-name";
  name.textContent = labelText;
  if (title) name.title = title;
  if (badge) {
    const b = document.createElement("span");
    b.className = "must-resolve";
    b.textContent = "must resolve";
    b.title = "No safe default exists — settle this before the BOM is orderable.";
    name.appendChild(b);
  }
  wrap.appendChild(name);
  const box = document.createElement("span");
  box.className = "control-inputs";
  controls.forEach((c) => box.appendChild(c));
  wrap.appendChild(box);
  return wrap;
}

function controlFor(v) {
  const badge = mustResolve(v);
  // ordered enum (poe_type): value select + at-least/exactly toggle
  if (v.kind === "ordered") {
    const sel = select(v.name, "ordered", [["", "any"], ...legalValues(v).map((x) => [x, x])]);
    const cond = document.createElement("select");
    cond.dataset.condFor = v.name;
    cond.className = "cond";
    for (const [val, t] of [[">=", "at least"], ["==", "exactly"]]) {
      const o = document.createElement("option"); o.value = val; o.textContent = t; cond.appendChild(o);
    }
    return row(v.name, v.notes, badge, sel, cond);
  }
  if (v.type === "integer" && legalValues(v).length === 0) {
    return row(v.name, v.notes, badge, numInput(v.name, "min", "min"), numInput(v.name, "max", "max"));
  }
  if (v.type === "integer") { // closed integer choice (license_term)
    return row(v.name, v.notes, badge,
      select(v.name, "int-enum", [["", "any"], ...legalValues(v).map((x) => [String(x), String(x)])]));
  }
  if (v.type === "boolean") {
    const opts = v.kind === "monotonic-capability" || isConfigurationDimension(v)
      ? [["", "any"], ["true", "required"]]
      : [["", "any"], ["true", "yes"], ["false", "no"]];
    return row(v.name, v.notes, badge, select(v.name, "boolean", opts));
  }
  // open enum (model_id, uplink_module, cables): free input + datalist of known SKUs
  if (legalValues(v).length === 0) {
    return row(v.name, v.notes, badge, skuInput(v));
  }
  // discriminating closed enum (series, stacking_technology, license_regime, license_tier)
  return row(v.name, v.notes, badge, select(v.name, "enum", [["", "any"], ...legalValues(v).map((x) => [x, x])]));
}

function skuInput(v) {
  const el = document.createElement("input");
  el.type = "text";
  el.placeholder = "any";
  el.dataset.variable = v.name;
  el.dataset.kind = "sku";
  const listId = `known-${v.name}`;
  el.setAttribute("list", listId);
  const dl = document.createElement("datalist");
  dl.id = listId;
  for (const x of knownValues(v)) {
    const o = document.createElement("option"); o.value = x; dl.appendChild(o);
  }
  const wrap = document.createElement("span");
  wrap.appendChild(el); wrap.appendChild(dl);
  return wrap;
}

// Ports: role-agnostic by default ("N ports able to run speed S", any role) —
// the solver's pool feasibility decides access vs uplink. The advanced grid
// pins role/medium for the cases where the distinction is the requirement.
function portsSection() {
  const wrap = document.createElement("div");
  wrap.className = "ports-section";
  const h = document.createElement("div");
  h.className = "section-head";
  h.textContent = "ports — minimum count at speed (any role)";
  wrap.appendChild(h);
  for (const speed of portSpeeds) {
    const el = numInput("port_count", "min", "0");
    el.dataset.portSpeed = speed;
    wrap.appendChild(row(speed, "minimum ports able to run this speed — access or uplink; the solver decides", false, el));
  }
  const adv = document.createElement("details");
  const s = document.createElement("summary");
  s.className = "section-head";
  s.textContent = "advanced: pin role / medium";
  adv.appendChild(s);
  for (const c of portCombos) {
    const el = numInput("port_count", "min", "0");
    el.dataset.portRole = c.role; el.dataset.portMedium = c.medium; el.dataset.portSpeed = c.speed;
    adv.appendChild(row(`${c.role}/${c.medium}/${c.speed}`, "minimum ports of this role/medium able to run this speed", false, el));
  }
  wrap.appendChild(adv);
  return wrap;
}

// PoE demand: a dynamic list of {count, level} rows. core/query.js translates
// them to derived hard constraints. Filling the last row spawns a blank one.
function poeDemandSection() {
  const wrap = document.createElement("div");
  wrap.className = "demand-section";
  const h = document.createElement("div");
  h.className = "section-head";
  h.textContent = "PoE demand — ports at level (sizes the PSU)";
  wrap.appendChild(h);
  const list = document.createElement("div");
  list.id = "poe-demand";
  list.appendChild(demandRow());
  wrap.appendChild(list);
  return wrap;
}

function demandRow() {
  const r = document.createElement("label");
  r.className = "control demand-row";
  const name = document.createElement("span");
  name.className = "axis-name";
  name.textContent = "ports @";
  const box = document.createElement("span");
  box.className = "control-inputs";
  const cnt = document.createElement("input");
  cnt.type = "number"; cnt.min = "0"; cnt.placeholder = "count"; cnt.dataset.demandCount = "1";
  const lvl = document.createElement("select");
  lvl.dataset.demandLevel = "1";
  for (const [v, t] of [["", "level…"], ...poeLevels.map((x) => [x, x])]) {
    const o = document.createElement("option"); o.value = v; o.textContent = t; lvl.appendChild(o);
  }
  box.appendChild(cnt); box.appendChild(lvl);
  r.appendChild(name); r.appendChild(box);
  return r;
}

// Append a fresh blank row once the last row is filled.
function syncDemandRows() {
  const list = document.getElementById("poe-demand");
  if (!list || !list.lastElementChild) return;
  const last = list.lastElementChild;
  const cnt = Number(last.querySelector("[data-demand-count]").value) || 0;
  const lvl = last.querySelector("[data-demand-level]").value;
  if (cnt > 0 && lvl) list.appendChild(demandRow());
}

function numInput(variable, bound, placeholder) {
  const el = document.createElement("input");
  el.type = "number"; el.min = "0"; el.placeholder = placeholder;
  el.dataset.variable = variable; el.dataset.kind = "integer"; el.dataset.bound = bound;
  return el;
}
function select(variable, kind, optionPairs) {
  const el = document.createElement("select");
  el.dataset.variable = variable; el.dataset.kind = kind;
  for (const [value, label] of optionPairs) {
    const o = document.createElement("option"); o.value = value; o.textContent = label; el.appendChild(o);
  }
  return el;
}

// --- read query -------------------------------------------------------------
function readQuery() {
  const q = [];
  // scalar controls
  for (const el of document.querySelectorAll('#controls [data-variable]:not([data-port-speed])')) {
    const raw = el.value;
    if (raw === "" || raw == null) continue;
    const name = el.dataset.variable;
    if (el.dataset.kind === "integer") {
      q.push(constraint(name, el.dataset.bound === "max" ? "<=" : ">=", Number(raw)));
    } else if (el.dataset.kind === "int-enum") {
      q.push(constraint(name, "==", Number(raw)));
    } else if (el.dataset.kind === "boolean") {
      q.push(constraint(name, "==", raw === "true"));
    } else if (el.dataset.kind === "ordered") {
      const cond = document.querySelector(`#controls [data-cond-for="${name}"]`)?.value ?? ">=";
      q.push(constraint(name, cond, raw));
    } else { // enum + sku
      q.push(constraint(name, "==", raw));
    }
  }
  // port controls (role-agnostic rows carry only data-port-speed)
  for (const el of document.querySelectorAll("#controls [data-port-speed]")) {
    const v = Number(el.value);
    if (!el.value || v <= 0) continue;
    const where = { speed: el.dataset.portSpeed };
    if (el.dataset.portRole) where.role = el.dataset.portRole;
    if (el.dataset.portMedium) where.medium = el.dataset.portMedium;
    q.push(portConstraint(where, ">=", v));
  }
  // PoE demand rows -> derived hard constraints (budget, level, port count)
  const demand = [];
  for (const r of document.querySelectorAll("#poe-demand .demand-row")) {
    const count = Number(r.querySelector("[data-demand-count]").value) || 0;
    const level = r.querySelector("[data-demand-level]").value;
    if (count > 0 && level) demand.push({ count, level });
  }
  q.push(...translatePoeDemand(demand, registry));
  return q;
}

// --- run + render -----------------------------------------------------------
function run() {
  if (!registry || !kb) return;
  syncDemandRows();
  const query = readQuery();
  const result = solve(query, kb, registry);
  renderQuery(query);
  renderResults(result);
  renderOpenVariables(result);
  updateFacets(query, result);
}

function renderQuery(query) {
  const el = document.getElementById("query");
  el.textContent = query.length
    ? query.map((c) => c.variable === "port_count"
        ? `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} >= ${c.value}`
        : `${c.variable} ${c.condition} ${c.value}`).join("  ·  ")
    : "(no constraints — all models)";
}

// The contract's residual decision space, rendered as the "still open" strip.
function renderOpenVariables(result) {
  const el = document.getElementById("open-variables");
  if (!el) return;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "section-head";
  head.textContent = "still open (residual choice)";
  el.appendChild(head);
  const ul = document.createElement("ul");
  for (const ov of result.open_variables) {
    const li = document.createElement("li");
    const domain = Array.isArray(ov.domain)
      ? (ov.domain.length > 8 ? `${ov.domain.slice(0, 8).join(", ")}, … (${ov.domain.length})` : ov.domain.join(", "))
      : ov.domain ? `${ov.domain.min}–${ov.domain.max}` : "—";
    const dflt = ov.must_resolve ? "" : ov.default
      ? `  · default: ${ov.default.kind === "fixed" ? ov.default.value : ov.default.policy ?? ov.default.kind}` : "";
    li.textContent = `${ov.name}: {${domain}}${dflt}`;
    if (ov.must_resolve) {
      const b = document.createElement("span");
      b.className = "must-resolve";
      b.textContent = "must resolve";
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

// grey enum values whose residual domain is empty given the rest of the query
function updateFacets(query, result) {
  const domains = facetDomains(query, kb, registry, result);
  for (const sel of document.querySelectorAll('#controls select[data-kind="enum"], #controls select[data-kind="ordered"]')) {
    const live = domains.get(sel.dataset.variable);
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
  const r = cand.bom;
  const card = document.createElement("article");
  card.className = "candidate" + (isDefault ? " default" : "");

  const h = document.createElement("h3");
  h.textContent = cand.model.id + (isDefault ? "  ★ default" : "");
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-bom-btn";
  copyBtn.textContent = "copy BOM";
  copyBtn.addEventListener("click", () => {
    const text = buildCopyBOM(r);
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = "copied!";
      setTimeout(() => { copyBtn.textContent = "copy BOM"; }, 1500);
    }).catch(() => {
      const fb = document.createElement("pre");
      fb.className = "copy-bom-fallback";
      fb.textContent = text;
      copyBtn.after(fb);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(fb);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  });
  card.appendChild(h);
  card.appendChild(copyBtn);
  const desc = document.createElement("p");
  desc.className = "desc";
  desc.textContent = cand.model.description;
  card.appendChild(desc);

  const kit = document.createElement("ul");
  kit.className = "kit";
  // uplinks — show the real orderable SKU (moduleId), mode as a separate label;
  // r.uplinks.default is the internal `${moduleId}#${mode}` id used for option matching only.
  const upOpt = r.uplinks.options.find((o) => o.id === r.uplinks.default);
  const upLabel = upOpt?.moduleId ? `${upOpt.moduleId}${upOpt.mode ? ` (mode: ${upOpt.mode})` : ""}` : "(none)";
  const up = r.uplinks.modular
    ? `uplink module: ${upLabel} default`
    : `fixed uplinks: ${summarisePorts(r.uplinks.options[0]?.ports)}`;
  kit.appendChild(li(up));
  // power — resolved default PSU (single by default; secondary added to meet load)
  if (r.power) {
    const dc = r.power.default_config;
    if (!dc) {
      kit.appendChild(li("PSU: no configuration meets the requested PoE load"));
    } else {
      const sec = dc.secondary ? ` + ${dc.secondary}` : " (single)";
      const watts = dc.watts != null ? ` · ${dc.watts}W` : "";
      kit.appendChild(li(`PSU default: ${dc.primary}${sec}${watts} — ${dc.reason}`));
    }
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
  // accessories — cables default to 'none' (standalone), shortest if taken
  const a = r.accessories;
  const acc = [];
  if (a.stack_cables) acc.push(`stack-cable: ${a.stack_cables.default} default (shortest ${a.stack_cables.shortest})`);
  if (a.stackpower_cables) acc.push(`stackpower-cable: ${a.stackpower_cables.default} default (shortest ${a.stackpower_cables.shortest})`);
  if (a.ssd_accessory) acc.push("ssd");
  if (acc.length) kit.appendChild(li(`accessories: ${acc.join(" · ")}`));
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

function buildCopyBOM(r) {
  const lines = [r.switch.id];
  if (r.uplinks.modular) {
    const opt = r.uplinks.options.find((o) => o.id === r.uplinks.default);
    if (opt?.moduleId) lines.push(opt.moduleId);
  }
  const dc = r.power?.default_config;
  if (dc) {
    if (dc.primary && dc.primary !== r.power.default_primary) lines.push(dc.primary);
    if (dc.secondary) lines.push(dc.secondary);
  }
  const a = r.accessories ?? {};
  if (a.stack_cables && a.stack_cables.default !== a.stack_cables.none_option) {
    if (a.stack_cables.stack_kit) lines.push(a.stack_cables.stack_kit);
    lines.push(a.stack_cables.default);
  }
  if (a.stackpower_cables && a.stackpower_cables.default !== a.stackpower_cables.none_option)
    lines.push(a.stackpower_cables.default);
  for (const g of r.license?.groups ?? []) {
    if (g.perpetual_member) lines.push(g.perpetual_member);
    if (g.chosen_term?.subscription_sku) lines.push(g.chosen_term.subscription_sku);
  }
  return lines.join("\n");
}

const li = (t) => { const e = document.createElement("li"); e.textContent = t; return e; };
const summarisePorts = (ports) => (ports ?? []).map((p) => `${p.count}x ${p.medium} ${p.speeds.join("/")}`).join(", ") || "—";

init();
