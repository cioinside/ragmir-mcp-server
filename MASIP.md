# Multi-Agent Self-Improvement Protocol (ragmir-mcp-server)

A shared collective-memory protocol for agents operating against a ragmir MCP server.
Ragmir is a multi-project local RAG: **each project = one vector index = one knowledge
domain**. Cross-project discovery happens through `ragmir_list_projects` plus targeted
searches.

This protocol is the operationalisation of the experience-accumulation pattern. Follow
it so that knowledge you add is durable, discoverable, and useful to other agents.

---

## 1. Context-Aware Retrieval (Pre-Task)

Before starting any task, query ragmir first. Use metadata filters in your natural-
language query — ragmir indexes the file body, so metadata MUST be in-file, not in
sidecar files.

### Strategy

1. `ragmir_list_projects` — only if uncertain which project holds the relevant record
2. `ragmir_search(project, "<task-id-or-domain> <specific question>", topK=5)` — fast
   raw-passage retrieval with citations
3. `ragmir_ask(project, "...")` — when you need an LLM-synthesized answer with citations
4. `ragmir_research(project, "...")` — only for broad multi-doc investigations

### Search-query hygiene

- Include the project/task domain in the query (`"auth-implementation JWT rotation"`
  beats `"how to refresh tokens"`).
- If no hit in the current project, search sibling projects for analogous patterns —
  note the cross-pollination explicitly in your answer.
- Don't pre-emptively search a project that doesn't exist. Use `ragmir_list_projects`
  first when context is fuzzy.

### Picking the right query tool

| Tool | When |
|---|---|
| `ragmir_search` | Specific lookup, known terminology, want citations |
| `ragmir_ask` | Question needs reasoning over multiple passages |
| `ragmir_research` | Broad report, comparison across many docs, slow but thorough |

---

## 2. Dynamic Knowledge Evolution (Post-Task)

Do not overwrite. Curate. Use the lifecycle tools — they preserve history and auto-
back up before mutating.

### A. Found a BETTER solution than what's in ragmir

The right pattern is **supersede**, not edit.

1. `ragmir_list_history(project, path)` — see what already exists
2. Write the new solution to `<oldPath>-v2.<ext>` via `ragmir_write_file(project, newPath, newContent)`
3. `ragmir_supersede_note(project, oldPath, newPath, reason="<why better>")` —
   atomically sets `status: superseded` and `superseded_by: <newPath>` on the old
   record. Old record stays queryable but flagged.
4. The old record's `superseded_by:` field is itself indexed, so future agents
   searching for the topic will find the new path.

### B. Solved a NEW type of problem

Create a record with **YAML frontmatter** (the frontmatter is indexed by ragmir):

```yaml
---
project_context: "task-001-auth-rotation"
environment: ["prod", "ci_cd"]
tech_stack: ["nodejs", "express", "jwt"]
quality_score: 8
version: "1.0"
supersedes: ""                # or path of v1 if this is a v2
agent_id: "opencode-claude"
timestamp: "2026-08-03T12:30:00Z"
---
# Auth Pattern: Refresh-token rotation
...content...
```

Save via `ragmir_write_file`. **Path convention**: `experience/<task-id>/note.<ext>`.

Use `ragmir_append_file` to add follow-up findings (with timestamp separator) without
duplicating the file. Use `ragmir_edit_file` for surgical field updates. Use
`ragmir_supersede_note` when the *approach itself* changes.

### C. Identified OUTDATED or WRONG entry

- Don't delete — it would orphan chunks in the index and break citations.
- Use `ragmir_edit_file` to set `status: incorrect` and append a `correction:` line
  pointing at the truth.
- Or, if there's a corrected replacement, use `ragmir_supersede_note` with
  `reason: "incorrect, replaced by <new>"`.

---

## 3. Cross-Project Intelligence Sharing

### Project layout convention

- **One ragmir project per knowledge domain** (e.g. `python-fastapi-prod`,
  `rust-cli-tools`, `kubernetes-deployments`, `experience-records`).
- Don't mix unrelated domains in one project — search quality degrades as the index
  accumulates off-topic chunks.
- Use a separate `experience-records` or `patterns` project for cross-domain
  abstracted patterns.

### Abstracting patterns across projects

When a pattern is useful beyond its source project:

1. Read source record from project X via `ragmir_read_file(project=X, path=...)`
2. Strip project-specific identifiers (service names, hostnames, secret paths)
3. Write abstracted version into project Y's `patterns/` dir with
   `source_project: X` in the frontmatter
