// app.js — the basic (non-guided) facet UI. The ONLY module that touches the DOM.
//
// It builds one control per registry axis on the left, assembles a query from the
// non-empty controls, calls the pure solve() on every change, and renders the
// surviving candidates + kitlists (and a "why others dropped" trace) on the right.
// All selection logic lives in core/; this file is a thin, replaceable shell.

import { loadRegistry, getAxes, legalValues } from "../core/registry.js";
import { loadKB } from "../core/kb.js";
import { solve } from "../core/solver.js";

// Data lives one level up from /selector/, in /C9300/. Relative paths keep this
// working as static files on GitHub Pages with no build step.
const REGISTRY_URL = "../C9300/switching-axes.json";
const KB_URL = "../C9300/c9300_knowledge_base.json";

let registry = null;
let kb = null;

async function init() {
  const status = document.getElementById("status");
  try {
    [registry, kb] = await Promise.all([loadRegistry(REGISTRY_URL), loadKB(KB_URL)]);
    status.textContent = `Loaded ${kb.models.length} models · registry v${registry.registry_version}`;
    buildControls();
    run();
  } catch (err) {
    status.textContent = `Failed to load data: ${err.message}`;
    status.classList.add("error");
  }
}

// --- left panel: one control per axis, projected from the registry ------------

function buildControls() {
  const form = document.getElementById("controls");
  form.innerHTML = "";
  for (const axis of getAxes(registry)) {
    form.appendChild(controlFor(axis));
  }
  form.addEventListener("input", run);
  form.addEventListener("change", run);
}

function controlFor(axis) {
  const wrap = document.createElement("label");
  wrap.className = "control";
  const name = document.createElement("span");
  name.className = "axis-name";
  name.textContent = axis.name;
  if (axis.notes) name.title = axis.notes;
  wrap.appendChild(name);
  wrap.appendChild(inputFor(axis));
  return wrap;
}

function inputFor(axis) {
  if (axis.type === "integer") {
    const el = document.createElement("input");
    el.type = "number";
    el.min = "0";
    el.placeholder = "min…";
    el.dataset.axis = axis.name;
    el.dataset.kind = "integer";
    return el;
  }
  if (axis.type === "boolean") {
    return select(axis.name, "boolean", [
      ["", "any"],
      ["true", "yes"],
      ["false", "no"],
    ]);
  }
  // enum (and enum-set, queried as a single == pick in this basic UI)
  const opts = [["", "any"], ...legalValues(axis).map((v) => [v, v])];
  return select(axis.name, "enum", opts);
}

function select(axisName, kind, optionPairs) {
  const el = document.createElement("select");
  el.dataset.axis = axisName;
  el.dataset.kind = kind;
  for (const [value, label] of optionPairs) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    el.appendChild(o);
  }
  return el;
}

// --- assemble the query from the controls -------------------------------------

function readQuery() {
  const query = [];
  for (const el of document.querySelectorAll("#controls [data-axis]")) {
    const raw = el.value;
    if (raw === "" || raw == null) continue; // unconstrained
    const axis = el.dataset.axis;
    switch (el.dataset.kind) {
      case "integer":
        query.push({ axis, condition: ">=", value: Number(raw), severity: "hard" });
        break;
      case "boolean":
        query.push({ axis, condition: "==", value: raw === "true", severity: "hard" });
        break;
      default: // enum
        query.push({ axis, condition: "==", value: raw, severity: "hard" });
    }
  }
  return query;
}

// --- run + render -------------------------------------------------------------

function run() {
  if (!registry || !kb) return;
  const query = readQuery();
  const result = solve(query, kb, registry);
  renderQuery(query);
  renderResults(result);
}

function renderQuery(query) {
  const el = document.getElementById("query");
  el.textContent = query.length
    ? query.map((c) => `${c.axis} ${c.condition} ${c.value}`).join("  ·  ")
    : "(no constraints — all models)";
}

function renderResults(result) {
  const summary = document.getElementById("summary");
  summary.textContent = `${result.candidates.length} match · ${result.eliminated.length} eliminated`;

  const list = document.getElementById("candidates");
  list.innerHTML = "";
  result.candidates.forEach((cand, i) => {
    list.appendChild(renderCandidate(cand, i === 0));
  });

  renderEliminated(result.eliminated);
}

function renderCandidate(cand, isDefault) {
  const card = document.createElement("article");
  card.className = "candidate" + (isDefault ? " default" : "");
  const h = document.createElement("h3");
  h.textContent = cand.model.id + (isDefault ? "  ★ default" : "");
  card.appendChild(h);
  const desc = document.createElement("p");
  desc.className = "desc";
  desc.textContent = cand.model.description;
  card.appendChild(desc);

  const pre = document.createElement("pre");
  pre.className = "bundle";
  pre.textContent = JSON.stringify(cand.resolved, null, 2);
  const details = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = "resolved kitlist";
  details.appendChild(sum);
  details.appendChild(pre);
  card.appendChild(details);
  return card;
}

function renderEliminated(eliminated) {
  const details = document.getElementById("eliminated");
  details.innerHTML = "";
  const sum = document.createElement("summary");
  sum.textContent = `eliminated (${eliminated.length})`;
  details.appendChild(sum);
  const ul = document.createElement("ul");
  for (const e of eliminated) {
    const li = document.createElement("li");
    li.textContent = `${e.id} — ${e.failing_condition}`;
    ul.appendChild(li);
  }
  details.appendChild(ul);
}

init();
