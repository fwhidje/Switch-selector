// registry.js — thin accessors over the axis registry (switching-axes.json).
//
// The registry is the SINGLE SOURCE of the filterable vocabulary. Both the UI
// (form controls) and the solver (query validation + condition evaluation) read
// the legal axes from here — nothing is filterable unless declared in this file.
//
// Pure module: no DOM, no globals. loadRegistry does the one fetch; everything
// else operates on the already-parsed object so the solver stays IO-free.

/**
 * Fetch + parse the axis registry.
 * @param {string} url
 * @returns {Promise<object>} parsed switching-axes.json
 */
export async function loadRegistry(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status} ${url}`);
  return res.json();
}

/** All axis definitions, in registry order. */
export function getAxes(registry) {
  return registry.axes ?? [];
}

/** One axis definition by name, or undefined. */
export function getAxis(registry, name) {
  return getAxes(registry).find((a) => a.name === name);
}

/** Legal enum values for an enum axis (empty for non-enum axes). */
export function legalValues(axis) {
  return axis?.legal_values ?? [];
}

/** Conditions an axis accepts (e.g. [">="] or ["==", "in"]). */
export function acceptedConditions(axis) {
  return axis?.accepted_conditions ?? [];
}

/**
 * The uplink_* axes are special: they are NOT stored on a model's axis_values.
 * They resolve by look-through into an uplink_capacity block (see resolve.js).
 * Everything in the registry under an `uplink_` prefix EXCEPT uplink_modular is
 * one of these resolved axes.
 */
export function isResolvedUplinkAxis(name) {
  return name.startsWith("uplink_") && name !== "uplink_modular";
}
