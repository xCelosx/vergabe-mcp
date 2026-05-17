# Contributing to vergabe-mcp

Thanks for thinking about contributing. This project is small and opinionated — keeping it that way is part of the point. The guidelines below describe the smallest changes that get a PR merged quickly.

## Bug reports

Open a [GitHub issue](https://github.com/xCelosx/vergabe-mcp/issues/new?template=bug_report.md) with:

1. What you tried (tool name + input args, or the MCP client config).
2. What you expected.
3. What actually happened (full error output, plus stderr lines starting with `[vergabe-mcp]`).
4. `node --version`, `vergabe-mcp --version` (or `npm ls vergabe-mcp`), OS.

Logs go to **stderr** because stdout is the MCP wire protocol — capture both when reporting.

## Feature requests

Open a [feature request issue](https://github.com/xCelosx/vergabe-mcp/issues/new?template=feature_request.md). Describe the use-case first, the API second. We are biased toward small, composable tools rather than large multi-purpose ones.

## Pull requests

1. Fork and create a topic branch: `feature/your-thing` or `fix/your-thing`.
2. Keep the diff focused. One PR = one concern.
3. Match the existing code style (see below).
4. Run the test plan below and paste the result in the PR description.
5. Update `README.md` if you change a public input/output schema.

### Code style

- **TypeScript strict.** No `any` unless it is justified in a comment.
- **ESM only.** All relative imports use the `.js` suffix (compiled output), e.g. `import { foo } from "../lib/http.js"`.
- **Logging to stderr.** Never `console.log` — use `console.error` so stdout stays clean for the MCP protocol.
- **No new runtime dependencies** unless they replace something or unlock a clearly requested feature.
- **Comments in English.** The codebase is English-only; user-facing tool descriptions may be German.
- **Zod for input validation.** Every tool entry point parses its input through a Zod schema.

### Test plan before submitting

```bash
# Build cleanly
npm run build

# Smoke-test the server boots
node dist/index.js < /dev/null
# Expect on stderr: "[vergabe-mcp] v0.1.0 ready on stdio (...)"
# Then Ctrl-C.

# (Optional) Wire it into Claude Desktop / Claude Code and run a real
# `vergabe_search_notices` call against your branch.
```

Automated tests are not yet in place — if you add a feature you can reasonably cover with a small script under `test/`, please do.

## Releases

Maintainer-only:

```bash
npm version patch   # or minor / major
npm publish
git push --follow-tags
```

`prepublishOnly` runs `tsc` so the published tarball always contains a fresh `dist/`.
