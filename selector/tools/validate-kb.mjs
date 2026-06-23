// validate-kb.mjs — registry -> schema -> KB consistency validator.
//
// The three knowledge files are a projection chain; this tool is the mechanical
// guard that keeps them honest (it replaces the phantom "validate2.py" the docs
// historically referenced but which never existed). It deliberately REUSES the
// solver's own loaders/index so it validates the exact structures the engine
// consumes — not a parallel re-read that could itself drift.
//
// Run: `npm run validate`  (or `node selector/tools/validate-kb.mjs`)
// Exit code 0 = all checks pass; 1 = at least one violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { buildIndex } from "../js/core/kb.js";
import { getAxes, isResolvedUplinkAxis } from "../js/core/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const C9300 = resolvePath(HERE, "../../C9300");

const violations = [];
const fail = (file, path, message) => violations.push({ file, path, message });

function readJSON(name) {
  return JSON.parse(readFileSync(resolvePath(C9300, name), "utf8"));
}

const registry = readJSON("switching-axes.json");
const schema = readJSON("switch-kb.schema.json");
const kb = readJSON("c9300_knowledge_base.json");
kb._index = buildIndex(kb);

const axes = getAxes(registry);
const axisByName = new Map(axes.map((a) => [a.name, a]));

// --- Check 1: versions agree ------------------------------------------------
function checkVersions() {
  const F = "header";
  if (kb.header?.registry_version !== registry.registry_version)
    fail("KB", `${F}.registry_version`, `KB says ${kb.header?.registry_version}, registry is ${registry.registry_version}`);
  if (kb.header?.schema_version !== schema.schema_version)
    fail("KB", `${F}.schema_version`, `KB says ${kb.header?.schema_version}, schema is ${schema.schema_version}`);
  if (schema.registry_version !== registry.registry_version)
    fail("schema", "registry_version", `schema conforms to ${schema.registry_version}, registry is ${registry.registry_version}`);
}

// --- Check 2: registry <-> schema axis_values projection --------------------
// Every registry axis must project to a schema axis_values property, EXCEPT the
// resolved uplink_* axes which are intentionally absent (they resolve via
// look-through, never stored on the switch). Conversely, every axis_values
// property must be a registered axis.
function checkRegistrySchema() {
  const props = schema?.$defs?.axis_values?.properties ?? {};
  const schemaAxisProps = Object.keys(props).filter((k) => k !== "_comment");

  for (const axis of axes) {
    if (isResolvedUplinkAxis(axis.name)) {
      if (axis.name in props)
        fail("schema", `axis_values.${axis.name}`, "resolved uplink axis must NOT be a stored axis_values field");
      continue;
    }
    if (!(axis.name in props))
      fail("schema", "axis_values.properties", `registry axis '${axis.name}' has no schema projection`);
  }
  for (const p of schemaAxisProps) {
    if (!axisByName.has(p))
      fail("schema", `axis_values.${p}`, `schema field '${p}' is not a registered axis`);
  }
  // required[] must reference real axes
  for (const r of schema?.$defs?.axis_values?.required ?? []) {
    if (!axisByName.has(r))
      fail("schema", `axis_values.required`, `requires '${r}', which is not a registered axis`);
  }
}

// --- Check 3: KB axis_values <= registry ------------------------------------
const ENUM_AXES = ["series", "poe_type", "stacking_technology"]; // scalar enums
function checkKbAxisValues() {
  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    for (const key of Object.keys(av)) {
      if (key === "_comment") continue;
      const axis = axisByName.get(key);
      if (!axis) { fail("KB", `${m.id}.axis_values.${key}`, "not a registered axis"); continue; }
      if (isResolvedUplinkAxis(key))
        fail("KB", `${m.id}.axis_values.${key}`, "uplink axis must not be stored (resolves via look-through)");
    }
    // required-on-model
    for (const axis of axes) {
      if (axis.required_on_model === true && !(axis.name in av))
        fail("KB", `${m.id}.axis_values`, `missing required axis '${axis.name}'`);
    }
    if (av.stacking_capable === true && !("stacking_technology" in av))
      fail("KB", `${m.id}.axis_values`, "stacking_capable=true requires stacking_technology");
    if (av.poe_capable === true && !("poe_budget_watts" in av && "poe_port_count" in av))
      fail("KB", `${m.id}.axis_values`, "poe_capable=true requires poe_budget_watts + poe_port_count");
    // scalar enum legality
    for (const ea of ENUM_AXES) {
      if (ea in av) {
        const legal = axisByName.get(ea)?.legal_values ?? [];
        if (!legal.includes(av[ea]))
          fail("KB", `${m.id}.axis_values.${ea}`, `'${av[ea]}' not in registry legal_values`);
      }
    }
    // enum-SET legality (license_regime)
    for (const r of av.license_regime ?? []) {
      const legal = axisByName.get("license_regime")?.legal_values ?? [];
      if (!legal.includes(r))
        fail("KB", `${m.id}.axis_values.license_regime`, `'${r}' not in registry legal_values`);
    }
  }
}

