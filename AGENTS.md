# AGENTS.md — ragmir-mcp-server

> **Reconstruction note (2026-08-10)**: original content lost during cleanup operation.
> Reconstructed from session memory + repository state. Verify against your own notes
> and correct anything that drifted.

MCP server wrapping the `rgr` CLI (ragmir local RAG). CommonJS, single file `server.js`,
stdio JSON-RPC, 23 MCP tools.

## Layout

- `server.js` — MCP server (~1244 lines)
- `bin/masip-check.sh` — static MASIP compliance checker (4 checks)
- `bin/masip-behavioral-test.sh` — opencode spawn + MASIP artifact verification
- `MASIP.md` — canonical protocol (8 sections, §0 = Two Project Types)
- `upload-client/upload-client.mjs` — companion for binary uploads
- `install.sh` — installs systemd units + symlinks

## Architecture

- Reads JSON-RPC over stdio (line-delimited)
- `let TOOLS`, `let handlers` mutable; `registerTool(name, def, handler)` validates + dedups + emits `notifications/tools/list_changed`
- `ragmir_admin_reload_tools` (idempotent admin tool)
- `capabilities.tools.listChanged: true` advertised in initialize response
- SIGHUP handler also fires the notification (for upgrades that change tool name)
- SIGTERM exits cleanly
- Helpers: `getProjectPath(name)` (sanitizes), `rgr(args, projectRoot, timeoutMs)` (execSync wrapper), `walkDir`, `_backupFile`
- Project storage: `process.env.RAGMIR_PROJECTS_DIR || '/opt/ragmir-projects'`

## Underlying `rgr` CLI (verified)

- `rgr ingest` is **incremental by default** — only re-embeds changed files, reuses unchanged ones, auto-prunes stale chunks when source files are deleted.
- `--rebuild` forces full re-index (rarely needed).
- `rgr status` (fast metadata) / `rgr audit` (deep O(corpus) check, `--unsupported` flag).
- Default ingestion mode is `incremental`, `--incremental-failure-policy` controls failure handling.

## Gotchas (encountered + fixed)

- **`_backupFile` path bug**: for files at project root, project name was duplicated in backup path. Cause: `relDir.startsWith(projectName + path.sep)` doesn't match when `relDir === projectName`. Fix: handle the equality case explicitly.
- **`supersede_note` YAML bug**: handler only prepended `status: superseded` if missing, didn't update existing `status: active`. Fix: scan-and-replace existing `status:` and `superseded_by:` lines in place.
- **`delete_file` orphan chunks**: did `fs.unlinkSync` without calling `rgr ingest`, leaving orphaned chunks. Now has `autoIngest` parameter (default true).
- Don't pass `undefined` to `fs.writeFileSync` — gives cryptic "data argument must be of type string" error. Always validate string args at handler entry.

## Verification protocol (use this when changing server.js)

1. `node --check server.js` — syntax check.
2. Spawn `RAGMIR_PROJECTS_DIR=/tmp/rgr-test node server.js` with JSON-RPC over stdin.
3. Exercise each new/changed tool via `tools/call`.
4. Always verify `_backupFile`-class path bugs by testing with files BOTH at project root AND in subdirs.
5. After mutations: `rgr audit` should show `staleInIndex=0, missingFromIndex=0, duplicateCandidates=0`.
6. Bug-fix verification for `delete_file`: write file with unique token → search (find) → delete with `autoIngest=true` → search (must return "No results").
7. **Testing MCP notifications**: stdin must stay open while client reads stdout. Use FIFO harness in `/tmp/rgr-reload/`. Don't `wait` on `tail -f` — it blocks forever.

## Hot-reload mechanism (added 2026-08, commit c9814fa)

- `let TOOLS` and `let handlers` (mutable). `registerTool/unregisterTool` validate + dedup + emit `notifications/tools/list_changed`.
- `notifyToolsChanged()` calls `sendNotification('notifications/tools/list_changed', {})` to stdout.
- Initialize response advertises `capabilities.tools.listChanged = true` (and `resources.listChanged`).
- SIGHUP signal handler also fires the notification (useful when upgrade changed the tool name itself).
- New admin tool: `ragmir_admin_reload_tools` (no args, idempotent, returns sorted tool names).

## Universal cross-project search (added 2026-08-10)

- New tool: `ragmir_search_all(query, topK?, projects?, totalLimit?, offset?)`.
- Queries every initialized project, merges hits by `rgr distance` (asc, `null` last),
  tags each hit with its source project, supports pagination.
- **Gotcha: `rgr()` helper returns `e.stdout + '\n' + (e.stderr || e.message)` on
  non-zero exit.** When `rgr search --json` returns zero hits, it still emits valid
  JSON to stdout but exits 1 — `e.message` is the full failed command line and
  breaks `JSON.parse`. Mitigation in `ragmir_search_all`: trim, find first `{`,
  walk braces to find matching `}`, parse substring only. Pattern reusable for any
  future `rgr --json` consumer.
- Search is sequential (`rgr()` is `execSync`-based). For ≤10 projects × 1-2s
  each this is acceptable; convert to `child_process.exec` + `Promise.all` if
  cross-project latency ever becomes a bottleneck.
- See MASIP §1 — promoted to default first step before creating new projects.

## MCP commit history (2026-08)

- `c9814fa` feat(server): add hot-reload via notifications/tools/list_changed (76 ins / 3 del)
- `0a3c59e` docs: add Multi-Agent Self-Improvement Protocol (MASIP.md + README section)
- `cadaba2` docs: document knowledge-record lifecycle and Experience Accumulation Pattern
- `2026-08-10` feat(server): add `ragmir_search_all` for cross-project universal search
- `5172c45` feat(server): add knowledge-record tools and fix delete_file bug (7 new tools + bug fixes)

## Systemd units

- `ragmir-mcp.service` — `mcpo` on :8000 (OpenAPI). Requires `--with mcp<2.0.0` because mcpo 0.0.20 imports `streamablehttp_client` (mcp 1.x naming) and mcp 2.0.0 renamed it to `streamable_http_client`.
- `ragmir-sse.service` — `mcp-proxy` on :8001 (SSE). Wraps server.js via stdio.
- `ragmir-upload-mcp.service` — `mcp-proxy` on :8003 (SSE, `127.0.0.1` by default). Wraps `upload-client/upload-client.mjs` via stdio. Lets remote agents use `upload_to_ragmir` without needing local file access or `/root` perms.
- `ragmir-watcher.service` — auto-ingest file watcher (10s poll).
- `ragmir-upload.service` — raw HTTP `/upload` endpoint on :8002. Required by `ragmir-upload-mcp` (the SSE wrapper POSTs to it).

## Push auth gotcha

`/root/pat.git` is a 2-line file (URL on line 1, token on line 2). `cat + sed` mangles the URL on newline. Correct extraction: `TOKEN=$(grep -o 'ghp_[A-Za-z0-9]*' /root/pat.git)`. Push: `git -c "url.https://x-access-token:${TOKEN}@github.com/.insteadOf=https://github.com/" push origin main`.
