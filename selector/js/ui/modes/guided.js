// modes/guided.js — step-by-step mode: walks the decision variables in the
// registry's ask_priority order, one step per variable (the PoE demand rows
// replace the three PoE variables' steps; a Ports step replaces
// total_port_count + port_count). Every step shows a live match count and the
// residual domain (dead options greyed, singleton domains auto-filled); every
// step is skippable ("don't care"). Ends in a summary that hands the
// accumulated draft to the full-option view — same draft object, no re-parse.

import { getVariables, getVariable, storageOf, isCountAtLevel, acceptedConditions, mustResolve, portModel } from "../../core/registry.js";
import { solve, facetDomains } from "../../core/solver.js";
import {
  el, badge, controlFor, readControl, writeControl, toQuery, emptyDraft,
  numInput, row, poeDemandSection, syncDemandRows, readDemandRows, writeDemandRows,
} from "../shared.js";
import { enumeratePortCombos } from "./full.js";

const PORT_FOLD = new Set(["total_port_count", "port_count"]);
const POE_FOLD = new Set(["poe_capable", "poe_type", "poe_budget_watts"]);

function buildSteps(registry) {
  const vars = getVariables(registry)
    .filter((v) => storageOf(v) !== "identity" && acceptedConditions(v).length > 0)
    .sort((a, b) => (a.presentation?.ask_priority ?? 999) - (b.presentation?.ask_priority ?? 999));
  const steps = [];
  let poeDone = false, portsDone = false;
  for (const v of vars) {
    if (POE_FOLD.has(v.name)) {
      if (!poeDone) { steps.push({ kind: "poe", title: "PoE demand" }); poeDone = true; }
      continue;
    }
    if (PORT_FOLD.has(v.name) || isCountAtLevel(v)) {
      if (!portsDone) { steps.push({ kind: "ports", title: "Ports" }); portsDone = true; }
      continue;
    }
    steps.push({ kind: "variable", title: v.name, v });
  }
  steps.push({ kind: "summary", title: "Summary" });
  return steps;
}

