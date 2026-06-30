// validate-kb.mjs — registry -> schema -> KB consistency validator.
//
// The three knowledge files are a projection chain; this tool is the mechanical
// guard that keeps them honest (it replaces the phantom "validate2.py" the docs
// historically referenced). It REUSES the solver's own loaders/index so it
// validates the exact structures the engine consumes.
//
// Run: `npm run validate`  (or `node selector/tools/validate-kb.mjs`)
// Exit 0 = all checks pass; 1 = at least one violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { buildIndex } from "../js/core/kb.js";
import { getAxes, isCountAtLevelAxis, portModel } from "../js/core/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWITCHING = resolvePath(HERE, "../../DB/switching");
const C9300_DIR = resolvePath(SWITCHING, "C9300");

const violations = [];
const fail = (file, path, message) => violations.push({ file, path, message });
const readJSON = (fullPath) => JSON.parse(readFileSync(fullPath, "utf8"));

const registry = readJSON(resolvePath(SWITCHING, "switching-axes.json"));
const schema = readJSON(resolvePath(C9300_DIR, "switch-kb.schema.json"));
const kb = readJSON(resolvePath(C9300_DIR, "c9300_knowledge_base.json"));
kb._index = buildIndex(kb);

const axes = getAxes(registry);
const axisByName = new Map(axes.map((a) => [a.name, a]));
const pm = portModel(registry);
const LEGAL_ROLE = new Set(pm?.selector_enums?.port_role ?? []);
const LEGAL_MEDIUM = new Set(pm?.selector_enums?.port_medium ?? []);
const LEGAL_SPEED = new Set(pm?.selector_enums?.port_speed?.order ?? []);

// --- Check 1: versions agree ------------------------------------------------
function checkVersions() {
  if (kb.header?.registry_version !== registry.registry_version)
    fail("KB", "header.registry_version", `KB ${kb.header?.registry_version} vs registry ${registry.registry_version}`);
  if (kb.header?.schema_version !== schema.schema_version)
    fail("KB", "header.schema_version", `KB ${kb.header?.schema_version} vs schema ${schema.schema_version}`);
  if (schema.registry_version !== registry.registry_version)
    fail("schema", "registry_version", `schema ${schema.registry_version} vs registry ${registry.registry_version}`);
}

// --- Check 2: registry <-> schema axis_values projection --------------------
// Scalar axes (kind != count-at-level) must project to a schema axis_values
// property. Parametrised port axes must NOT (they resolve against model.ports).
function checkRegistrySchema() {
  const props = schema?.$defs?.axis_values?.properties ?? {};
  for (const axis of axes) {
    if (isCountAtLevelAxis(axis)) {
      if (axis.name in props)
        fail("schema", `axis_values.${axis.name}`, "parametrised port axis must not be a stored axis_values field");
      continue;
    }
    if (!(axis.name in props))
      fail("schema", "axis_values.properties", `registry axis '${axis.name}' has no schema projection`);
  }
  for (const p of Object.keys(props)) {
    if (p === "_comment") continue;
    if (!axisByName.has(p)) fail("schema", `axis_values.${p}`, "schema field is not a registered axis");
  }
  for (const r of schema?.$defs?.axis_values?.required ?? [])
    if (!axisByName.has(r)) fail("schema", "axis_values.required", `requires '${r}', not a registered axis`);
  // poe_type.level_watts must cover every non-'none' level (drives the demand translation)
  const pt = axisByName.get("poe_type");
  for (const lv of pt?.legal_values ?? [])
    if (lv !== "none" && !(pt.level_watts && lv in pt.level_watts))
      fail("registry", "poe_type.level_watts", `missing per-port watts for '${lv}'`);
}

// --- Check 3: KB axis_values <= registry ------------------------------------
const SCALAR_ENUMS = ["series", "poe_type", "stacking_technology"];
function checkKbAxisValues() {
  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    for (const key of Object.keys(av)) {
      if (key === "_comment") continue;
      const axis = axisByName.get(key);
      if (!axis) { fail("KB", `${m.id}.axis_values.${key}`, "not a registered axis"); continue; }
      if (isCountAtLevelAxis(axis))
        fail("KB", `${m.id}.axis_values.${key}`, "parametrised port axis must not be stored (resolves via model.ports)");
    }
    for (const axis of axes)
      if (axis.required_on_model === true && !(axis.name in av))
        fail("KB", `${m.id}.axis_values`, `missing required axis '${axis.name}'`);
    if (av.stacking_capable === true && !("stacking_technology" in av))
      fail("KB", `${m.id}.axis_values`, "stacking_capable=true requires stacking_technology");
    if (av.poe_capable === true && !("poe_budget_watts" in av))
      fail("KB", `${m.id}.axis_values`, "poe_capable=true requires poe_budget_watts");
    for (const ea of SCALAR_ENUMS)
      if (ea in av && !(axisByName.get(ea)?.legal_values ?? []).includes(av[ea]))
        fail("KB", `${m.id}.axis_values.${ea}`, `'${av[ea]}' not in registry legal_values`);
    for (const r of av.license_regime ?? [])
      if (!(axisByName.get("license_regime")?.legal_values ?? []).includes(r))
        fail("KB", `${m.id}.axis_values.license_regime`, `'${r}' not in registry legal_values`);
    for (const t of av.license_tier ?? [])
      if (!(axisByName.get("license_tier")?.legal_values ?? []).includes(t))
        fail("KB", `${m.id}.axis_values.license_tier`, `'${t}' not in registry legal_values`);
    // license_tier must equal the union of the model's license-group tiers (guards the duplication)
    const lic = m.configurables?.license;
    if (lic) {
      const union = new Set([lic.group, ...(lic.additional_groups ?? [])].filter(Boolean)
        .map((g) => kb._index.license_groups.get(g)?.tier).filter(Boolean));
      const declared = new Set(av.license_tier ?? []);
      if (union.size !== declared.size || [...union].some((t) => !declared.has(t)))
        fail("KB", `${m.id}.axis_values.license_tier`, `offered [${[...declared]}] != license-group tiers [${[...union]}]`);
    }
  }
}

