# PropGenie Usage Dashboard

Every PropAccount customer's PropGenie usage: credits, USD spend, uses per service/tool, wallet balances, purchases and the full usage ledger — read live from the **FPFX Wallet API** (`wallet.fpfxtech.io`). The Wallet `tenantName` is the firm shortcut (e.g. `MENT`); it is shown as the client name via `CLIENT_NAMES` (shortcut → name JSON, from the client sheet) or the git-ignored `config/client-names.local.json`. The client list is confidential and never committed. `TENANT_NAMES` (uuid → name) overrides both.

```bash
npm start       # http://localhost:5890 (reads .env.local)
npm run seed    # rebuild demo data (used when no Wallet token is set)
npm run mock    # spec-shaped mock Wallet API on :5899 for offline testing
```

Requires Node ≥ 22.5 (built-in `node:sqlite`, zero dependencies).

## Data
| Mode | When | Source |
|---|---|---|
| **Live** | `WALLET_API_TOKEN` set | Wallet API, GET requests only, cached `CACHE_MINUTES` (15) per instance; **Refresh** clears the cache |
| **Demo** | no token | seeded `data/usage.db` |

Wallet endpoints used: `/v1/Wallets`, `/v1/Tenants/{id}/consumption` (interval 0 = daily), `/wallet`, `/balance`, `/ledger`, `/v1/Orders/{id}`, `/v1/Services`, `/v1/Config/settings` (WooCommerce secrets are dropped), `/v1/Config/token-rates`, `/v1/Products`.

Known Wallet API gaps:
- **No per-model LLM tokens** in the ledger (`llm`, `tokensIn`, `tokensOut` are accepted on consumption but never returned). The dashboard shows them automatically once the ledger includes those fields.
- "Est. API cost" = customer spend × (1 − `markupPercent`).
- Spend counts tool usage (consumption reports). Manual admin debits appear in `/v1/Wallets` "spent" but not in consumption; the overview shows that gap separately.

## Screens
- **Overview** — spend, credits, est. API cost, uses, active customers, wallet balances; usage per service; daily chart (spend / credits / uses); top customers.
- **Clients** — searchable customer list; per-customer totals, wallet & auto-renewal, usage by service (click to filter), daily chart, credit purchases, paginated usage ledger with CSV export.
- **Settings** — data source status, credit pricing & markup, LLM token rates, services, credit packages.

## Environment
See `.env.example`. On Vercel, live data is refused until Cloudflare Access is configured (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`); every `/api` request then requires a valid Access JWT.
