// solver.js — the generic, pure selection engine.
//
// solve(query, kb, registry) -> { candidates, default, eliminated }
//
// This is the "small, dumb solver": it filters every model on the query's HARD
// constraints, ranks the survivors by SOFT constraints, and returns the set with
// a default. It contains NO knowledge of any specific switch — every condition is
// evaluated generically by axis type, and every per-switch fact comes from the
// data via resolveAxisValue. A new Cisco switch is new JSON, never new code here.
//
// Pure: no DOM, no fetch, no globals. The exact same function backs the web UI
// today and a Stage-2 MCP server later.

import { resolveAxisValue, resolveBundle } from "./resolve.js";
import { getModels } from "./kb.js";

/**
 * @typedef {Object} Constraint
 * @property {string} axis
 * @property {">="|"=="|"in"} condition
 * @property {number|string|boolean|Array} value
 * @property {"hard"|"soft"} [severity]  // defaults to "hard"
 */

/**
 * @param {Constraint[]} query
 * @param {object} kb        parsed KB (with _index)
 * @param {object} registry  parsed axis registry (reserved for future validation)
 * @returns {{candidates: Array, default: object|null, eliminated: Array}}
 */
export function solve(query, kb, registry) {
  const constraints = query ?? [];
  const hard = constraints.filter((c) => (c.severity ?? "hard") === "hard");
  const soft = constraints.filter((c) => c.severity === "soft");

  const survivors = [];
  const eliminated = [];

  for (const model of getModels(kb)) {
    const fail = firstFailingConstraint(model, hard, kb);
    if (fail) {
      eliminated.push({ id: model.id, failing_axis: fail.axis, failing_condition: describe(fail) });
    } else {
      survivors.push(model);
    }
  }

  rankSurvivors(survivors, soft);

  const candidates = survivors.map((model) => ({
    model: { id: model.id, description: model.description },
    resolved: resolveBundle(model, constraints, kb),
  }));

  return {
    candidates,
    default: candidates[0] ?? null,
    eliminated,
  };
}

/** Return the first hard constraint this model violates, or null if it passes all. */
function firstFailingConstraint(model, hard, kb) {
  for (const c of hard) {
    if (!satisfies(resolveAxisValue(model, c.axis, kb), c)) return c;
  }
  return null;
}

/**
 * Generic condition evaluation. The model value may be a scalar or a SET
 * (e.g. license_regime is an array of offered regimes); set membership is
 * handled uniformly. An absent optional axis (undefined) satisfies nothing.
 */
export function satisfies(modelValue, constraint) {
  const { condition, value } = constraint;
  if (modelValue === undefined || modelValue === null) return false;

  switch (condition) {
    case ">=":
      return typeof modelValue === "number" && modelValue >= value;

    case "==":
      // Scalar equality, or membership when the model offers a set.
      return Array.isArray(modelValue) ? modelValue.includes(value) : modelValue === value;

    case "in": {
      // `value` is a list of acceptable options.
      const opts = Array.isArray(value) ? value : [value];
      return Array.isArray(modelValue)
        ? modelValue.some((v) => opts.includes(v)) // set ∩ opts ≠ ∅
        : opts.includes(modelValue);
    }

    default:
      return false;
  }
}

/**
 * Rank survivors by soft constraints, then a deterministic default order.
 *
 * NOTE: there is no list_price in the KB yet, so soft "minimize"/"maximize"
 * constraints on a missing axis are no-ops. The fallback ordering — fewest
 * total ports, then id — is a documented STUB to be replaced once price/ranking
 * data exists. Sort is stable so survivors keep KB order on ties.
 */
function rankSurvivors(survivors, soft) {
  survivors.sort((a, b) => {
    for (const c of soft) {
      const av = a.axis_values?.[c.axis];
      const bv = b.axis_values?.[c.axis];
      if (typeof av === "number" && typeof bv === "number" && av !== bv) {
        return c.condition === "maximize" ? bv - av : av - bv;
      }
    }
    const ap = a.axis_values?.total_port_count ?? 0;
    const bp = b.axis_values?.total_port_count ?? 0;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });
}

function describe(c) {
  const v = Array.isArray(c.value) ? `[${c.value.join(", ")}]` : c.value;
  return `${c.axis} ${c.condition} ${v}`;
}
