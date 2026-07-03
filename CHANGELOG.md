# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **On Deck column.** A curated, prioritized queue between Backlog and In Progress.
  Backlog is now your triage pool; you promote items to On Deck for agents to pick up.
  Agents pull work from On Deck (not Backlog), per the updated MCP doctrine.
- **Icebox.** Park a backlog item off the board and bring it back to the Backlog
  when you're ready, via a new Board / Icebox / Archive view toggle, a
  "Send to Icebox" button in the drawer, and a "Bring back" action in the icebox.
  Iceboxed items drop off the board and off agents' `list_issues`.
- Agents can park and revive issues through the new `icebox_issue` and
  `revive_issue` MCP tools, and the agent doctrine now explains the icebox.
- Draggable capture-widget button (drag it up or down; the position is remembered).
- **Capture-context guidance.** The agent doctrine now documents
  `window.IssueTracker.configure` with a general checklist of what's worth
  capturing (app state the URL doesn't carry, identity/tenant, data counts,
  build provenance) and anti-noise rules (small JSON, pointers not dumps, never
  secrets or PII). Mirrored in the widget header, README, and Help page.
- **Capture retrospective.** After resolving an issue, agents now evaluate which
  captured context they used, what they had to reconstruct by hand, and what was
  noise, and recommend any concrete integration tweak to the human in their
  final report (never auto-filed as an issue).

### Changed

- The Archive view now explains that its items were swept from the Done column.
- The agent doctrine (`get_tracker_instructions`) now explains how to install the
  capture widget into an app and route it to a project.

### Fixed

- The board no longer snaps a scrolled column back to the top on the 5s refresh.
- The Help page's `configure` example now waits for `DOMContentLoaded`: the widget
  tag is deferred, so the old bare inline call ran before `window.IssueTracker`
  existed and threw.

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