4. Both versions stay independently versioned — they evolve on different cadences
5. Always include `source_project: X` so credit and provenance are queryable

### Conflict resolution

If two projects disagree on best practice, store **BOTH** records with explicit
`context_scope` in their frontmatter (e.g. `scope: monolith` vs `scope: microservice`).
Never delete the loser — keep both, let future agents pick the right one based on
their own context.

### Environment adaptation notes

If a solution works in `Docker` but fails in `local`, store both variants with
`environment:` lists that distinguish them. Don't rationalise away the divergence —
the difference is the lesson.

---

## 4. Metadata Standards for Records

Every knowledge record SHOULD have YAML frontmatter matching:

```yaml
---
project_context: short task/domain identifier
environment: [dev, prod, ci_cd, local]
tech_stack: [primary languages/frameworks]
quality_score: 0-10   # self-assessed, update after verification
version: 1.0          # bump when superseding prior version
supersedes: ""        # path of older record this replaces
agent_id: your-agent-identifier
timestamp: ISO_8601   # when this version was written
---
```

These fields are part of the file body, so `ragmir_search` finds them. **Don't rely
on sidecar metadata files** — they won't be indexed, and the search will miss them.

For Markdown-vs-YAML-vs-JSON records:

- **YAML** (recommended for structured records) — frontmatter at top, easy to
  `ragmir_edit_file` on individual fields
- **JSON** — for records other tools emit/consume; no frontmatter needed, top-level
  fields are the metadata
- **Markdown** — for prose-heavy knowledge; frontmatter at top, body below

---

## 5. Safety Rails (use the built-in tools, don't reinvent)

These are verified empirical facts about the underlying `rgr` CLI and the server.js
wrapper. Trust them and don't write your own pre/post hooks.

- All mutating tools auto-backup to `<project>/.ragmir-history/<rel>/<ISO>.bak`
  before the operation. The directory is dot-prefixed, so it's auto-excluded from
  ragmir indexing (verified: 3 backup files on disk, `indexedFiles` shows only the
  source files).
- All mutations auto-trigger `rgr ingest` (incremental — only changed files re-embed;
  verified: modifying 1 file reports `rebuiltFiles=1 reusedFiles=2`).
- Before any destructive op, run `ragmir_list_history` + `ragmir_diff_versions`.
- Roll back with `ragmir_restore_version` (it auto-backs up the current state first,
  so rollback is itself reversible).
- After batch ops, `ragmir_health_check(project, deep=true)` should report
  `staleInIndex=0, missingFromIndex=0, duplicateCandidates=0`. If it doesn't, do
  not paper over it — investigate the drift.

### Common anti-patterns

- **Hand-editing index files** under `<project>/.ragmir/` — breaks invariants; use
  the tools.
- **Deleting and recreating** instead of `ragmir_supersede_note` — orphans chunks and
  loses citations.
- **Sidecar metadata files** (`note.meta.yaml`) — not indexed, defeats search.
- **Big monolithic records** (50 KB+ files) — chunking degrades; one record = one
  small file (2-10 KB), cross-reference via `supersedes` / `related` fields.
- **Mixing domains in one project** — search quality drops; split into multiple
  projects and use `ragmir_list_projects` to route.

---

## 6. Verification Protocol

After any non-trivial change to a ragmir project, verify:

1. `ragmir_health_check(project, deep=true)` — fast status, then full audit
2. `ragmir_search(project, "<unique token from your new record>")` — re-embedding
   took effect
3. If you've deleted files: `ragmir_search` for tokens that were ONLY in the deleted
   record — must return "No results" (otherwise stale chunks remain)
4. If you've superseded: `ragmir_list_files` and confirm both old + new paths exist
   with the correct `status:` frontmatter

For server.js changes themselves (this protocol's implementation), the canonical
verification sequence is in the repository's project memory.

---

## 7. Mapping to Tool Names

| Generic concept | ragmir tool |
|---|---|
| `rag_update` | `ragmir_edit_file` / `ragmir_supersede_note` |
| "create new entry" | `ragmir_write_file` |
| "supersedes_id" | `ragmir_supersede_note` (sets `superseded_by:` field) |
| "list entries" | `ragmir_search` / `ragmir_list_files` |
| "versioned" | `.ragmir-history/<rel>/<ISO>.bak` + `ragmir_list_history` |
| "environment tag" | YAML frontmatter inside the record (indexed) |
| "deep audit" | `ragmir_health_check` with `deep=true` |
| "rollback" | `ragmir_restore_version` |
