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
 * Parametrised port axis: kind "count-at-level". It is NOT stored as a scalar
 * field in axis_values — it resolves against a variant's port pool (model.ports
 * access groups + the fitted module's uplink groups). See the port_model block
 * in switching-axes.json. `port_count` is the only such axis today.
 */
export function isCountAtLevelAxis(axis) {
  return axis?.kind === "count-at-level";
}

/** Legal values declared by the registry's port_model selector enums. */
export function portModel(registry) {
  return registry.port_model ?? null;
}

/**
 * Config-variables: dimensions a user PICKS to finalise a kitlist (license tier,
 * term), surfaced at the configuration stage. They never filter/eliminate models
 * — the solver forwards them to BOM resolution. Returns the declared map.
 */
export function configVariables(registry) {
  return registry.config_variables ?? {};
}
