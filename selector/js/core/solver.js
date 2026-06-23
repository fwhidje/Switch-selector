// solver.js — generic, pure selection engine over configured variants.
//
// solve(query, kb, registry) -> { candidates, default, eliminated }
//
// A query is a list of constraints:
//   scalar: { axis, condition, value, severity }
//   port:   { axis: "port_count", where: {role?, medium?, speed}, condition, value, severity }
//
// The engine filters models on hard scalar constraints, then checks port demand
// against each model's uplink VARIANTS via pool-feasibility (a model survives if
// some fitted uplink option makes the whole port demand feasible). Survivors are
// ranked by soft constraints and returned with their resolved BOM. No per-switch
// logic; new switches are new JSON. Pure: no DOM, no fetch, no globals.

import { uplinkOptions, variantPool, poolFeasible, resolveBOM } from "./resolve.js";
import { getModels } from "./kb.js";
import { getAxis } from "./registry.js";

export function solve(query, kb, registry) {
  const cons = query ?? [];
  const isHard = (c) => (c.severity ?? "hard") === "hard";
  const hardScalar = cons.filter((c) => c.axis !== "port_count" && isHard(c));
  const hardPort = cons.filter((c) => c.axis === "port_count" && isHard(c));
  const soft = cons.filter((c) => c.severity === "soft");

  const survivors = [];
  const eliminated = [];

  for (const model of getModels(kb)) {
    const fail = firstFailingScalar(model, hardScalar, registry);
    if (fail) { eliminated.push({ id: model.id, reason: describe(fail) }); continue; }

    const options = uplinkOptions(model, kb);
    const demands = hardPort.map((c) => ({ where: c.where, min: c.value }));
    const validOptions = demands.length
      ? options.filter((o) => poolFeasible(variantPool(model, o), demands))
      : options;

    if (demands.length && validOptions.length === 0) {
      eliminated.push({ id: model.id, reason: portDemandText(hardPort) });
      continue;
    }
    survivors.push({ model, validOptions });
  }

  rank(survivors, soft);

  const candidates = survivors.map((s) => ({
    model: { id: s.model.id, description: s.model.description },
    resolved: resolveBOM(s.model, cons, kb, s.validOptions),
  }));

  return { candidates, default: candidates[0] ?? null, eliminated };
}

/** First hard scalar constraint this model violates, or null. */
function firstFailingScalar(model, constraints, registry) {
  const av = model.axis_values ?? {};
  for (const c of constraints) {
    if (!satisfiesScalar(av[c.axis], c, getAxis(registry, c.axis))) return c;
  }
  return null;
}

/**
 * Generic scalar condition evaluation. Ordered enums (e.g. poe_type) compare by
 * registry order so ">=" means "this level or better". Set-valued model values
 * (license_regime) are handled by membership. Absent optional axis -> fails.
 */
export function satisfiesScalar(value, c, axis) {
  if (value === undefined || value === null) return false;
  const ordered = axis?.kind === "ordered";
  const order = axis?.order ?? axis?.legal_values ?? [];

  switch (c.condition) {
    case ">=":
      if (ordered) return order.indexOf(value) >= order.indexOf(c.value);
      return typeof value === "number" && value >= c.value;
    case "<=":
      if (ordered) return order.indexOf(value) <= order.indexOf(c.value);
      return typeof value === "number" && value <= c.value;
    case "==":
      return Array.isArray(value) ? value.includes(c.value) : value === c.value;
    case "in": {
      const opts = Array.isArray(c.value) ? c.value : [c.value];
      return Array.isArray(value) ? value.some((v) => opts.includes(v)) : opts.includes(value);
    }
    default:
      return false;
  }
}

/**
 * Which legal values of an enum axis still yield >=1 candidate, given the rest
 * of the query (the axis's own constraint is removed first). Drives dynamic
 * facets: the UI disables values not in this set and collapses single-value axes.
 */
export function availableValues(query, axisName, kb, registry) {
  const axis = getAxis(registry, axisName);
  if (!axis?.legal_values) return null;
  const base = (query ?? []).filter((c) => c.axis !== axisName);
  const live = new Set();
  for (const v of axis.legal_values) {
    const r = solve([...base, { axis: axisName, condition: "==", value: v, severity: "hard" }], kb, registry);
    if (r.candidates.length > 0) live.add(v);
  }
  return live;
}

function rank(survivors, soft) {
  survivors.sort((a, b) => {
    for (const c of soft) {
      const av = a.model.axis_values?.[c.axis];
      const bv = b.model.axis_values?.[c.axis];
      if (typeof av === "number" && typeof bv === "number" && av !== bv)
        return c.condition === "maximize" ? bv - av : av - bv;
    }
    // deterministic default order (no price data yet): fewer ports, then id
    const ap = a.model.axis_values?.total_port_count ?? 0;
    const bp = b.model.axis_values?.total_port_count ?? 0;
    if (ap !== bp) return ap - bp;
    return a.model.id.localeCompare(b.model.id);
  });
}

function describe(c) {
  const v = Array.isArray(c.value) ? `[${c.value.join(", ")}]` : c.value;
  return `${c.axis} ${c.condition} ${v}`;
}
function portDemandText(portCons) {
  return portCons
    .map((c) => `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} ${c.condition} ${c.value}`)
    .join(" & ");
}
