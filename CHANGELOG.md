# Changelog

All notable changes to `vergabe-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-18

Data-source adapters rewritten against the real live APIs after v1.0.0 smoke
tests exposed both BKMS and TED paths as broken. The MCP protocol layer,
tool signatures, and Notice schema are unchanged — this is a non-breaking
fix for end users, but the internal source implementations are now completely
different.

### Changed (breaking — internal only)
- `src/sources/oeffentlichevergabe.ts` rewritten. There is no JSON search
  endpoint on oeffentlichevergabe.de; the public Open Data interface is a
  per-day CSV-ZIP bulk export at
  `GET /api/notice-exports?pubDay=YYYY-MM-DD&format=csv.zip`. We now download
  per day, unzip into ~10 CSV tables (notice, purpose, organisation,
  classification, placeOfPerformance, lot, procedure, duration,
  submissionTerms, ...), join them by `(noticeIdentifier, noticeVersion)`,
  filter by competition notice types, and apply CPV/NUTS/country filters
  client-side. Notice details fetched via
  `GET /api/notices/{notice_id}` with `Accept: application/xml`. Yesterday is
  the latest available day; today is never served. Ported from the working
  Python reference at `gemeinsambieten/backend/app/services/doe_client.py`.
- `src/sources/ted.ts` rewritten. Field names corrected
  (`buyer-country = DEU` instead of `country = DE`, ISO-3 not ISO-2),
  date format corrected (`YYYYMMDD`, not ISO), pagination switched to
  `ITERATION` mode with `iterationNextToken`, `limit` capped at 100 per the
  API. The v3 search endpoint returns structured JSON per notice (no
  base64-eForms blob); we map fields directly and avoid XML parsing for
  search. Detail endpoint uses the same search by `publication-number` and
  optionally pulls raw XML via `links.xml.MUL`.
- `src/tools/download_documents.ts` source enum lowercased to
  `"oeffentlichevergabe" | "ted"` for consistency with the other tools.

### Added
- `jszip` and `papaparse` (+ `@types/papaparse`) as runtime dependencies for
  the BKMS CSV-ZIP pipeline.
- BKMS `User-Agent` header (`vergabe-mcp/1.1.0`) on every request.
- Retry with exponential backoff (2s, 4s, 8s) on BKMS ZIP downloads;
  graceful skip on weekend/holiday days that return 404/204.
- Best-effort latin1 -> UTF-8 repair for the few TED German strings the v3
  API double-encodes.

### Fixed
- `vergabe_search_notices` no longer returns 0 results with HTTP 404 / 400
  warnings — both sources now return live data.
- `vergabe_get_notice_detail` (BKMS path) works against the eForms XML
  endpoint; previously returned `null`.

## [1.0.0] - 2026-05-17

First locked public API surface — safe to publish to npm.

### Added
- `vergabe_list_buyer_history` — list historical notices from a specific
  Vergabestelle over the last N years. Wraps `search_notices` with
  tolerant client-side buyer-name matching.
- `vergabe_download_documents` — **stub** that locks the v1.0 API surface.
  Full implementation lands in v2.0 alongside Playbook 02 of the
  Vergabe-AI Vault. Currently returns `not_yet_implemented`.

### Removed (breaking)
- `vergabe_profile_extract` — removed. That logic moved into Skill 1 of
  the Vergabe-AI Vault where it belongs as a Claude-prompt step rather
  than an MCP tool. Dropped the unused `@anthropic-ai/sdk`, `mammoth`
  and `cheerio` runtime dependencies that only existed for this tool.

### Changed
- `package.json` description updated to reflect the four-tool surface.

## [0.1.0] - 2026-05-17

Initial functional release.

### Added
- `vergabe_search_notices` — unified search across BKMS
  (oeffentlichevergabe.de) and TED Europa with date / CPV / NUTS /
  country filters and automatic cross-source de-duplication.
- `vergabe_get_notice_detail` — full notice payload including lots,
  attachments and on-the-fly PDF text extraction. Disk-cached for 30 days.
- `vergabe_profile_extract` — *(removed in 1.0)* distilled a structured
  match profile from product documents plus historical example notices.
