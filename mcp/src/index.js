// index.js — the Stage-2 MCP server: a stateless Worker over the unchanged
// solver core (selector/docs/mcp-solver-contract.md is normative).
//
// Exactly two tools. No guided/dialogue surface: the selector is stateless and
// never asks questions — open_variables in every find_configurations response
// is the client agent's follow-up-question list. Queries are built ONLY via
// core/query.js; this file contains no selection logic.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";

import { registry, kb } from "./data.js";
import { findConfigurationsShape, lookupModelShape } from "./schema.js";
import { trimResponse, nearestModels } from "./respond.js";
import { solve } from "../../selector/js/core/solver.js";
import { constraint, portConstraint, translatePoeDemand, validateQuery } from "../../selector/js/core/query.js";

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (obj) => ({ ...json(obj), isError: true });

function createServer() {
  const server = new McpServer({
    name: "switch-selector",
    version: registry.registry_version,
  });

  server.registerTool(
    "lookup_model",
    {
      title: "Look up one switch model",
      description:
        "Exact-model lookup: returns the model's full option summary — uplink modules with port capabilities, PSU configurations with the PoE-budget matrix, license groups and terms, cables — as a resolved default BOM plus per-candidate choice domains (the datasheet summary without the datasheet). Unknown ids return an error listing the closest known ids.",
      inputSchema: lookupModelShape(),
    },
    async ({ model }) => {
      const res = solve([constraint("model_id", "==", model)], kb, registry);
      if (res.candidates.length === 0)
        return fail({
          error: `unknown model id '${model}'`,
          nearest_known_ids: nearestModels(kb.models, model),
          hint: "retry lookup_model with one of nearest_known_ids, or use find_configurations to search by requirements",
        });
      return json(trimResponse(res, [{ variable: "model_id", condition: "==", value: model }], registry, 1));
    },
  );

  server.registerTool(
    "find_configurations",
    {
      title: "Find switch configurations from requirements",
      description:
        "Solve customer requirements into complete, orderable switch configurations (model + fitted uplink option + PSUs + license SKUs + cables), each default choice carrying its reason. The response also returns open_variables — every decision the query left open, with its remaining domain and default; entries flagged must_resolve (license regime/tier/term) have NO safe default and must be settled with the user before a bill of materials is final: ask, then re-call with the answer added to requirements. State demands as the customer gives them (counts and levels); never pre-compute watts.",
      inputSchema: findConfigurationsShape(registry),
    },
    async ({ requirements, poe_demand, port_demand, limit }) => {
      const query = [];
      for (const r of requirements ?? []) query.push(constraint(r.variable, r.condition, r.value));
      query.push(...translatePoeDemand(poe_demand ?? [], registry));
      for (const p of port_demand ?? []) {
        const where = { speed: p.speed };
        if (p.role) where.role = p.role;
        if (p.medium) where.medium = p.medium;
        query.push(portConstraint(where, ">=", p.count));
      }
      if (query.length === 0)
        return fail({ error: "empty query: provide requirements, poe_demand, or port_demand" });

      const problems = validateQuery(query, registry);
      if (problems.length)
        return fail({ error: "invalid query", problems }); // verbatim: the text names the legal values

      return json(trimResponse(solve(query, kb, registry), query, registry, limit ?? 5));
    },
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "")
      return new Response(
        "switch-selector MCP server (registry v" + registry.registry_version + "). MCP endpoint: POST /mcp (streamable HTTP).\n",
        { headers: { "content-type": "text/plain" } },
      );
    return createMcpHandler(createServer())(request, env, ctx);
  },
};
