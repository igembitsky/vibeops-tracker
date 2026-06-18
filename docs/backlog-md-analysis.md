# Backlog.md vs. issue-tracker: Comparative Analysis

## 1. What Backlog.md is and its core philosophy

Backlog.md (~5.7k stars, MIT, Bun/TypeScript) turns any git repo into a self-contained project board: tasks are plain markdown files in `backlog/tasks/`, mutated exclusively through a CLI/MCP layer, visualized via terminal TUI and a bundled React web UI. Its defining bet is **spec-driven AI development**: tasks are "work orders for strangers," written so a fresh agent session with zero conversation memory can execute them. Everything downstream follows from that: structured body sections with HTML-comment sentinels so tools can edit them safely, indexed acceptance-criteria checkboxes, a "NEVER EDIT TASK FILES DIRECTLY" golden rule, and an unusually heavy investment in *teaching the agent the workflow* (MCP resources, `get_backlog_instructions`, injected CLAUDE.md guidelines). It is repo-local, single-project, offline, and work-planning-shaped.

We are the inverse on the first axis: **issue-capture-shaped, multi-project, repo-external**. That difference is real and worth defending. Even so, several of their execution-side ideas plug straight into our gaps.

## 2. What we're doing differently: justified or accidental?

| Difference | Theirs | Ours | Verdict |
|---|---|---|---|
| **Data location** | `backlog/` inside each repo, versioned with the code | Central `data/<project>/issues/` outside all repos | **Justified.** The widget POSTs cross-origin from running apps; a central store is the whole point. We knowingly give up git-versioned issues and their cross-branch machinery. (Mitigation in §4: git-init the data dir.) |
| **Capture path** | CLI / MCP / web form, authored by a human or agent | Embeddable `widget.js` with FAB, capture modal, and a browser snapshot (URL, viewport, UA, click/fetch/error ring buffers) | **Justified, and our core differentiator.** They have nothing like it. Don't dilute this. |
| **Record shape** | Work order: Description, AC, DoD, Plan, Notes, Comments, Final Summary | Bug report: Seeing, Expecting, Context, Comments | **Half justified, half accidental.** Seeing/Expecting/Context is the right *capture* shape. But we have no *resolution* shape. An agent that fixes an issue can only dump prose into Comments. That's an accidental gap, not a design choice (fix in §4). |
| **Prioritization** | `priority: high\|medium\|low` + labels | `severity: 1-5` + `type` + `tags` | **Justified.** Severity is the right axis for bugs; type pills fit the widget UX. |
| **Statuses** | Free-form configurable columns (`statuses:` in config.yml) | Fixed 4: backlog / in-progress / in-review / done | **Justified for one user.** Configurable statuses are their concession to teams; fixed statuses keep the widget, board, MCP enum, and Copy Prompt trivially in sync. Our `in-review` is actually a *better* default than theirs: it's a natural agent-to-human handoff column they don't ship. |
| **Agent interface** | CLI first (`--plain` everywhere), MCP second | MCP only, stdio, direct store access | **Justified.** Their CLI exists because the data lives in the repo the agent is already in. Our agents run in *other* projects' working directories, so MCP is the only sane transport. No CLI needed. |
| **Stack** | Bun, React 19, Tailwind 4, compiled native binaries on npm/brew/nix | Node, vanilla-JS no-build, gray-matter + MCP SDK | **Justified.** They have a distribution problem; we have exactly one deployment (localhost:4400). Their stack weight buys us nothing. |
| **Git operations** | auto_commit, cross-branch state reconciliation, branch-scanning ID generation, hook bypass | None | **Mostly justified, slightly accidental.** All the cross-branch machinery is meaningless for a central store. But "no git at all" means no history and no undo for the data dir, and that part is accidental (cheap fix in §4). |
| **Agent handoff** | Push: onStatusChange hooks, MCP workflow doctrine | Pull: Copy Prompt button | **Justified and complementary.** Copy Prompt is a great single-user primitive. Keep it, and add their instruction-resource idea alongside (§4). |

