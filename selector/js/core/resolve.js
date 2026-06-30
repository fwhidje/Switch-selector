// resolve.js — port pools, configured variants, pool-feasibility, and BOM.
//
// v0.4.0 port model: a model carries role=access port groups; uplink ports come
// from the fitted network module (modular) or inline on the model (fixed). A
// configured VARIANT = model + one fitted uplink option; its port pool drives
// the parametrised port_count axis. All generic/data-driven — no per-switch logic.

import {
  getNetworkModuleGroup,
  getNetworkModule,
  getPowerSupplyGroup,
  getPowerSupply,
  getStackCableGroup,
  getStackpowerCableGroup,
  getLicenseGroup,
} from "./kb.js";

// --- port pools -------------------------------------------------------------
export const accessGroups = (model) => (model.ports ?? []).filter((p) => p.role === "access");
export const inlineUplinkGroups = (model) => (model.ports ?? []).filter((p) => p.role === "uplink");

/**
 * The uplink options for a model. Modular models offer each group member plus a
 * "none" option; fixed-uplink models offer their single soldered configuration.
 * A dual-mode module (catalog `modes`, e.g. C9350-NM-8Y: 8x25G | 4x50G) expands
 * into one option per mode — all sharing the same `moduleId` (the real SKU), so
 * the kitlist/BOM never shows a phantom part number; the mode is only a label.
 * @returns {Array<{id:string, moduleId:string|null, mode?:string, ports:object[]}>}
 */
export function uplinkOptions(model, kb) {
  const av = model.axis_values ?? {};
  if (av.uplink_modular) {
    const g = getNetworkModuleGroup(kb, model.configurables?.network_modules?.group);
    if (!g) return [{ id: "none", moduleId: null, ports: [] }];
    const opts = [];
    for (const id of g.members ?? []) {
      const mod = getNetworkModule(kb, id);
      if (mod?.modes?.length) {
        for (const mode of mod.modes)
          opts.push({ id: `${id}#${mode.name}`, moduleId: id, mode: mode.name, ports: mode.ports ?? [] });
      } else {
        opts.push({ id, moduleId: id, ports: mod?.ports ?? [] });
      }
    }
    opts.push({ id: g.none_option, moduleId: null, ports: [] });
    return opts;
  }
  return [{ id: "fixed", moduleId: null, ports: inlineUplinkGroups(model) }];
}

/** A variant's port pool = model access groups + the fitted option's uplink groups. */
export const variantPool = (model, option) => accessGroups(model).concat(option.ports ?? []);

// --- port matching + pool feasibility ---------------------------------------
const groupMatches = (g, where) =>
  (!where.role || g.role === where.role) && (!where.medium || g.medium === where.medium);
const groupHasSpeed = (g, speed) => (g.speeds ?? []).includes(speed);

/** Upper-bound count of ports able to run `where.speed` (ignores contention). */
export function portCount(pool, where) {
  return pool
    .filter((g) => groupMatches(g, where) && groupHasSpeed(g, where.speed))
    .reduce((s, g) => s + g.count, 0);
}

/**
 * Can the pool simultaneously satisfy every demand `{where, min}`? A single
 * physical port serves at most one demand, so independent per-speed checks
 * over-match (the 8Y "8x25 AND 8x10" trap). Modelled exactly as a max-flow:
 * source -> demand(min) -> matching groups -> sink(group.count). Feasible iff
 * the flow saturates total demand. Small graphs; Edmonds-Karp is plenty.
 */
