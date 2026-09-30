# PropGenie Usage Dashboard

Tracks every PropAccount customer's PropGenie API usage: tokens and $ spend per model, per tool, per client.

```bash
npm run seed    # demo data (24 clients, 120 days)
npm start       # http://localhost:5890
npm run reset   # wipe everything before going live
```

Requires Node ≥ 22.5 (uses built-in `node:sqlite`, zero dependencies). Data lives in `data/usage.db`.

## Screens
- **Overview** (`#/`) — total spend, tokens, requests, active clients, credits billed, gross margin; a card per model with tokens + $; per-model token table; daily usage chart (spend / tokens / requests); top clients; spend by tool.
- **Clients** (`#/clients/:id`) — searchable client list; per-client KPIs, spend by model, tool × model breakdown (click a row to filter), daily chart, and a filterable/sortable usage log with CSV export.
- Date range (7D / 30D / 90D / MTD / All / custom) applies everywhere.

## Sending usage from PropGenie
`POST /api/usage` with header `x-ingest-key: $INGEST_KEY` (dev default `pg-usage-dev-key`). Body is one event or an array:

```json
{ "client_id": "cl_acme", "client_name": "Acme Funding", "plan": "Pro",
  "tool": "Social Post Writer", "model": "genie-pro",
  "input_tokens": 2140, "output_tokens": 612, "cached_tokens": 0, "images": 0,
  "request_id": "req_8f2c1", "ts": "2026-09-30T14:02:11Z" }
```

`model` ∈ `genie-pro`, `genie-flash`, `genie-canvas`, `genie-vision`, `webbuilder`. Cost and credits are computed from `lib/pricing.js` (1 credit = $0.01, 5× markup, rounded up) unless `cost_usd` / `credits` are sent. `request_id` is deduplicated so retries are safe; unknown clients are created automatically.

Env: `PORT` (5890), `INGEST_KEY`, `DB_PATH`.