// --- Check 4: reference integrity -------------------------------------------
function checkReferences() {
  const idx = kb._index;
  const has = (map, id) => id != null && map.has(id);
  for (const m of kb.models ?? []) {
    const cfg = m.configurables ?? {};
    // network module group + members
    const nmgId = cfg.network_modules?.group;
    if (nmgId != null) {
      const g = idx.network_module_groups.get(nmgId);
      if (!g) fail("KB", `${m.id}.configurables.network_modules.group`, `unknown group '${nmgId}'`);
      else for (const mem of g.members ?? [])
        if (!has(idx.network_modules, mem)) fail("KB", `group ${nmgId}.members`, `unknown network_module '${mem}'`);
    }
    // PSU group + valid_primary subset
    const psu = cfg.power_supplies;
    if (psu?.group != null) {
      const g = idx.power_supply_groups.get(psu.group);
      if (!g) fail("KB", `${m.id}.configurables.power_supplies.group`, `unknown group '${psu.group}'`);
      else for (const p of psu.valid_primary ?? [])
        if (!(g.members ?? []).includes(p))
          fail("KB", `${m.id}.power_supplies.valid_primary`, `'${p}' not in PSU group '${psu.group}'`);
    }
    // license group(s)
    const lic = cfg.license;
    for (const gid of [lic?.group, ...(lic?.additional_groups ?? [])].filter(Boolean))
      if (!has(idx.license_groups, gid)) fail("KB", `${m.id}.configurables.license`, `unknown license group '${gid}'`);
    // stack / stackpower cable groups
    if (cfg.stack_cables?.group && !has(idx.stack_cable_groups, cfg.stack_cables.group))
      fail("KB", `${m.id}.configurables.stack_cables.group`, `unknown group '${cfg.stack_cables.group}'`);
    if (cfg.stackpower_cables?.group && !has(idx.stackpower_cable_groups, cfg.stackpower_cables.group))
      fail("KB", `${m.id}.configurables.stackpower_cables.group`, `unknown group '${cfg.stackpower_cables.group}'`);
  }
}

// --- Check 5: derived-value coherence ---------------------------------------
function checkDerived() {
  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    const matrix = m.configurables?.power_supplies?.poe_budget_matrix ?? [];
    if (av.poe_capable === true) {
      const max = matrix.reduce((mx, r) => Math.max(mx, r.poe_budget_watts ?? 0), 0);
      if (av.poe_budget_watts !== max)
        fail("KB", `${m.id}.axis_values.poe_budget_watts`, `is ${av.poe_budget_watts}, matrix max is ${max}`);
    } else if (matrix.length > 0) {
      fail("KB", `${m.id}.poe_budget_matrix`, "non-PoE model must have an empty PoE matrix");
    }
  }
}

checkVersions();
checkRegistrySchema();
checkKbAxisValues();
checkReferences();
checkDerived();

// --- report -----------------------------------------------------------------
if (violations.length === 0) {
  console.log(`PASS — registry v${registry.registry_version}, schema v${schema.schema_version}, ${kb.models.length} models. All checks green.`);
  process.exit(0);
}
console.error(`FAIL — ${violations.length} violation(s):\n`);
for (const v of violations) console.error(`  [${v.file}] ${v.path}\n      ${v.message}`);
process.exit(1);