One difference that's purely accidental: their `task_edit` is a rich patch tool (~30 fields); our MCP write surface is `create_issue`, `update_issue_status`, `add_comment`. An agent cannot retitle a mis-filed issue, adjust severity, add a tag, link `related_to`, or record what files it changed. That's not a philosophy difference. We just haven't built it.

## 3. What they do that we don't

**Execution-side structure**
- `## Implementation Plan`, `## Implementation Notes`, `## Final Summary` sections give the *fixing* agent a place to work, distinct from discussion.
- Sentinel markers (`<!-- SECTION:NOTES:BEGIN/END -->`, `<!-- AC:BEGIN/END -->`, `<!-- COMMENTS:BEGIN/END -->`) so tools edit sections structurally instead of parsing headings.
- Indexed checkbox lists (`- [ ] #1 ...`) for AC and DoD, manipulated by index.
- `modified_files`, `references`, `documentation` frontmatter for searchable provenance (`backlog search --modified-file src/path.ts`).
- `assignee` / `reporter` fields (`@name` convention) mean they always know *who/what* touched a task.

**Lifecycle**
- Drafts (+ promote/demote), `completed/` sweep via `backlog cleanup`, `archive/` soft-delete with ID reuse. Our `done` column accumulates forever.
- `dependencies` + computed execution sequences (Kahn-style layering, as in "Sequence 1 can run in parallel"). Our `related_to` is undirected and unused by tooling.

**Agent instruction infrastructure (their signature feature)**
- `get_backlog_instructions` MCP tool + `backlog://workflow/*` resources: the tracker *teaches the workflow*. Search first, assign self + set In Progress before working, plan before code, Final Summary before Done, archive only for dupes/invalid.
- The golden rule "never write task files directly, mutate only via CLI/MCP."
- Injected guideline blocks in CLAUDE.md/AGENTS.md between sentinel markers, refreshable via `backlog agents --update-instructions`.

**Misc**
- Fuse.js fuzzy search across everything; `config get/set` + interactive wizard; `onStatusChange` shell hook (`$TASK_ID`, `$NEW_STATUS`); fractional-ranking ordinals with documented rebalance math; board export to README; stats overview; MCP tool annotations (`readOnlyHint`/`destructiveHint`); live file-watcher updates in the web UI; shell completions; a VS Code extension.

## 4. Highest-value things to borrow (ranked by value ÷ effort)

