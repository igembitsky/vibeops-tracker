# Contributing to VibeOps Tracker

Thanks for your interest! VibeOps Tracker is a small, dependency-light tool, and
contributions — bug reports, ideas, and pull requests — are welcome.

## Getting set up

```bash
git clone https://github.com/igembitsky/vibeops-tracker.git
cd vibeops-tracker
npm install
npm start          # board + API at http://localhost:4400
npm test           # the full suite (store, API, widget, prompt, MCP)
```

No build step — it's plain ESM that runs on Node 20+. Your local data lives in
`data/` (gitignored); it never leaves your machine.

## How the project is laid out

```
server.mjs        HTTP server: board UI, REST /api/*, and the /widget.js asset
mcp-server.mjs    MCP stdio server for AI agent hosts (reads the store directly)
bin/cli.mjs       the `vibeops` CLI dispatcher
lib/store.mjs     the markdown store — all persistence lives here
lib/api.mjs       REST routing
lib/prompt.mjs    the "Copy Prompt" generator
lib/data-dir.mjs  where data is stored (clone vs. global install)
public/           the board UI and the embeddable widget.js
tests/            node:test suites
```

Issues are **one markdown file each** under `data/<project>/issues/` — YAML
frontmatter plus sentinel-delimited body sections. The store is the source of
truth; the API, the MCP server, and the board are all thin layers over it.

## Pull requests

- **Open an issue first** for anything non-trivial, so we can agree on the shape
  before you build it.
- **Keep `npm test` green**, and add tests for new behavior. The suite is fast.
- Match the surrounding style (no linter is enforced; just keep it consistent).
- Update the README / Help page if you change user-facing behavior.
- Keep the dependency footprint small — a big part of the appeal is that this is
  a tiny, auditable, local-first tool.

## Reporting bugs and proposing features

Use the GitHub issue templates. For bugs, include what you saw, what you
expected, and how to reproduce. For security issues, see [SECURITY.md](SECURITY.md)
— please don't open a public issue for those.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
