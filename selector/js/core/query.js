// query.js — canonical query construction, shared by every front-end.
//
// The solver consumes a flat list of constraints; this module is the ONE place
// that builds and validates them, so the web UI, the future MCP server, and
// any agent tooling speak the same query language (guideline: all front-ends
// resolve requirements over the same space — only how requirements are
// GATHERED differs).
//
//   scalar: { variable, condition, value, severity }
//   port:   { variable: "port_count", where: {role?, medium?, speed}, condition, value, severity }
//
// severity: "hard" (default) participates in filtering/refinement per the
// registry's `eliminates` declaration; "soft" ranks survivors. There is no
// "config" severity any more — whether a constraint filters models or only
// refines the kitlist is declared per variable in the registry, not encoded
// in the query.
//
// Also home to the demand translations that turn user-facing asks into
// derived constraints, using the registry as the single data source.

import { getVariable, acceptedConditions, legalValues, poeLevelWatts } from "./registry.js";

/** Build a scalar constraint. */
export const constraint = (variable, condition, value, severity = "hard") =>
  ({ variable, condition, value, severity });

/** Build a parametrised port constraint. Omitted where-facets are wildcards —
 *  the role-agnostic ask ("N ports able to run speed S") is `{speed}` alone. */
export const portConstraint = (where, condition, value, severity = "hard") =>
  ({ variable: "port_count", where, condition, value, severity });

/**
 * PoE demand rows [{count, level}] → derived hard constraints:
 *   poe_budget_watts >= ceil(Σ count × level_watts[level])   (sizes the PSU)
 *   poe_type         >= max level                            (registry order)
 *   total_port_count >= Σ count      (every PoE port is an access port)
 * level_watts comes from the registry's poe_type declaration — the single
 * source for this translation (UI and MCP both call this, never re-derive).
 */
export function translatePoeDemand(rows, registry) {
  const watts = poeLevelWatts(registry);
  const order = getVariable(registry, "poe_type")?.order ?? [];
  const live = (rows ?? []).filter((r) => (r.count ?? 0) > 0 && r.level);
  if (live.length === 0) return [];
  const totalWatts = live.reduce((s, r) => s + r.count * (watts[r.level] ?? 0), 0);
  const totalPorts = live.reduce((s, r) => s + r.count, 0);
  const maxLevel = live.map((r) => r.level).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  return [
    constraint("poe_budget_watts", ">=", Math.ceil(totalWatts)),
    constraint("poe_type", ">=", maxLevel),
    constraint("total_port_count", ">=", totalPorts),
  ];
}

/**
 * Validate a query against the registry. Returns [{constraint, problem}] —
 * empty when the query is well-formed. The solver itself skips unknown
 * variables rather than guessing; callers (MCP server, UI) surface these.
 */
export function validateQuery(query, registry) {
  const problems = [];
  const bad = (c, problem) => problems.push({ constraint: c, problem });
  for (const c of query ?? []) {
    const v = getVariable(registry, c.variable);
    if (!v) { bad(c, `unknown variable '${c.variable}'`); continue; }
    if (c.severity === "soft") continue; // soft objectives (minimize/maximize) are not conditions
    const accepted = acceptedConditions(v);
    if (!accepted.includes(c.condition))
      bad(c, accepted.length
        ? `condition '${c.condition}' not accepted (allowed: ${accepted.join(", ")})`
        : "variable is not directly constrainable (steer it via its driving variables)");
    const lv = legalValues(v);
    if (lv.length) {
      for (const val of Array.isArray(c.value) ? c.value : [c.value])
        if (!lv.includes(val)) bad(c, `'${val}' is not a legal value`);
    }
  }
  return problems;
}
