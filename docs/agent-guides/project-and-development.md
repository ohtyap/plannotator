# Development

| Path | Role |
| --- | --- |
| `apps/cli/server/` | CLI parsing, review and annotate launch, and decision output |
| `apps/cli/` | Annotate UI entry point and assembly of binary assets |
| `apps/review/` | Review UI entry point, diagram engine, and semantic diff assets |
| `packages/server/` | Bun HTTP server, filesystem access, local VCS, and AI jobs |
| `packages/review-editor/` | Code review UI |
| `packages/editor/` | Document annotation UI |
| `packages/guide-viewer/` | Guided Review UI |
| `packages/ui/`, `packages/core/`, `packages/shared/` | Shared components and browser-safe and server helpers |
| `packages/ai/` | OpenCode V2 HTTP client and Ask AI sessions |

```sh
bun install --frozen-lockfile
bun run build:cli
bun run typecheck
bun run test
bun run test:cli
```

`bun run dev:review` and `bun run dev:annotate` start the individual Vite apps.
After building the browser assets, `bun apps/cli/server/index.ts` runs the CLI
from source. `bun run test:sandbox path/to/file.test.ts` runs a targeted test
under a temporary home and data directory. Prefix it with `DOM_TESTS=1` for
tests that need happy-dom. Add `-- --timeout=20000` to pass a runner option.

`bun run test:cli` exercises the compiled binary in scratch repositories and
documents without launching the system browser. Set `PLANNOTATOR_TEST_BINARY`
to explicitly test a different compiled executable.

For browser checks, run `bun run test:e2e` after building the binary and
installing Playwright browsers and their system dependencies. The Playwright
runner uses Node.js; the CLI itself does not.

## GitHub releases

This fork uses its own `vX.Y.Z` tags. The root `package.json` is the only CLI
version source. Bump it, merge the change to `main`, then tag that commit and
push the tag to `ohtyap/plannotator`. For example, for `0.1.0`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The **Linux release** workflow builds and smoke-tests Linux ARM64 and x64
on native runners. After both pass, it publishes the two binaries and
`SHA256SUMS` to the tag's GitHub Release. It never uploads over an existing
release; use a new version to fix a published build. To test the workflow
without publishing, use **Run workflow** in GitHub Actions and download the
per-architecture artifacts from that run.