export function poolFeasible(pool, demands) {
  if (demands.length === 0) return true;
  // dedup demands on the same selector -> keep the largest min
  const byKey = new Map();
  for (const d of demands) {
    const k = `${d.where.role ?? "*"}|${d.where.medium ?? "*"}|${d.where.speed}`;
    byKey.set(k, Math.max(byKey.get(k) ?? 0, d.min));
  }
  const D = [...byKey.entries()].map(([k, min]) => {
    const [role, medium, speed] = k.split("|");
    return { role: role === "*" ? null : role, medium: medium === "*" ? null : medium, speed, min };
  });

  const S = 0, dBase = 1, gBase = 1 + D.length, T = gBase + pool.length, N = T + 1;
  const cap = Array.from({ length: N }, () => ({}));
  const add = (u, v, c) => { cap[u][v] = (cap[u][v] ?? 0) + c; cap[v][u] = cap[v][u] ?? 0; };

  let need = 0;
  D.forEach((d, i) => {
    add(S, dBase + i, d.min); need += d.min;
    pool.forEach((g, j) => {
      if (groupMatches(g, { role: d.role, medium: d.medium }) && groupHasSpeed(g, d.speed))
        add(dBase + i, gBase + j, Infinity);
    });
  });
  pool.forEach((g, j) => add(gBase + j, T, g.count));

  let flow = 0;
  for (;;) {
    const prev = new Array(N).fill(-1);
    prev[S] = S;
    const q = [S];
    while (q.length) {
      const u = q.shift();
      for (let v = 0; v < N; v++) if (prev[v] === -1 && (cap[u][v] ?? 0) > 0) { prev[v] = u; q.push(v); }
    }
    if (prev[T] === -1) break;
    let b = Infinity;
    for (let v = T; v !== S; v = prev[v]) b = Math.min(b, cap[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) { cap[prev[v]][v] -= b; cap[v][prev[v]] = (cap[v][prev[v]] ?? 0) + b; }
    flow += b;
  }
  return flow >= need;
}

// --- BOM (kitlist) ----------------------------------------------------------
export function resolveBOM(model, query, kb, validOptions) {
  return {
    switch: { id: model.id, description: model.description },
    uplinks: resolveUplinkBOM(model, validOptions),
    power: resolvePower(model, query, kb),
    license: resolveLicense(model, query, kb),
    accessories: resolveAccessories(model, kb),
    included_by_default: stripComment(model.included_by_default_non_selectable),
  };
}

function resolveUplinkBOM(model, validOptions) {
  const modular = !!model.axis_values?.uplink_modular;
  const opts = (validOptions ?? []).map((o) => ({ id: o.id, moduleId: o.moduleId, mode: o.mode, ports: o.ports }));
  // none_option has moduleId === null; prefer it as default (standalone switch, no uplink module fitted).
  // When a port demand excluded the none_option, fall back to the first valid real module.
  const noneOpt = opts.find((o) => o.moduleId === null);
  const dflt = noneOpt ?? opts[0] ?? null;
  return { modular, default: dflt?.id ?? null, options: opts };
}

// PSU redundancy is NOT a stored axis: it is a (primary, secondary) pair with a
// secondary fitted. For PoE models the pairs come straight from the PoE matrix;
// for non-PoE models redundancy is pairing two PSUs from the valid-primary set.
function resolvePower(model, query, kb) {
  const ps = model.configurables?.power_supplies;
  if (!ps) return null;
  const group = getPowerSupplyGroup(kb, ps.group);
  const need = numericMin(query, "poe_budget_watts");
  const redundancy = configValue(query, "psu_redundancy") === true;
  const matrix = ps.poe_budget_matrix ?? [];
  const rows = need == null ? matrix : matrix.filter((r) => r.poe_budget_watts >= need);
  const poe = matrix.length > 0;

  return {
    group: ps.group,
    valid_primary: ps.valid_primary ?? [],
    default_primary: ps.default_primary,
    secondary_none_option: group?.secondary_none_option,
    redundant_capable: poe ? matrix.some((r) => r.secondary != null) : true,
    default_config: chooseDefaultPsu(ps, kb, need, redundancy),
    poe_budget_matrix: rows,
    meets_requested_budget: need == null ? null : rows.length > 0,
  };
}

// Resolve the default PSU config from default_primary.
//   redundancy OFF: ship a single PSU; to reach a higher PoE load ADD a secondary;
//     upsize the primary only when no secondary covers it (min primary, then secondary).
//   redundancy ON: a true backup must at least MATCH the primary, so default to a
//     matched pair (secondary == primary); prefer keeping the default primary and the
//     smallest matched pair that still meets the load.
function chooseDefaultPsu(ps, kb, need, redundancy) {
  const dp = ps.default_primary;
  const matrix = ps.poe_budget_matrix ?? [];
  const w = (id) => (id == null ? 0 : getPowerSupply(kb, id)?.watts ?? 0);
  const meets = (r) => need == null || r.poe_budget_watts >= need;

  if (redundancy) {
    if (matrix.length === 0)
      return { primary: dp, secondary: dp, tertiary: null, watts: null, reason: "redundant matched pair (no PoE data)" };
    // secondary must be at least as large as the primary (real N+1); prefer a 2-PSU
    // matched pair, then keeping the default primary, then the smallest such pair.
    const cand = matrix.filter((r) => r.secondary != null && w(r.secondary) >= w(r.primary) && meets(r));
    if (!cand.length) return null;
    cand.sort((a, b) =>
      ((a.tertiary ? 1 : 0) - (b.tertiary ? 1 : 0)) ||
      ((a.secondary === a.primary ? 0 : 1) - (b.secondary === b.primary ? 0 : 1)) ||
      ((a.primary === dp ? 0 : 1) - (b.primary === dp ? 0 : 1)) ||
      (w(a.primary) - w(b.primary)) || (w(a.secondary) - w(b.secondary)));
    const r = cand[0];
    return { primary: r.primary, secondary: r.secondary, tertiary: r.tertiary ?? null, watts: r.poe_budget_watts,
             reason: r.secondary === r.primary ? "redundant matched pair" : "redundant pair (secondary ≥ primary)" };
  }

  if (matrix.length === 0)
    return { primary: dp, secondary: null, tertiary: null, watts: null, reason: "default single" };
  const dpRows = matrix.filter((r) => r.primary === dp);
  const dpSingle = dpRows.find((r) => r.secondary == null);
  if (dpSingle && meets(dpSingle))
    return { primary: dp, secondary: null, tertiary: null, watts: dpSingle.poe_budget_watts,
             reason: need == null ? "base default (no PoE budget specified)" : "default single meets load" };
  // keep the default primary; add the fewest/smallest extra PSUs that meet the load
  // (prefer a 2-PSU pair over a 3-PSU combo, then the smallest secondary/tertiary).
  const dpPairs = dpRows.filter((r) => r.secondary != null && meets(r)).sort((a, b) =>
    ((a.tertiary ? 1 : 0) - (b.tertiary ? 1 : 0)) || (w(a.secondary) - w(b.secondary)) || (w(a.tertiary) - w(b.tertiary)));
  if (dpPairs.length) {
    const r = dpPairs[0];
    return { primary: dp, secondary: r.secondary, tertiary: r.tertiary ?? null, watts: r.poe_budget_watts,
             reason: r.tertiary ? "added secondary+tertiary to meet load" : "added secondary to meet load" };
  }
  // upsize: fewest PSUs, then smallest primary/secondary/tertiary, that meets the load
  const feasible = matrix.filter(meets).sort((a, b) =>
    ((a.tertiary ? 1 : 0) - (b.tertiary ? 1 : 0)) || (w(a.primary) - w(b.primary)) ||
    (w(a.secondary) - w(b.secondary)) || (w(a.tertiary) - w(b.tertiary)));
  if (feasible.length) {
    const r = feasible[0];
    return { primary: r.primary, secondary: r.secondary, tertiary: r.tertiary ?? null, watts: r.poe_budget_watts,
             reason: "upsized primary (no secondary covered the load)" };
  }
  return null; // load not satisfiable by this model's PSU options
}

// License tier + term are CONFIG-VARIABLES: tier is locked on DNA -E/-A models and
// selectable on Meraki -M models; term resolves the concrete subscription SKU.
function resolveLicense(model, query, kb) {
  const lic = model.configurables?.license;
  if (!lic) return null;
  const wantRegime = enumEq(query, "license_regime");
  const wantTier = enumEq(query, "license_tier"); // now a hard filter axis, not a config-variable
  const wantTerm = configValue(query, "license_term");

  const groups = [lic.group, ...(lic.additional_groups ?? [])]
    .map((id) => getLicenseGroup(kb, id))
    .filter(Boolean)
    .filter((g) => wantRegime == null || g.regime === wantRegime);

  const offeredTiers = [...new Set(groups.map((g) => g.tier))];
  // apply a tier pick only where the model actually offers it (never eliminates)
  const shown = wantTier != null && offeredTiers.includes(wantTier)
    ? groups.filter((g) => g.tier === wantTier)
    : groups;

  const out = shown.map((g) => {
    const terms = g.term_variable?.choices_years ?? [];
    let chosen_term = null;
    if (wantTerm != null) {
      if (terms.length === 0) {
        // term not applicable (e.g. Meraki subscription-L: one device-tied SKU)
        chosen_term = { term_years: null, not_applicable: true, subscription_sku: (g.subscription_members ?? [])[0] ?? null };
      } else {
        const sku = (g.subscription_members ?? []).find((s) => new RegExp(`-${wantTerm}Y$`).test(s));
        chosen_term = { term_years: wantTerm, subscription_sku: sku ?? null, available: !!sku };
      }
    }
    return {
      id: g.id,
      regime: g.regime,
      tier: g.tier,
      port_class: g.port_class,
      perpetual_member: g.perpetual_member,
      subscription_members: g.subscription_members ?? [],
      term_choices_years: terms,
      chosen_term,
    };
  });
  return {
    regime_offered: lic.regime_offered ?? [],
    tier_locked: lic.tier_locked ?? (offeredTiers.length === 1 ? offeredTiers[0] : null),
    tier_selectable: !lic.tier_locked && offeredTiers.length > 1,
    offered_tiers: offeredTiers,
    groups: out,
  };
}

function resolveAccessories(model, kb) {
  const cfg = model.configurables ?? {};
  const out = {};
  const stack = getStackCableGroup(kb, cfg.stack_cables?.group);
  if (stack) out.stack_cables = cableInfo(stack, kb._index.stack_cables);
  const sp = getStackpowerCableGroup(kb, cfg.stackpower_cables?.group);
  if (sp) out.stackpower_cables = cableInfo(sp, kb._index.stackpower_cables);
  if (cfg.ssd_accessory) out.ssd_accessory = cfg.ssd_accessory;
  return out;
}

// A standalone switch needs no cable: default to the group's none_option. If a
// cable IS taken, the default length is the shortest available.
function cableInfo(group, catIndex) {
  const withLen = (group.members ?? []).map((id) => ({ id, len: catIndex.get(id)?.length_cm ?? Infinity }))
    .sort((a, b) => a.len - b.len);
  return {
    group: group.id,
    default: group.none_option,
    none_option: group.none_option,
    shortest: withLen[0]?.id ?? null,
    members: group.members ?? [],
    stack_kit: group.stack_kit,
  };
}

// --- helpers ----------------------------------------------------------------
function stripComment(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { _comment, ...rest } = obj;
  return rest;
}
// Most-restrictive >= bound across ALL constraints on an axis (an explicit control
// and a demand-derived constraint intersect — the highest wins).
function numericMin(query, axis) {
  const vals = (query ?? []).filter((c) => c.axis === axis && c.condition === ">=").map((c) => c.value);
  return vals.length ? Math.max(...vals) : null;
}
function enumEq(query, axis) {
  const c = (query ?? []).find((c) => c.axis === axis && c.condition === "==");
  return c ? c.value : null;
}
/** Value of a config-variable entry (severity:"config"), or null. */
function configValue(query, name) {
  const c = (query ?? []).find((c) => c.axis === name && c.severity === "config");
  return c ? c.value : null;
}
