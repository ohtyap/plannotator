---
name: release-plannotator
description: Prepare or verify a GitHub release of this fork's standalone Linux CLI.
---

# Release the Linux CLI

This fork's release process is documented in
[`docs/agent-guides/project-and-development.md`](../../../docs/agent-guides/project-and-development.md#github-releases).
Do not use upstream version numbers, publish packages, or generate release notes.

1. Confirm the requested version. Update only the root `package.json` version.
2. Run `bun install --frozen-lockfile`, `bun run build:cli`, and `bun run test:cli`.
3. Once the version is on `main`, create and push the matching `vX.Y.Z` tag
   only when the user has asked to publish. The workflow publishes only after
   both native Linux builds pass their smoke tests.
4. Verify the release has `plannotator-linux-arm64`, `plannotator-linux-x64`,
   and `SHA256SUMS`. Never replace assets on a published tag.

For a publish-free rehearsal, manually dispatch the **Linux release** workflow
and inspect its build artifacts.
