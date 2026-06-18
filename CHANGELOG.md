# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] Initial public release

The first open-source release of VibeOps Tracker, a local-first issue tracker.

### Added

- **Capture widget.** One `<script>` tag drops a floating button into any web
  app. Highlight text, click it, and the issue is captured with the selection
  plus an optional activity trail (clicks, network, errors).
- **Kanban board** at `localhost:4400`, with a project switcher, Backlog → In Progress
  → In Review → Done, drag to prioritize, real-time search, archive/sweep,
  click-to-edit type and severity, and permanent delete with a two-step confirm.
- **MCP server** that lets AI coding agents (e.g. Claude Code) list, pick up, work,
  comment on, resolve, and delete issues, so you can queue a backlog and have
  agents run it while you're away.
- **Markdown storage.** One human- and AI-readable file per issue, stored
  locally; nothing leaves your machine.
- **REST API** and a **Copy Prompt** generator for paste-into-a-session workflows.
- **CLI** (`vibeops`) with `npx` and global-install support.

[0.1.0]: https://github.com/igembitsky/vibeops-tracker/releases/tag/v0.1.0