**1. A real `update_issue` MCP tool + `search_issues`. (highest value, low effort)**
Replace the status-only tool with patch semantics modeled on `task_edit`: accept `title`, `status`, `severity`, `type`, `tags`, `related_to`, plus structured appends (see #2). Add `search_issues(query, status?, project?, limit?)`. Even naive substring over title/body beats nothing; their doctrine "search first to avoid duplicates" only works if search exists. Without this, agents are read-mostly spectators.

**2. `## Resolution` section + `modified_files` frontmatter. (the single best idea to steal)**
Their Final Summary is a PR-style record: what changed, why, tests, risks. Add `## Resolution` to our body and `modified_files:` (repo-relative paths) to frontmatter. Add one composite MCP tool `resolve_issue(id, resolution, modified_files)` that writes both, sets `status: in-review` (not `done`, since a human verifies in our flow), and stamps `updated`. Then "which issue touched `src/auth.ts`?" becomes answerable, and Copy Prompt can include prior resolutions of `related_to` issues. **Prerequisite:** add `repo_path` to each entry in `projects.json` so paths are resolvable and Copy Prompt can say "cd into X."

**3. Sentinel section markers, from day one. (trivial now, painful to retrofit)**
Adopt their exact convention: `<!-- SECTION:CONTEXT:BEGIN/END -->` around our fenced-JSON snapshot, `<!-- COMMENTS:BEGIN/END -->` with per-comment `---` delimiters, `<!-- SECTION:RESOLUTION:BEGIN/END -->`. We own the serializer already; this makes `add_comment` and `resolve_issue` append-safe forever instead of heading-regex-fragile. Copy their comment metadata shape too (`author: @igor` / `author: @claude-code` + `created:` line), and render agent vs. human comments differently in the drawer.

**4. An instructions surface in our MCP server. (one markdown string, outsized leverage)**
Ship a `get_tracker_instructions` tool (and/or an `issuetracker://workflow` resource) with our adaptation of their doctrine: *"Issues are bug reports captured from a running browser. Read `## Context` and reproduce before coding. Set status `in-progress` before starting. Record findings via `update_issue`, not ad-hoc files. Finish with `resolve_issue` → `in-review`; a human moves it to `done`. Never edit files under `data/` directly."* (That last rule is nearly free to enforce, since the data dir isn't even in the agent's cwd.) This is the cheapest way to get consistent agent behavior across all our projects without touching any project's CLAUDE.md.

**5. Their ordinal math, verbatim. (we already have the field; copy the algorithm)**
`DEFAULT_ORDINAL_STEP = 1000`; append = max + 1000; insert-between = midpoint; insert-at-top = `next / 2`; resequence by 1000s when gap ≤ 1e-6. Solves the drag-reorder write-amplification problem (only the moved card's file changes) with zero invention.

**6. `closed/` sweep. (small, prevents inevitable rot)**
Borrow `cleanup`/`task_complete` semantics: a button (and MCP tool) that moves `done` issues older than N days to `data/<project>/closed/`. Keeps the board and `list_issues` fast and relevant. Skip the separate `archive/` tier; for dupes, a single-user `done` plus a `duplicate` tag is enough.

**7. `git init` the data dir with optional autocommit. (an evening of work, real safety)**
Their `auto_commit` (default false) applied to our central store: every write = one commit (`<id>: <action>`). History, blame, and undo for free; their `bypass_git_hooks`/branch machinery is all irrelevant. Plain commits only.

## 5. Things to deliberately NOT adopt

- **Acceptance Criteria / Definition of Done checklists** (`--check-ac 2`, `definition_of_done` defaults injection). This is the heart of *their* tool and wrong for *ours*. AC/DoD encode a spec-and-verify contract for planned work executed by strangers. Our records are observed defects; `## Seeing` / `## Expecting` *is* the acceptance criterion. Adding indexed-checkbox plumbing would be ceremony one person will never check off.
- **Drafts + promote/demote.** Capture-first means the widget's two-field minimum is the friction floor; a draft tier adds a triage step with no payoff for one person. Backlog *is* our draft column.
- **Docs, decisions, milestones subsystems.** Each tracked project keeps its docs in its own repo. A central tracker holding cross-project documentation would be scope creep into a wiki.
- **Configurable statuses / free-form columns.** Their flexibility is our cost: dynamic MCP enums, widget/board/Copy-Prompt sync logic. Four hardcoded statuses are a feature.
- **All cross-branch machinery** (`check_active_branches`, `taskResolutionStrategy`, branch-scanning ID generation, `remote_operations`). Only meaningful when data lives in repos. Our sequence counter is a single authority; none of this applies.
- **The TUI, board export, shell completions, native-binary distribution.** Artifacts of being a published CLI-first tool living inside repos. Our humans have a browser; our agents have MCP.
- **Subtask dotted IDs (`back-470.1`) and parent/child hierarchy.** Issues rarely decompose; `related_to` covers clustering. Hierarchy can be added later if it's ever actually missed, and dotted IDs are easy to bolt onto `<project>-<seq>`.
- **`onStatusChange` shell hooks**, *for now*. Auto-spawning `claude "fix issue $ID"` when a card hits in-progress is genuinely tempting, but it's background-process management bolted onto a tracker, and the Copy Prompt button covers the same handoff deliberately. Revisit only after #1 through #4 exist, since hooks are only as useful as what the spawned agent can read and write.

**Bottom line:** our capture story (widget + context snapshot + central store) is differentiated and shouldn't bend toward Backlog.md at all. Our *agent execution* story is two months behind theirs. Items #1 through #4 above (richer MCP edit surface, Resolution + modified_files, sentinel markers, and an embedded workflow instruction) close most of that gap in a few focused sessions without importing any of their process weight.