// kb.js — load the knowledge base and build id-indexes for fast, pure lookups.
//
// The KB has three regions the solver/resolver dereference by id:
//   catalog.* — atomic orderable SKUs (modules, PSUs, licenses, cables)
//   groups.*  — named shared compatibility SETS a model references by id
//   models[]  — flat, self-contained switch entries
//
// This module only indexes and dereferences. It holds NO selection logic and NO
// per-switch quirks — those would violate the "small, dumb solver" discipline.

/**
 * Fetch + parse the KB, then attach an `_index` of id->object maps.
 * @param {string} url
 * @returns {Promise<object>} parsed KB with a non-enumerated _index helper bag
 */
export async function loadKB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KB fetch failed: ${res.status} ${url}`);
  const kb = await res.json();
  kb._index = buildIndex(kb);
  return kb;
}

function indexById(arr) {
  const map = new Map();
  for (const item of arr ?? []) map.set(item.id, item);
  return map;
}

/** Build id->object maps for every catalog and group collection. */
export function buildIndex(kb) {
  const c = kb.catalog ?? {};
  const g = kb.groups ?? {};
  return {
    // catalog
    network_modules: indexById(c.network_modules),
    power_supplies: indexById(c.power_supplies),
    stack_cables: indexById(c.stack_cables),
    stackpower_cables: indexById(c.stackpower_cables),
    licenses: indexById(c.licenses),
    // groups
    network_module_groups: indexById(g.network_module_groups),
    power_supply_groups: indexById(g.power_supply_groups),
    stack_cable_groups: indexById(g.stack_cable_groups),
    stackpower_cable_groups: indexById(g.stackpower_cable_groups),
    license_groups: indexById(g.license_groups),
  };
}

// --- Typed dereference helpers (return undefined on a miss; callers decide) ---
export const getNetworkModule = (kb, id) => kb._index.network_modules.get(id);
export const getPowerSupply = (kb, id) => kb._index.power_supplies.get(id);
export const getLicense = (kb, id) => kb._index.licenses.get(id);
export const getNetworkModuleGroup = (kb, id) => kb._index.network_module_groups.get(id);
export const getPowerSupplyGroup = (kb, id) => kb._index.power_supply_groups.get(id);
export const getStackCableGroup = (kb, id) => kb._index.stack_cable_groups.get(id);
export const getStackpowerCableGroup = (kb, id) => kb._index.stackpower_cable_groups.get(id);
export const getLicenseGroup = (kb, id) => kb._index.license_groups.get(id);

/** All switch models. */
export const getModels = (kb) => kb.models ?? [];
