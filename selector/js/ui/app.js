// app.js — basic facet UI over the variant solver. The only DOM module.
//
// Controls are generated from the registry by axis KIND (ordered enums get an
// at-least/exactly toggle; numerics get min/max; monotonic capabilities get
// required/any; discriminating get full choices). The parametrised port_count
// axis becomes a "Ports" grid of min inputs over the (role,medium,speed) combos
// present in the data. Every change re-solves; dead facet values are disabled.

import { loadRegistry, getAxes, legalValues, portModel, configVariables, poeLevelWatts } from "../core/registry.js";
import { loadKBs, getModels } from "../core/kb.js";
import { solve, availableValues } from "../core/solver.js";

const REGISTRY_URL = "../DB/switching/switching-axes.json";
const FAMILIES_URL = "../DB/switching/families.json";

let registry = null;
let kb = null;
let speedOrder = [];
let portCombos = []; // [{role, medium, speed}]
let levelWatts = {}; // { poe: 15.4, "poe+": 30, ... }
let poeLevels = []; // ordered PoE levels excluding 'none'

const GROUPS = [
  { id: "series",    label: "Series",
    axes: ["series"] },
  { id: "interfaces", label: "Interfaces",
    axes: ["total_port_count", "uplink_modular"],
    ports: true },
  { id: "poe",       label: "PoE",
    axes: ["poe_capable", "poe_type", "poe_budget_watts"],
    poeDemand: true },
  { id: "stacking",  label: "Stacking / StackPower / PSU",
    axes: ["stacking_capable", "stacking_technology", "stackpower_capable"],
    configVars: ["psu_redundancy", "psu_triple"] },
  { id: "licensing", label: "Licensing",
    axes: ["license_regime", "license_tier"],
    configVars: ["license_term"] },
];

async function init() {
  const status = document.getElementById("status");
  try {
    const familiesRes = await fetch(FAMILIES_URL);
    if (!familiesRes.ok) throw new Error(`families fetch failed: ${familiesRes.status} ${FAMILIES_URL}`);
    const families = await familiesRes.json();
    const kbUrls = families.map((f) => `../DB/switching/${f.dir}/${f.kbFile}`);
    [registry, kb] = await Promise.all([loadRegistry(REGISTRY_URL), loadKBs(kbUrls)]);
    speedOrder = portModel(registry)?.selector_enums?.port_speed?.order ?? [];
    portCombos = enumeratePortCombos(kb);
    levelWatts = poeLevelWatts(registry);
    poeLevels = (getAxes(registry).find((a) => a.name === "poe_type")?.order ?? []).filter((l) => l !== "none");
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

// --- build controls ---------------------------------------------------------
function buildControls() {
  const form = document.getElementById("controls");
  form.innerHTML = "";
  const axesByName = new Map(getAxes(registry).map((a) => [a.name, a]));
  const cvs = configVariables(registry);

  for (const group of GROUPS) {
    const details = document.createElement("details");
    details.open = true;
    details.className = "filter-group";

    const summary = document.createElement("summary");
    summary.className = "filter-group-head";
    summary.textContent = group.label;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "filter-group-body";

    for (const axisName of group.axes) {
      const axis = axesByName.get(axisName);
      if (axis) body.appendChild(controlFor(axis));
    }
    if (group.ports) body.appendChild(portsSection());
    if (group.poeDemand) body.appendChild(poeDemandSection());
    if (group.configVars?.length) {
      let subHead = null;
      for (const cvName of group.configVars) {
        const def = cvs[cvName];
        if (!def) continue;
        if (!subHead) {
          subHead = document.createElement("div");
          subHead.className = "section-head";
          subHead.textContent = "configuration";
          body.appendChild(subHead);
        }
        let kind, opts;
        if (def.type === "boolean") {
          kind = "config-bool"; opts = [["", "any"], ["true", "required"]];
        } else if (def.type === "integer") {
          kind = "config-int"; opts = [["", "any"], ...(def.legal_values ?? []).map((v) => [String(v), String(v)])];
        } else {
          kind = "config-enum"; opts = [["", "any"], ...(def.legal_values ?? []).map((v) => [String(v), String(v)])];
        }
        body.appendChild(row(cvName, def.notes, select(cvName, kind, opts)));
      }
    }

    details.appendChild(body);
    form.appendChild(details);
  }

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

// PoE demand: a dynamic list of {count, level} rows. Translates to derived
// hard constraints (budget = Σ count×watts, poe_type ≥ max level, total_port_count
// ≥ Σ count). Filling the last row spawns a fresh blank one.
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
    } else if (el.dataset.kind === "config-bool") {
      q.push({ axis, condition: "==", value: true, severity: "config" }); // never filters
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
  // PoE demand rows -> derived hard constraints (budget, level, port count)
  const demand = [];
  for (const r of document.querySelectorAll("#poe-demand .demand-row")) {
    const c = Number(r.querySelector("[data-demand-count]").value) || 0;
    const l = r.querySelector("[data-demand-level]").value;
    if (c > 0 && l) demand.push({ count: c, level: l });
  }
  if (demand.length) {
    const watts = demand.reduce((s, d) => s + d.count * (levelWatts[d.level] ?? 0), 0);
    const totalPorts = demand.reduce((s, d) => s + d.count, 0);
    const maxLevel = demand.map((d) => d.level).sort((a, b) => poeLevels.indexOf(b) - poeLevels.indexOf(a))[0];
    q.push({ axis: "poe_budget_watts", condition: ">=", value: Math.ceil(watts), severity: "hard" });
    q.push({ axis: "poe_type", condition: ">=", value: maxLevel, severity: "hard" });
    // every PoE port is an access port, so PoE-port demand maps to total_port_count
    q.push({ axis: "total_port_count", condition: ">=", value: totalPorts, severity: "hard" });
  }
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