// --- Check 4: port-group integrity (v0.4.0 port model) ----------------------
function checkPortGroup(file, where, p, allowedRoles) {
  if (!LEGAL_ROLE.has(p.role)) fail(file, `${where}.role`, `'${p.role}' not a legal port_role`);
  else if (!allowedRoles.has(p.role)) fail(file, `${where}.role`, `role '${p.role}' not allowed here`);
  if (!LEGAL_MEDIUM.has(p.medium)) fail(file, `${where}.medium`, `'${p.medium}' not a legal port_medium`);
  for (const s of p.speeds ?? [])
    if (!LEGAL_SPEED.has(s)) fail(file, `${where}.speeds`, `'${s}' not a legal port_speed`);
  if (!(Number.isInteger(p.count) && p.count >= 1)) fail(file, `${where}.count`, `bad count ${p.count}`);
}

function checkPorts() {
  // catalog modules: ports are role=uplink only
  for (const nm of kb.catalog?.network_modules ?? [])
    (nm.ports ?? []).forEach((p, i) => checkPortGroup("KB", `module ${nm.id}.ports[${i}]`, p, new Set(["uplink"])));

  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    const modular = av.uplink_modular === true;
    // modular models carry access only; fixed-uplink models may carry uplink rows too
    const allowed = modular ? new Set(["access"]) : new Set(["access", "uplink"]);
    (m.ports ?? []).forEach((p, i) => checkPortGroup("KB", `${m.id}.ports[${i}]`, p, allowed));

    // sum of access ports == total_port_count
    const accessSum = (m.ports ?? []).filter((p) => p.role === "access").reduce((s, p) => s + p.count, 0);
    if (accessSum !== av.total_port_count)
      fail("KB", `${m.id}.ports`, `access port sum ${accessSum} != total_port_count ${av.total_port_count}`);

    // uplink_modular <-> network_modules presence
    const hasNM = !!m.configurables?.network_modules;
    if (modular && !hasNM) fail("KB", `${m.id}.configurables`, "uplink_modular=true but no network_modules group");
    if (!modular && hasNM) fail("KB", `${m.id}.configurables`, "uplink_modular=false but has a network_modules group");
    if (!modular && !(m.ports ?? []).some((p) => p.role === "uplink"))
      fail("KB", `${m.id}.ports`, "fixed-uplink model must carry role=uplink port rows inline");
  }
}

// --- Check 5: reference integrity -------------------------------------------
function checkReferences() {
  const idx = kb._index;
  const has = (map, id) => id != null && map.has(id);
  for (const m of kb.models ?? []) {
    const cfg = m.configurables ?? {};
    const nmgId = cfg.network_modules?.group;
    if (nmgId != null) {
      const g = idx.network_module_groups.get(nmgId);
      if (!g) fail("KB", `${m.id}.configurables.network_modules.group`, `unknown group '${nmgId}'`);
      else for (const mem of g.members ?? [])
        if (!has(idx.network_modules, mem)) fail("KB", `group ${nmgId}.members`, `unknown network_module '${mem}'`);
    }
    const psu = cfg.power_supplies;
    if (psu?.group != null) {
      const g = idx.power_supply_groups.get(psu.group);
      if (!g) fail("KB", `${m.id}.configurables.power_supplies.group`, `unknown group '${psu.group}'`);
      else for (const p of psu.valid_primary ?? [])
        if (!(g.members ?? []).includes(p))
          fail("KB", `${m.id}.power_supplies.valid_primary`, `'${p}' not in PSU group '${psu.group}'`);
      if (psu.default_primary && !(psu.valid_primary ?? []).includes(psu.default_primary))
        fail("KB", `${m.id}.power_supplies.default_primary`, `'${psu.default_primary}' not in valid_primary`);
    }
    const lic = cfg.license;
    for (const gid of [lic?.group, ...(lic?.additional_groups ?? [])].filter(Boolean))
      if (!has(idx.license_groups, gid)) fail("KB", `${m.id}.configurables.license`, `unknown license group '${gid}'`);
    if (cfg.stack_cables?.group && !has(idx.stack_cable_groups, cfg.stack_cables.group))
      fail("KB", `${m.id}.configurables.stack_cables.group`, `unknown group '${cfg.stack_cables.group}'`);
    if (cfg.stackpower_cables?.group && !has(idx.stackpower_cable_groups, cfg.stackpower_cables.group))
      fail("KB", `${m.id}.configurables.stackpower_cables.group`, `unknown group '${cfg.stackpower_cables.group}'`);
  }
}

// --- Check 6: derived-value coherence ---------------------------------------
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
checkPorts();
checkReferences();
checkDerived();

if (violations.length === 0) {
  console.log(`PASS — registry v${registry.registry_version}, schema v${schema.schema_version}, ${kb.models.length} models. All checks green.`);
  process.exit(0);
}
console.error(`FAIL — ${violations.length} violation(s):\n`);
for (const v of violations) console.error(`  [${v.file}] ${v.path}\n      ${v.message}`);
process.exit(1);
