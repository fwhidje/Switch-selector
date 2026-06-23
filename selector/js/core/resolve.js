// resolve.js — generic, data-driven capability resolution.
//
// This is the ONLY module with any "smarts", and every rule here is uniform
// across all models — there is no `if model === X`. Two jobs:
//   1. resolveAxisValue: give the solver a comparable value for any registry
//      axis, including the uplink_* axes that are never stored on the switch.
//   2. resolveBundle: assemble the orderable kitlist for a surviving candidate.
//
// Anything that looks like "Meraki X is compatible with Y" or "which tier to
// pick" is deliberately absent — that belongs to a higher layer.

import { isResolvedUplinkAxis } from "./registry.js";
import {
  getNetworkModuleGroup,
  getPowerSupplyGroup,
  getStackCableGroup,
  getStackpowerCableGroup,
  getLicenseGroup,
} from "./kb.js";

/**
 * The uplink_capacity block for a model — looked through to the referenced
 * network-module group (modular models) or read inline (fixed-uplink models).
 * Identical shape either way; this is what makes uplink_* axes filterable.
 * @returns {object|undefined} an uplink_capacity block, or undefined if none
 */
export function uplinkCapacity(model, kb) {
  const cfg = model.configurables ?? {};
  if (model.axis_values?.uplink_modular) {
    const group = getNetworkModuleGroup(kb, cfg.network_modules?.group);
    return group?.uplink_capacity;
  }
  return cfg.uplinks?.uplink_capacity; // fixed-uplink inline form
}

/**
 * Resolve a single registry axis to a comparable value for this model.
 * uplink_* axes resolve through the capacity block; everything else is read
 * straight from axis_values (undefined when an optional axis doesn't apply).
 * @returns {number|string|boolean|Array|undefined}
 */
export function resolveAxisValue(model, axis, kb) {
  if (isResolvedUplinkAxis(axis)) {
    return uplinkCapacity(model, kb)?.per_speed_max?.[axis];
  }
  return model.axis_values?.[axis];
}

/**
 * Assemble the orderable bundle (kitlist) for a surviving candidate.
 * `query` is the active constraint list; it only narrows what we surface
 * (license groups for a chosen regime, PoE rows meeting a wattage), never which
 * single SKU to buy — that decision stays with the caller / upper layer.
 */
export function resolveBundle(model, query, kb) {
  return {
    switch: { id: model.id, description: model.description },
    uplinks: resolveUplinks(model, kb),
    power: resolvePower(model, query, kb),
    license: resolveLicense(model, query, kb),
    accessories: resolveAccessories(model, kb),
    included_by_default: stripComment(model.included_by_default_non_selectable),
  };
}

function resolveUplinks(model, kb) {
  const cap = uplinkCapacity(model, kb);
  if (!cap) return null;
  const out = {
    modular: !!model.axis_values?.uplink_modular,
    per_speed_max: cap.per_speed_max ?? {},
  };
  if (model.axis_values?.uplink_modular) {
    const group = getNetworkModuleGroup(kb, model.configurables?.network_modules?.group);
    if (group) {
      out.module_group = group.id;
      out.module_options = group.members ?? [];
      out.none_option = group.none_option;
    }
  }
  return out;
}

function resolvePower(model, query, kb) {
  const ps = model.configurables?.power_supplies;
  if (!ps) return null;
  const group = getPowerSupplyGroup(kb, ps.group);
  const matrix = ps.poe_budget_matrix ?? [];
  // If the query asked for a PoE budget, surface only the PSU pairs that meet it.
  const need = numericConstraintValue(query, "poe_budget_watts");
  const rows = need == null ? matrix : matrix.filter((r) => r.poe_budget_watts >= need);
  return {
    group: ps.group,
    members: group?.members ?? [],
    valid_primary: ps.valid_primary ?? [],
    secondary_none_option: group?.secondary_none_option,
    poe_budget_matrix: rows,
    meets_requested_budget: need == null ? null : rows.length > 0,
  };
}

function resolveLicense(model, query, kb) {
  const lic = model.configurables?.license;
  if (!lic) return null;
  const groupIds = [lic.group, ...(lic.additional_groups ?? [])];
  const wantRegime = enumConstraintValue(query, "license_regime");
  const groups = groupIds
    .map((id) => getLicenseGroup(kb, id))
    .filter(Boolean)
    // Filter to the chosen regime when the query pins one; otherwise show all.
    .filter((g) => wantRegime == null || g.regime === wantRegime)
    .map((g) => ({
      id: g.id,
      regime: g.regime,
      tier: g.tier, // shown, never picked by the solver
      port_class: g.port_class,
      perpetual_member: g.perpetual_member,
      subscription_members: g.subscription_members ?? [],
      term_choices_years: g.term_variable?.choices_years ?? [],
    }));
  return {
    regime_offered: lic.regime_offered ?? [],
    tier_locked: lic.tier_locked ?? null,
    groups,
  };
}

function resolveAccessories(model, kb) {
  const cfg = model.configurables ?? {};
  const out = {};
  const stack = getStackCableGroup(kb, cfg.stack_cables?.group);
  if (stack) out.stack_cables = { group: stack.id, members: stack.members ?? [], none_option: stack.none_option, stack_kit: stack.stack_kit };
  const sp = getStackpowerCableGroup(kb, cfg.stackpower_cables?.group);
  if (sp) out.stackpower_cables = { group: sp.id, members: sp.members ?? [], none_option: sp.none_option };
  if (cfg.ssd_accessory) out.ssd_accessory = cfg.ssd_accessory;
  return out;
}

// --- small helpers ------------------------------------------------------------

function stripComment(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { _comment, ...rest } = obj;
  return rest;
}

/** First numeric value a query constrains on `axis` (for >= narrowing). */
function numericConstraintValue(query, axis) {
  const c = (query ?? []).find((c) => c.axis === axis && c.condition === ">=");
  return c ? c.value : null;
}

/** First scalar enum value a query pins on `axis` via `==`. */
function enumConstraintValue(query, axis) {
  const c = (query ?? []).find((c) => c.axis === axis && c.condition === "==");
  return c ? c.value : null;
}
