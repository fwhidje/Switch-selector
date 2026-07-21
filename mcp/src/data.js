// data.js — the bundled data snapshot, merged once at module scope.
//
// The Worker fetches nothing at runtime: wrangler bundles these JSON imports at
// deploy time, so a deploy IS a KB snapshot (contract §3, §6). Imports must be
// static, so each family KB is listed here explicitly; families.json is
// imported too and cross-checked below so a new family added to the data layer
// without a matching import fails loudly instead of silently shipping short.

import registryJson from "../../DB/switching/switching-axes.json" with { type: "json" };
import familiesJson from "../../DB/switching/families.json" with { type: "json" };
import c9300 from "../../DB/switching/C9300/c9300_knowledge_base.json" with { type: "json" };
import c9350 from "../../DB/switching/C9350/c9350_knowledge_base.json" with { type: "json" };
import c9200 from "../../DB/switching/C9200/c9200_knowledge_base.json" with { type: "json" };
import ms from "../../DB/switching/MS/ms_knowledge_base.json" with { type: "json" };
import c9500 from "../../DB/switching/C9500/c9500_knowledge_base.json" with { type: "json" };
import c9550 from "../../DB/switching/C9550/c9550_knowledge_base.json" with { type: "json" };

import { mergeKBs } from "../../selector/js/core/kb.js";

const bundled = { C9300: c9300, C9350: c9350, C9200: c9200, MS: ms, C9500: c9500, C9550: c9550 };

const missing = familiesJson.map((f) => f.series).filter((s) => !(s in bundled));
if (missing.length)
  throw new Error(`families.json lists ${missing.join(", ")} but mcp/src/data.js does not import them — add the import(s)`);

export const registry = registryJson;
export const kb = mergeKBs(familiesJson.map((f) => bundled[f.series]));
