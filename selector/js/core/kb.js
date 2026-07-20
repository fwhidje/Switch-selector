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

/**
 * Merge several already-parsed family KBs into one pool for the solver.
 * Pure (no IO) — the entry point for hosts that bundle the KB JSON instead of
 * fetching it (the MCP server; see selector/docs/mcp-solver-contract.md §3).
 * Attaches each KB's `_index` if not already present.
 *
 * Catalog/group ids are only unique WITHIN a family (a future family could
 * reuse a real Cisco SKU another family already uses), so this does not
 * flatten catalogs/groups into one shared index. Instead each model keeps a
 * back-reference to its own family's KB (with its own `_index`), and callers
 * that dereference a model's modules/PSUs/cables/licenses must look them up
 * via that model's `_kb`, not the merged object.
 * @param {object[]} parsedKbs
 * @returns {object} { models, _sources } — models is flat and tagged
 */
export function mergeKBs(parsedKbs) {
  const sources = [];
  const models = [];
  for (const kb of parsedKbs) {
    if (!kb._index)
      Object.defineProperty(kb, "_index", { value: buildIndex(kb), enumerable: false });
    sources.push(kb);
    for (const m of getModels(kb)) {
      Object.defineProperty(m, "_kb", { value: kb, enumerable: false });
      models.push(m);
    }
  }
  return { models, _sources: sources };
}

/**
 * Fetch + merge several family KBs (browser convenience over mergeKBs).
 * @param {string[]} urls
 * @returns {Promise<object>} { models, _sources }
 */
export async function loadKBs(urls) {
  return mergeKBs(await Promise.all(urls.map(loadKB)));
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
