# vergabe-mcp

[![npm version](https://img.shields.io/npm/v/vergabe-mcp.svg)](https://www.npmjs.com/package/vergabe-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/vergabe-mcp.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed.svg)](https://modelcontextprotocol.io)

> Model Context Protocol server for German and EU public-procurement data — query BKMS (oeffentlichevergabe.de) and TED Europa from Claude Code, Claude Desktop, or any MCP-compatible client.

`vergabe-mcp` gives an LLM agent first-class access to German and European public tenders. It exposes four tools over stdio:

| Tool | What it does |
|------|--------------|
| **`vergabe_search_notices`** | Unified search across BKMS + TED with date / CPV / NUTS / country filters and automatic cross-source de-duplication. |
| **`vergabe_get_notice_detail`** | Full notice payload including lots, attachments and on-the-fly PDF text extraction. Disk-cached for 30 days. |
| **`vergabe_list_buyer_history`** | Historical notices from a specific buyer (Vergabestelle) over the last N years. Used by triage skills for a "relationship bonus" on repeat buyers. |
| **`vergabe_download_documents`** | *(stub — implementation in v2.0 for Playbook 02.)* Downloads all Vergabeunterlagen of a notice into a target directory. For now, use `get_notice_detail` and download the URLs manually. |

Both data sources are public and require **no API key**.

> **Migration note (v1.0):** `vergabe_profile_extract` was removed. That logic moved into Skill 1 of the [Vergabe-AI Vault](https://florentinbernhardt.de/vault) where it belongs as a Claude-prompt step rather than an MCP tool.

---

## Install

```bash
# Global (recommended — MCP clients launch the binary by name)
npm install -g vergabe-mcp

# Or local in a project
npm install vergabe-mcp
```

Requires Node.js **20 or later**.

---

## Configure in Claude Desktop

Edit your `claude_desktop_config.json` (location: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "vergabe": {
      "command": "vergabe-mcp"
    }
  }
}
```

Restart Claude Desktop. The three tools appear under the MCP icon.

### Claude Code

Add it via the CLI:

```bash
claude mcp add vergabe vergabe-mcp
```

Or edit `~/.config/claude-code/mcp.json` directly with the same shape as above.

### Optional environment variables

```json
{
  "mcpServers": {
    "vergabe": {
      "command": "vergabe-mcp",
      "env": {
        "VERGABE_MCP_CACHE_DIR": "/Users/you/.vergabe/cache"
      }
    }
  }
}
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERGABE_MCP_CACHE_DIR` | OS temp + `vergabe-mcp-cache/` | Disk cache directory for notice details. |

---

## API reference

### `vergabe_search_notices`

Search notices across both sources.

**Input** (all optional):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `country` | string | `"DE"` | ISO 3166-1 alpha-2 |
| `publication_date_from` | string | – | ISO date, e.g. `2026-05-01` |
| `publication_date_to` | string | – | ISO date |
| `source` | `"oeffentlichevergabe" \| "ted" \| "both"` | `"both"` | |
| `cpv_prefix` | string[] | – | e.g. `["72", "48"]` |
| `nuts` | string[] | – | e.g. `["DE6", "DEF"]` |
| `max_results` | number | `500` | Cap (after de-dup) |

**Output:**

```jsonc
{
  "notices": [{ "id": "...", "source": "ted", "title": "...", "cpv_main": "72000000", "value_eur": 250000, "deadline": "2026-06-15", "url": "..." /* etc. */ }],
  "total": 42,
  "retrieved_at": "2026-05-17T12:00:00.000Z",
  "sources_used": ["oeffentlichevergabe", "ted"],
  "warnings": []
}
```

### `vergabe_get_notice_detail`

Fetch one notice's full payload, including lots and attachments. PDF attachments are downloaded and text-extracted in a single call.

**Input:**

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `notice_id` | string | yes | – |
| `source` | `"oeffentlichevergabe" \| "ted"` | yes | – |
| `include_pdfs` | boolean | no | `true` |

**Output:** the full `NoticeDetail` shape (lots, attachments with `extracted_text`, raw OCDS JSON or eForms XML when available) plus `cache_hit` and `warnings`.

### `vergabe_list_buyer_history`

Lists historical notices from a specific buyer (Vergabestelle) over the last N years. Used downstream by the notice-triage skill in the Vergabe-AI Vault to compute a "relationship bonus" for repeat buyers — buyers who have published in your space before are warmer leads than cold ones.

Internally this is a thin wrapper over `vergabe_search_notices`: a broad date-window search followed by tolerant client-side buyer-name matching (case-insensitive, whitespace-collapsed, substring), since neither BKMS nor TED expose a stable structured buyer-name query parameter that works across both sources.

**Input:**

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `buyer_name` | string | yes | – |
| `limit` | number | no | `20` (max 200) |
| `years_back` | number | no | `2` (max 10) |

**Output:**

```jsonc
{
  "notices": [/* same Notice shape as search_notices, newest first */],
  "total": 12,
  "buyer_query": "Freie und Hansestadt Hamburg",
  "retrieved_at": "2026-05-17T12:00:00.000Z",
  "sources_used": ["oeffentlichevergabe", "ted"],
  "warnings": []
}
```

### `vergabe_download_documents` *(stub — v2.0)*

Downloads all Vergabeunterlagen (Leistungsverzeichnis, EVB-IT, Anlagen) of a notice into a target directory.

This tool ships in v1.0 with a stub body so the API surface is locked. The full implementation arrives in v2.0 alongside Playbook 02 of the Vergabe-AI Vault. Until then, fetch the document URLs via `get_notice_detail` and download them manually.

**Input:**

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `notice_id` | string | yes | – |
| `target_dir` | string | yes | – |
| `source` | `"BKMS" \| "TED"` | no | `"BKMS"` |

**Output (stub):**

```jsonc
{
  "status": "not_yet_implemented",
  "message": "Document download is part of Playbook 02 (vergabe-mcp v2.0). For now, fetch the document URLs via get_notice_detail and download manually."
}
```

---

## Data sources

- **BKMS / oeffentlichevergabe.de Open Data** — OCDS-JSON, anonymous. [Swagger UI](https://oeffentlichevergabe.de/documentation/swagger-ui/opendata/index.html)
- **TED Europa Search API v3** — JSON + eForms XML, anonymous. [Docs](https://docs.ted.europa.eu/api/)

Per-host rate limits are respected by the HTTP client (1 req/sec each, exponential backoff on 429/5xx).

---

## Architecture

```
src/
├── index.ts                       MCP server entry (stdio transport)
├── tools/
│   ├── search_notices.ts          BKMS + TED unified search with de-dup
│   ├── get_notice_detail.ts       Detail + PDF extract + 30d disk cache
│   ├── list_buyer_history.ts     Buyer-filtered history wrapper
│   └── download_documents.ts      v1.0 stub; full impl in v2.0
├── sources/
│   ├── oeffentlichevergabe.ts     OCDS-JSON adapter
│   └── ted.ts                     TED Search v3 adapter
├── lib/
│   ├── http.ts                    axios + retry + per-host rate-limit
│   ├── cache.ts                   Disk cache (30d TTL)
│   └── pdf.ts                     pdfjs-dist text extraction
└── schemas/
    └── notice.ts                  Unified Notice Zod schema
```

---

## Status

`v1.0.0` — first locked public API surface. `vergabe_download_documents` ships as a stub: the API contract is final, the body lands in v2.0. A few BKMS endpoint paths are based on conservative defaults from the OCDS Open Data conventions and are flagged with `// TODO` in `src/sources/oeffentlichevergabe.ts`. Issues and PRs welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to file bugs or open PRs.

---

## License

[MIT](./LICENSE) © 2026 Florentin Bernhardt

---

## Author

**Florentin Bernhardt** — AI Engineer & Product Manager, Hamburg.
Part of the [Vergabe-AI Vault](https://florentinbernhardt.de/vault) — a public collection of Claude skills, MCP servers and prompts for German public procurement.

- Website: [florentinbernhardt.de](https://florentinbernhardt.de)
- GitHub: [@xCelosx](https://github.com/xCelosx)
