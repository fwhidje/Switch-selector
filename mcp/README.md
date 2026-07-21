# Switch-Selector MCP Server (Stage 2)

A **remote, authless MCP server** exposing the selector's solver to AI agents over streamable
HTTP. It is a thin renderer of the Stage-1 contract — the solver core (`../selector/js/core/`)
and the KB (`../DB/switching/`) are imported unchanged; **`../selector/docs/mcp-solver-contract.md`
is the normative boundary document.** Runs as a stateless Cloudflare Worker
(`createMcpHandler`, no bindings) on the Workers free plan.

## Tools

- **`lookup_model`** `{model}` — exact-model option summary (uplink modules, PSU/PoE matrix,
  license groups & terms, cables) as a resolved default BOM. Unknown ids error with the
  nearest known ids.
- **`find_configurations`** `{requirements?, poe_demand?, port_demand?, limit?}` — solve
  requirements into complete orderable configurations. The input schema is **generated from
  the registry** (`switching-axes.json`): every variable, legal value, and condition is
  visible in the tool definition. `open_variables` in the response is the agent's
  "what to ask next" list; `must_resolve` entries (license regime/tier/term) have no safe
  default and must be settled before a BOM is final. There is deliberately no guided tool —
  dialogue is the client agent's job over `open_variables`.

## Run locally

```bash
cd mcp && npm install
npm run dev                     # wrangler dev → http://localhost:8787/mcp
npx @modelcontextprotocol/inspector   # point it at http://localhost:8787/mcp
```

## Deploy (one-time setup)

1. Create a free Cloudflare account; choose your `*.workers.dev` subdomain.
2. Create an API token: dash → My Profile → API Tokens → template **"Edit Cloudflare Workers"**.
3. Add two GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   (account id: dash → Workers & Pages, right sidebar).

CI then deploys automatically on every push to `main` **after** `validate-kb` passes — a
deploy is a snapshot of a validated KB (the JSON is bundled at build time; nothing is fetched
at runtime). Until the secrets exist the deploy job skips with a notice. Manual deploy:
`cd mcp && npx wrangler login && npm run deploy`.

The server URL is `https://switch-selector-mcp.<your-subdomain>.workers.dev/mcp`.

## Connect an agent

- **Claude Code**: `claude mcp add --transport http switch-selector <url>`
- **claude.ai** (web/desktop): Settings → Connectors → Add custom connector → paste the URL.
  Note: *org-managed* connectors currently assume OAuth; if an authless URL is refused, add a
  static bearer check in `src/index.js` and configure the header in the connector's
  request-header auth settings.
- Anything else that speaks MCP over streamable HTTP: point it at `/mcp`.

## Layout

```
wrangler.jsonc   Worker config — stateless, no bindings, nodejs_compat
src/data.js      bundled KB snapshot: static JSON imports → mergeKBs() once at module scope
src/schema.js    registry → zod projection: the tool input schemas, never hand-maintained
src/respond.js   transport shaping (contract §5): candidate cap, eliminated summary,
                 open_variables whole + ask_priority/depends_on, query_echo; near-miss ranking
src/index.js     the two tools; queries built ONLY via core/query.js
```

Adding a switch family: add it to `families.json` + the KB file as usual, and add the matching
static import in `src/data.js` (the boot check fails loudly if you forget).
