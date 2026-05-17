# Changelog

All notable changes to `vergabe-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
