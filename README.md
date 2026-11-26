# Plannotator CLI

Review local code changes or annotate documents in your browser. This fork of
[Plannotator](https://github.com/backnotprop/plannotator) ships a standalone
`plannotator` executable, not agent plugins or an Inbox.

The standalone UI is single-user: annotations have no reviewer name.

## Download for Linux

Pick a version from [GitHub Releases](https://github.com/ohtyap/plannotator/releases) to pin the download. For example, on Linux ARM64:

```sh
version=v0.1.0
asset=plannotator-linux-arm64  # use plannotator-linux-x64 on x86_64
base="https://github.com/ohtyap/plannotator/releases/download/$version"
curl -fLO "$base/$asset" &&
  curl -fLO "$base/SHA256SUMS" &&
  grep -F "  $asset" SHA256SUMS | sha256sum --check --strict &&
  chmod +x "$asset" &&
  "./$asset" --version
```

The executable runs on Linux; you can use a browser on another OS through an SSH tunnel.
Plannotator does not check for or install updates. To upgrade, download another
tagged release and replace the executable.

## Build

From the checkout, with [Bun](https://bun.sh/) 1.4.5 or newer:

```sh
bun install --frozen-lockfile
bun run build:cli
./dist/plannotator --help
```

The build embeds both browser apps in `dist/plannotator` (`dist/plannotator.exe`
on Windows). Copy the executable onto your `PATH`; the installed binary does
not need Bun or Node.js.

## Review

```sh
plannotator review                          # current checkout
plannotator review ../other-checkout
plannotator review --base main              # compare against a local ref
plannotator review --diff-type staged
plannotator review --patch-file change.diff
git diff | plannotator review --patch-file -
```

The browser shows the diff and lets you annotate and submit feedback. For a
pull request, check out the branch yourself, then run `plannotator review`
there. The CLI does not fetch PRs or post to a forge.

**Review Agent**, **Guided Review**, and **Ask AI** use an existing OpenCode V2
service. The launcher can set `PLANNOTATOR_OPENCODE_URL` and, for an authenticated
service, `OPENCODE_PASSWORD`. With only `OPENCODE_PASSWORD` set, Plannotator uses
the managed loopback endpoint at `http://127.0.0.1:49375`. OpenCode supplies
the model defaults; Plannotator never starts a service or offers an agent
picker. AI actions appear only when Plannotator connects to OpenCode V2 at
launch. Manual review and annotation still work without OpenCode.

## Annotate

```sh
plannotator annotate notes.md
plannotator annotate spec.md mockup.html
plannotator annotate ./docs
plannotator annotate http://localhost:5173  # annotate a running local web app
plannotator annotate https://example.com    # fetch and annotate a snapshot
```

When annotating a directory, use **Choose a file** to open a document. For
explicit file bundles, use the file switcher.

Review and Annotate attempt to close the tab three seconds after the completion
screen appears. If the browser blocks it, close the tab manually.

Use `--browser none` to print the session URL without opening a tab. Decisions
are returned to the terminal; add `--json` for scripts. For an annotate approval
gate, use `--gate --json --require-approval`. Exit codes are `0` for approval, `1`
for feedback or dismissal, and `2` for startup or result-file errors. Add
`--result-file PATH` to also write the decision to a new file.

See `plannotator review --help` and `plannotator annotate --help` for options.

## Development

See [development and testing](docs/agent-guides/project-and-development.md).

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
