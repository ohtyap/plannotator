# Plannotator CLI agent guidance

This fork ships two commands: `plannotator review` for local checkouts and
patches, and `plannotator annotate` for documents and web pages. The standalone
browser UIs and Bun server are the product. Do not add agent host hooks,
plugins, Inbox, or PR forge automation. Review agent, Guided Review, and
standalone Ask AI are supported review features.

## Rules

- Keep the existing review and document UIs. Read `packages/ui/AGENTS.md` and
  `packages/ui/README.md` when changing the shared UI.
- Build review before annotate; the annotate build copies the built review page
  and its assets. Use `bun run build:cli` for an executable.
- Add a Tailwind `@source` entry when introducing a new directory of styled
  `.tsx` files outside the existing scan paths.
- Test with a scratch home and `PLANNOTATOR_DATA_DIR`. Use `NO_BROWSER` from
  `tests/helpers/no-browser.ts`, not a browser-setting sentinel. Tests must
  never launch the real GitHub CLI or real agents. Use `bun run test:sandbox`
  for targeted runs.
- Test observable behavior, not snapshots of prose or round trips of props.
- Never rebase or force-push a shared branch. Do not include AI attribution or
  session links in commits, tags, release notes, or PR descriptions.

See [development and testing](docs/agent-guides/project-and-development.md) for
the repository map and build/test commands.