export function mount(root, ctx) {
  const { registry, kb } = ctx;
  const speedOrder = portModel(registry)?.selector_enums?.port_speed?.order ?? [];
  const portSpeeds = [...new Set(enumeratePortCombos(kb, speedOrder).map((c) => c.speed))]
    .sort((a, b) => speedOrder.indexOf(a) - speedOrder.indexOf(b));
  const poeLevels = (getVariable(registry, "poe_type")?.order ?? []).filter((l) => l !== "none");
  const steps = buildSteps(registry);
  const draft = emptyDraft();
  let idx = 0;

  root.innerHTML = "";
  const wrap = el("section", "guided-mode");
  root.appendChild(wrap);
  renderStep();

  function currentCount() {
    return solve(toQuery(draft, registry), kb, registry).candidates.length;
  }

  function answeredChips() {
    const parts = [];
    for (const [name, entry] of Object.entries(draft.scalars)) {
      const list = Array.isArray(entry) ? entry : [entry];
      for (const one of list) parts.push(`${name} ${one.condition} ${one.value}`);
    }
    for (const p of draft.ports) parts.push(`${p.speed} ports ≥ ${p.min}`);
    for (const d of draft.poeDemand) parts.push(`${d.count}× ${d.level}`);
    return parts;
  }

  function renderStep() {
    wrap.innerHTML = "";
    const step = steps[idx];
    const panel = el("div", "step-panel");

    const head = el("div", "step-head");
    head.appendChild(el("span", "step-progress", `step ${idx + 1} / ${steps.length}`));
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
    const status = el("p", "step-status");
    panel.appendChild(status);

    const nav = el("div", "step-nav");
    const back = el("button", null, "← back");
    back.type = "button";
    back.disabled = idx === 0;
    back.addEventListener("click", () => { idx--; renderStep(); });
    nav.appendChild(back);

    if (step.kind === "summary") {
      renderSummary(body);
    } else {
      const skip = el("button", null, "skip — don't care");
      skip.type = "button";
      skip.addEventListener("click", () => { clearStep(step); idx++; renderStep(); });
      nav.appendChild(skip);
      const next = el("button", "primary", "next →");
      next.type = "button";
      next.addEventListener("click", () => { commitStep(step, body); idx++; renderStep(); });
      nav.appendChild(next);

      if (step.kind === "variable") renderVariableStep(step.v, body, status);
      if (step.kind === "poe") renderPoeStep(body);
      if (step.kind === "ports") renderPortsStep(body);
      body.addEventListener("input", () => updateStatus(status, step, body));
      body.addEventListener("change", () => updateStatus(status, step, body));
      updateStatus(status, step, body);
    }
    panel.appendChild(nav);
    wrap.appendChild(panel);
  }

  // live count for the draft AS IF this step's current input were committed
  function updateStatus(status, step, body) {
    const probe = structuredClone(draft);
    collectStep(step, body, probe);
    const n = solve(toQuery(probe, registry), kb, registry).candidates.length;
    status.textContent = `${n} model${n === 1 ? "" : "s"} still match`;
    status.classList.toggle("dead-end", n === 0);
  }

  function renderVariableStep(v, body, status) {
    if (v.notes) body.appendChild(el("p", "step-notes", v.notes.split(". ").slice(0, 2).join(". ") + "."));
    const control = controlFor(v, kb);
    body.appendChild(control);
    // restore an earlier answer
    const prev = draft.scalars[v.name];
    if (prev) {
      const list = Array.isArray(prev) ? prev : [prev];
      for (const one of list)
        for (const elm of body.querySelectorAll(`[data-variable="${v.name}"]`)) writeControl(elm, one, body);
    }
    // residual domain: grey dead options; singleton -> auto-fill
    const sel = body.querySelector(`select[data-variable="${v.name}"]`);
    if (sel && (sel.dataset.kind === "enum" || sel.dataset.kind === "ordered")) {
      const rest = structuredClone(draft);
      delete rest.scalars[v.name];
      const domains = facetDomains(toQuery(rest, registry), kb, registry);
      const live = domains.get(v.name);
      if (live) {
        const liveVals = [];
        for (const opt of sel.options) {
          if (opt.value === "") continue;
          opt.disabled = !live.has(opt.value);
          if (live.has(opt.value)) liveVals.push(opt.value);
        }
        if (liveVals.length === 1 && !sel.value) {
          sel.value = liveVals[0];
          body.appendChild(el("p", "step-notes determined", `only one possibility — auto-filled: ${liveVals[0]}`));
        }
        if (liveVals.length === 0)
          body.appendChild(el("p", "step-notes determined", "not applicable for the current matches — skip"));
      }
    }
  }

  function renderPoeStep(body) {
    body.appendChild(el("p", "step-notes", "State the PoE need as ports at level; this sizes the PSU and derives the budget/level/count constraints."));
    body.appendChild(poeDemandSection(poeLevels));
    if (draft.poeDemand.length) writeDemandRows(body.querySelector("#poe-demand"), draft.poeDemand, poeLevels);
    body.addEventListener("input", () => syncDemandRows(body.querySelector("#poe-demand"), poeLevels));
  }

  function renderPortsStep(body) {
    body.appendChild(el("p", "step-notes", "Minimum ports able to run each speed — any role; the solver decides access vs uplink."));
    const total = numInput("total_port_count", "min", "min");
    body.appendChild(row("total access ports", "minimum physical access ports", false, total));
    const prev = draft.scalars.total_port_count;
    if (prev) {
      const list = Array.isArray(prev) ? prev : [prev];
      for (const one of list) writeControl(total, one, body);
    }
    for (const speed of portSpeeds) {
      const input = numInput("port_count", "min", "0");
      input.dataset.portSpeed = speed;
      const existing = draft.ports.find((p) => !p.role && p.speed === speed);
      if (existing) input.value = String(existing.min);
      body.appendChild(row(`${speed} ports`, "minimum ports able to run this speed", false, input));
    }
  }

  function clearStep(step) {
    if (step.kind === "variable") delete draft.scalars[step.v.name];
    if (step.kind === "poe") draft.poeDemand = [];
    if (step.kind === "ports") { delete draft.scalars.total_port_count; draft.ports = []; }
  }

  function collectStep(step, body, target) {
    if (step.kind === "variable") {
      delete target.scalars[step.v.name];
      for (const elm of body.querySelectorAll(`[data-variable="${step.v.name}"]:not([data-port-speed])`)) {
        const entry = readControl(elm, body);
        if (!entry) continue;
        const prev = target.scalars[step.v.name];
        target.scalars[step.v.name] = prev ? (Array.isArray(prev) ? [...prev, entry] : [prev, entry]) : entry;
      }
    }
    if (step.kind === "poe") target.poeDemand = readDemandRows(body.querySelector("#poe-demand"));
    if (step.kind === "ports") {
      delete target.scalars.total_port_count;
      target.ports = [];
      const totalEl = body.querySelector('[data-variable="total_port_count"]');
      const totalEntry = totalEl ? readControl(totalEl, body) : null;
      if (totalEntry) target.scalars.total_port_count = totalEntry;
      for (const elm of body.querySelectorAll("[data-port-speed]")) {
        const v = Number(elm.value);
        if (elm.value && v > 0) target.ports.push({ speed: elm.dataset.portSpeed, min: v });
      }
    }
  }

  function commitStep(step, body) {
    collectStep(step, body, draft);
  }

  function renderSummary(body) {
    const query = toQuery(draft, registry);
    const result = solve(query, kb, registry);
    body.appendChild(el("p", "step-notes", query.length
      ? "Requirements gathered: " + query.map((c) => c.variable === "port_count"
          ? `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} ≥ ${c.value}`
          : `${c.variable} ${c.condition} ${c.value}`).join("  ·  ")
      : "No requirements — all models match."));
    const n = result.candidates.length;
    body.appendChild(el("p", "step-status", `${n} model${n === 1 ? "" : "s"} match` +
      (result.default ? ` — default: ${result.default.model.id}` : "")));
    const open = result.open_variables.filter((o) => o.must_resolve);
    if (open.length)
      body.appendChild(el("p", "step-notes",
        "Still to resolve for an orderable BOM: " + open.map((o) => o.name).join(", ") + "."));
    const go = el("button", "primary", "open in full view →");
    go.type = "button";
    go.addEventListener("click", () => {
      ctx.handoff = structuredClone(draft);
      location.hash = "#full";
    });
    body.appendChild(go);
  }
}
