# Ragmir MCP Server

Universal MCP server for [Ragmir](https://www.npmjs.com/package/@jcode.labs/ragmir) — local-first RAG knowledge base. Manage projects, upload files, ingest, and search **all via MCP over HTTP**.

Remote AI agents (OpenCode, Claude, Cursor, etc.) can create projects, provide files, build vector indexes, and query the knowledge base — without SSH or CLI access.

## Features

- **23 MCP tools** — project management, file operations, indexing, search (single-project + cross-project), knowledge accumulation, and hot-reload admin
- **Remote access** — any agent on the LAN can use it via HTTP
- **Multi-project** — unlimited projects, each with its own vector index
- **OpenAPI docs** — auto-generated interactive docs at `/docs`
- **Zero cloud** — fully local, no data leaves your network

## Architecture

```
[Remote Agent / OpenCode]                  [Open WebUI]
         │                                       │
         │  SSE (MCP transport)                  │  REST (OpenAPI)
         ├──────────────┐                         ▼
         ▼              ▼                    mcpo :8000
    mcp-proxy :8001  mcp-proxy :8003            │
    (ragmir MCP)    (ragmir-upload MCP)        │
         │              │                      │  stdio
         │ stdio        │ stdio                 ▼
         ▼              ▼                ragmir-server.js
    ragmir-server.js  upload-client.mjs         │
         │              │                      │
         │              │ HTTP POST            │
         │              ▼                      │
         │       upload-server :8002           │
         │              │                      │
         ├──────────────┴──────────────────────┤
         │                                     │
         ├── rgr CLI (search, ingest, ask, research)
         └── /opt/ragmir-projects/ (project storage)
```

Ports:
- **Port 8001** — SSE transport (MCP protocol) for `ragmir` tools, OpenCode / Claude / Cursor
- **Port 8003** — SSE transport (MCP protocol) for `ragmir-upload` tools, exposes `upload_to_ragmir` to remote agents
- **Port 8000** — REST/OpenAPI proxy (via mcpo) for Open WebUI
- **Port 8002** — raw HTTP `/upload` endpoint (used by `ragmir-upload` SSE above and by clients that prefer curl/scripts)

Services:
- `ragmir-mcp` (mcpo) — port 8000, REST/OpenAPI
- `ragmir-sse` (mcp-proxy) — port 8001, SSE/MCP for `ragmir`
- `ragmir-upload-mcp` (mcp-proxy) — port 8003, SSE/MCP wrapper for `upload-client.mjs`
- `ragmir-upload` (upload-server) — port 8002, raw HTTP upload endpoint

## Quick Install

### Prerequisites

- **Node.js >= 22**
- **npm** (comes with Node)
- **uv** or **pip** (for mcpo)

### One-line install

```bash
curl -sSL https://raw.githubusercontent.com/cioinside/ragmir-mcp-server/main/install.sh | bash
```

### Manual install

```bash
# 1. Install Ragmir CLI
npm install -g @jcode.labs/ragmir

# 2. Install server
sudo mkdir -p /usr/local/lib/ragmir-server
sudo cp server.js /usr/local/lib/ragmir-server/
sudo chmod +x /usr/local/lib/ragmir-server/server.js

# 3. Create directories
sudo mkdir -p /opt/ragmir-projects
sudo mkdir -p /etc/ragmir

# 4. Generate mcpo config
sudo tee /etc/ragmir/mcpo-config.json << 'EOF'
{
  "mcpServers": {
    "ragmir": {
      "command": "node",
      "args": ["/usr/local/lib/ragmir-server/server.js"],
      "env": {
        "RAGMIR_PROJECTS_DIR": "/opt/ragmir-projects"
      }
    }
  }
}
EOF

# 5. Install systemd service (edit API key first!)
sudo cp ragmir-mcp.service /etc/systemd/system/
sudo sed -i 's/CHANGE-ME/YOUR_SECRET_KEY/' /etc/systemd/system/ragmir-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now ragmir-mcp

# 6. Open firewall
sudo ufw allow 8000/tcp
```

### Environment variables (install.sh)

| Variable | Default | Description |
|---|---|---|
| `RAGMIR_MCP_INSTALL_DIR` | `/usr/local/lib/ragmir-server` | Server installation path |
| `RAGMIR_PROJECTS_DIR` | `/opt/ragmir-projects` | Project storage directory |
| `RAGMIR_MCP_PORT` | `8000` | REST/OpenAPI port (mcpo) |
| `RAGMIR_MCP_API_KEY` | `CHANGE-ME` | API key for authentication |
| `RAGMIR_SSE_PORT` | `8001` | SSE port for `ragmir` MCP |
| `RAGMIR_UPLOAD_PORT` | `8002` | Raw HTTP `/upload` port |
| `RAGMIR_UPLOAD_MCP_PORT` | `8003` | SSE port for `ragmir-upload` MCP |
| `RAGMIR_UPLOAD_MCP_HOST` | `127.0.0.1` | Bind host for upload-mcp SSE (set `0.0.0.0` to expose on LAN) |

## Usage

### Verify installation

```bash
# Check service status
systemctl status ragmir-mcp

# Check tools
curl -s http://localhost:8000/ragmir/openapi.json | python3 -m json.tool
```

### Create a project

```bash
curl -s -X POST http://localhost:8000/ragmir/ragmir_create_project \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-api","description":"REST API backend"}'
```

### Upload files

```bash
curl -s -X POST http://localhost:8000/ragmir/ragmir_write_files_batch \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{
    "project":"my-api",
    "files":[
      {"path":"README.md","content":"# My API\n\nREST API service."},
      {"path":"src/auth.py","content":"def authenticate(email, password):\n    return check(email, password)"},
      {"path":"docs/api.md","content":"# API Docs\n\n## POST /auth\nAuthenticate user."}
    ]
  }'
```

### Add source patterns and ingest

```bash
# Add sources
curl -s -X POST http://localhost:8000/ragmir/ragmir_add_sources \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-api","patterns":["docs/**/*.md","src/**/*.py","README.md"]}'

# Ingest
curl -s -X POST http://localhost:8000/ragmir/ragmir_ingest \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-api"}'
```

### Search

```bash
curl -s -X POST http://localhost:8000/ragmir/ragmir_search \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-api","query":"How does authentication work?","topK":3}'
```

### Python example

```python
import requests

SERVER = "http://192.168.1.100:8000"
HEADERS = {"Authorization": "Bearer CHANGE-ME", "Content-Type": "application/json"}

# Create project
r = requests.post(f"{SERVER}/ragmir/ragmir_create_project", headers=HEADERS,
                  json={"name": "my-api", "description": "REST API"})

# Upload files
r = requests.post(f"{SERVER}/ragmir/ragmir_write_files_batch", headers=HEADERS,
                  json={"project": "my-api", "files": [
                      {"path": "README.md", "content": "# My API"},
                      {"path": "src/main.py", "content": "def main(): pass"},
                  ]})

# Ingest
r = requests.post(f"{SERVER}/ragmir/ragmir_ingest", headers=HEADERS,
                  json={"project": "my-api"})

# Search
r = requests.post(f"{SERVER}/ragmir/ragmir_search", headers=HEADERS,
                  json={"project": "my-api", "query": "main function"})
print(r.json())
```

## MCP Tools

### Project Management

| Tool | Description |
|---|---|
| `ragmir_create_project` | Create a new project (directory + rgr init) |
| `ragmir_delete_project` | Delete project and all data |
| `ragmir_list_projects` | List all projects |
| `ragmir_project_status` | Project status (files, chunks, config) |

### File Operations

| Tool | Description |
|---|---|
| `ragmir_write_file` | Write one file to a project |
| `ragmir_write_files_batch` | Write multiple files at once |
| `ragmir_read_file` | Read a file from a project |
| `ragmir_list_files` | List files in a project |
| `ragmir_delete_file` | Delete a file |

### Indexing & Search

| Tool | Description |
|---|---|
| `ragmir_add_sources` | Add glob patterns for indexing |
| `ragmir_ingest` | Run ingestion (after adding files) |
| `ragmir_search` | Search one project with citations |
| `ragmir_search_all` | **Universal search across all projects** — call this when you don't know which project holds the answer (prevents creating duplicate corpora) |
| `ragmir_ask` | Get context for a question (no LLM) |
| `ragmir_research` | Multi-query research |

### Knowledge Accumulation

| Tool | Description |
|---|---|
| `ragmir_append_file` | Append text to an existing file (auto-backup + auto-ingest) |
| `ragmir_edit_file` | Find/replace within a file (auto-backup + auto-ingest) |
| `ragmir_supersede_note` | Mark old record as superseded, create new one (preserves history) |
| `ragmir_list_history` | List all backup versions of a file |
| `ragmir_diff_versions` | Show diff between two file versions |
| `ragmir_restore_version` | Restore a file from a specific backup |
| `ragmir_health_check` | Quick health summary (fast status or deep audit) |
| `ragmir_delete_file` | Delete a file (now includes autoIngest to clean orphaned chunks) |
| `ragmir_admin_reload_tools` | Notify all clients to re-fetch tools/list (MCP `notifications/tools/list_changed`). Also fires on `SIGHUP` to the server process. |

## Experience Accumulation Pattern

For agents that want to accumulate and update knowledge records over time:

### Design Rationale

Each knowledge record is a **single small file** (2-10 KB). Records can be YAML, JSON, or Markdown. This keeps the system simple, editable by any agent, and easy to version-control.

### Folder Layout

```
experience/
  task-001-auth-implementation/
    note.yaml        # Primary record
    note-v2.yaml     # Superseded by note.yaml (via supersede)
  task-002-payment/
    note.md
```

### Lifecycle Workflow

| Action | Tool |
|---|---|
| Create a new record | `ragmir_write_file` |
| Add findings to existing record | `ragmir_append_file` (with timestamp separator) |
| Update a specific field | `ragmir_edit_file` (find/replace) |
| Found a better method? | `ragmir_supersede_note` — preserves old + links to new |

### Safety Guarantees

- Every write/edit/append/delete **auto-backs up** to `.ragmir-history/` BEFORE the operation
- Every mutation **auto-triggers** `rgr ingest` (incremental — only the changed file is re-embedded)
- Use `ragmir_list_history` + `ragmir_diff_versions` to review before destructive ops
- Use `ragmir_restore_version` to roll back if needed

### Example: Append a Finding, Then Supersede

```bash
# 1. Create initial record
curl -s -X POST http://localhost:8000/ragmir/ragmir_write_file \
  -d '{"project":"my-kb","path":"experience/task-001/note.yaml","content":"# Auth\nmethod: JWT\n"}'

# 2. Append a finding
curl -s -X POST http://localhost:8000/ragmir/ragmir_append_file \
  -d '{"project":"my-kb","path":"experience/task-001/note.yaml","content":"## Finding\nAdd rate limiting."}'

# 3. Found a better method — supersede
curl -s -X POST http://localhost:8000/ragmir/ragmir_supersede_note \
  -d '{"project":"my-kb","oldPath":"experience/task-001/note.yaml","newPath":"experience/task-001/note-v2.yaml","newContent":"# Auth\nmethod: OAuth2\n","reason":"OAuth2 more secure than JWT"}'

# 4. Verify health
curl -s -X POST http://localhost:8000/ragmir/ragmir_health_check \
  -d '{"project":"my-kb","deep":true}'
```

### History & Backup

All backups go to `.ragmir-history/<relative-path>/<ISO-timestamp>.bak` inside the project directory. The `.ragmir-history` directory is hidden (dot-prefixed) so it's excluded from the ragmir index.

- **List backups:** `ragmir_list_history(project="my-kb", path="experience/task-001/note.yaml")`
- **Diff versions:** `ragmir_diff_versions(project="my-kb", path="experience/task-001/note.yaml", versionA="2026-08-03T10-50-53-000Z.bak", versionB="current")`
- **Restore:** `ragmir_restore_version(project="my-kb", path="experience/task-001/note.yaml", version="2026-08-03T10-50-53-000Z.bak")`

## Multi-Agent Self-Improvement Protocol

When multiple agents share a ragmir server, the **collective memory** is only as useful as the discipline that maintains it. The full protocol lives in [`MASIP.md`](./MASIP.md) — read it before contributing. This section is the executive summary.

### Pre-task: search before you invent

```
ragmir_search_all("<task-id> <question>", topK=3, totalLimit=10)   # default — covers all projects
# OR, if you already know the target project:
ragmir_search(project, "<task-id> <question>", topK=5)
```

If the answer exists in ragmir, don't write a new record. If you find a better answer elsewhere, supersede (don't overwrite). `ragmir_search_all` is the recommended first step because it queries every project in one call and tags each hit with its source — preventing the failure mode where a new agent creates a duplicate corpus because they didn't know prior work existed in another project.

### Post-task: curate, don't overwrite

| Situation | Right tool |
|---|---|
| New finding in an existing record | `ragmir_append_file` (timestamp separator) |
| Field-level edit | `ragmir_edit_file` (find/replace) |
| Found a better approach entirely | `ragmir_supersede_note` — old record stays queryable with `status: superseded` + `superseded_by: <new path>` |
| New type of problem solved | `ragmir_write_file` with **YAML frontmatter** (metadata is indexed, sidecar files are not) |
| Identified wrong/outdated entry | `ragmir_edit_file` to set `status: incorrect`, never `ragmir_delete_file` (orphans chunks) |

### Metadata standard (YAML frontmatter)

Every knowledge record SHOULD include:

```yaml
---
project_context: "task-001-auth-rotation"   # domain identifier
environment: [prod, ci_cd]
tech_stack: [nodejs, express, jwt]
quality_score: 0-10                        # self-assessed
version: "1.0"
supersedes: ""                             # path of older record, if v2+
agent_id: "your-agent-id"
timestamp: "2026-08-03T12:30:00Z"
---
```

Frontmatter is part of the indexed file body — `ragmir_search` will find it. Sidecar `note.meta.yaml` files are **not** indexed.

### Cross-project hygiene

- **One project per knowledge domain.** Don't mix `python-fastapi` and `kubernetes-deployments` — search quality degrades.
- **Abstract patterns go to a dedicated project** (e.g. `patterns/` or `experience-records`). Include `source_project: <name>` in the frontmatter so provenance is queryable.
- **Conflicting best practices:** keep both, distinguish via `context_scope` in frontmatter. Never delete the loser.

### Verification after batch ops

```
ragmir_health_check(project="my-kb", deep=true)
```

Must report `staleInIndex=0, missingFromIndex=0, duplicateCandidates=0`. If not, do not paper over it.

See [`MASIP.md`](./MASIP.md) for the full protocol with examples, anti-patterns, and tool mappings.

## Uploading Binary Files

Text files (.py, .md, .js) → use `ragmir_write_files_batch` MCP tool.

Binary files (.docx, .pdf, .xlsx, images) → two options:

**Option A — MCP tool (recommended for remote agents):** connect via `ragmir-upload` SSE on port `:8003`, the agent gets an `upload_to_ragmir` tool. See [Connecting from Remote OpenCode](#connecting-from-remote-opencode).

**Option B — raw HTTP upload endpoint** (too large for MCP tool calls):

```bash
# Linux/Mac
curl -X POST http://192.168.1.100:8002/upload \
  -F "project=my-project" \
  -F "path=docs/report.docx" \
  -F "file=@/path/to/report.docx"

# Windows PowerShell
Invoke-WebRequest -Uri "http://192.168.1.100:8002/upload" `
  -Method POST `
  -Form @{project="my-project"; path="docs/report.docx"; file=Get-Content "C:\path\report.docx" -Encoding Byte}
```

Response:
```json
{"ok":true,"project":"my-project","path":"docs/report.docx","bytes":12345,"ingested":true}
```

Files auto-ingest on upload. If `autoIngest=false`, call `ragmir_ingest` via MCP afterwards.

## Connecting from Remote OpenCode

Add to `~/.config/opencode/opencode.jsonc` on the remote PC:

```jsonc
{
  "mcp": {
    "ragmir": {
      "type": "remote",
      "url": "http://192.168.1.100:8001/sse",
      "enabled": true
    },
    "ragmir-upload": {
      "type": "remote",
      "url": "http://192.168.1.100:8003/sse",
      "enabled": true
    }
  }
}
```

Replace `192.168.1.100` with your server's IP.

**Port 8001** serves the SSE transport for `ragmir` tools. **Port 8003** serves the SSE transport for `ragmir-upload` (binary file upload via the `upload_to_ragmir` tool). Port 8000 is REST/OpenAPI (for Open WebUI). Port 8002 is the raw HTTP `/upload` endpoint.

Both `ragmir` and `ragmir-upload` can run as remote MCPs from any machine on the LAN — no local file paths needed, no `/root` access required.

## Connecting from OpenCode with Binary File Upload (Windows)

For agents on Windows that need to upload binary files (.docx, .pdf, .xlsx, images) without writing code, use the **upload-client** local MCP server. It provides an `upload_to_ragmir` tool that reads files from the local disk and sends them to the remote server.

### Setup

1. Clone the repo and install dependencies:
```bash
git clone https://github.com/cioinside/ragmir-mcp-server.git C:\ragmir-mcp-server
cd C:\ragmir-mcp-server\upload-client
npm install
```

2. Add to `opencode.jsonc` (or `opencode.json` in the project root):
```jsonc
{
  "mcp": {
    "ragmir": {
      "type": "remote",
      "url": "http://192.168.1.100:8001/sse",
      "enabled": true
    },
    "ragmir-upload": {
      "type": "local",
      "command": ["node", "C:\\ragmir-mcp-server\\upload-client\\upload-client.mjs"],
      "environment": {
        "RAGMIR_UPLOAD_URL": "http://192.168.1.100:8002/upload"
      },
      "enabled": true
    }
  }
}
```

3. Restart OpenCode.

### How the agent uses it

The agent gets an `upload_to_ragmir` tool from the ragmir-upload MCP server. It simply calls:

```
upload_to_ragmir(project="my-project", path="docs/report.docx", localPath="C:\\Users\\user\\Documents\\report.docx")
```

The agent reads the file locally and uploads it — **no code, no shell commands, no manual steps**.

### Tools provided

| Tool | Description |
|---|---|
| `upload_to_ragmir(project, path, localPath)` | Upload a local file to a Ragmir project |
| `list_local_files(directory, extensions?)` | List files in a local directory (useful for finding files to upload) |

### Alternative: config.json

If environment variables don't work, create `config.json` next to `upload-client.mjs`:
```json
{
  "uploadUrl": "http://192.168.1.100:8002/upload"
}
```

### No file size limit

The upload client uses Node.js `http.request` (no undici `fetch`), so there is **no 50MB limit** — files of any size can be uploaded.

## Connecting from Open WebUI

1. Go to **Admin Settings** → **Connections** → **OpenAPI Servers**
2. Click **Add OpenAPI Server**
3. Enter:
   - **Name:** `Ragmir`
   - **URL:** `http://192.168.1.100:8000/ragmir`
   - **API Key:** `your-api-key`
4. Click **Save**

## Configuration

### Server files

| File | Description |
|---|---|
| `/usr/local/lib/ragmir-server/server.js` | MCP server |
| `/etc/ragmir/mcpo-config.json` | mcpo configuration |
| `/etc/systemd/system/ragmir-mcp.service` | systemd service |
| `/opt/ragmir-projects/` | Project storage |

### Management

```bash
# Service
systemctl status ragmir-mcp
systemctl restart ragmir-mcp
journalctl -u ragmir-mcp -f

# SSE gateway (ragmir MCP)
systemctl status ragmir-sse
systemctl restart ragmir-sse
journalctl -u ragmir-sse -f

# SSE gateway (ragmir-upload MCP, optional)
systemctl status ragmir-upload-mcp
systemctl restart ragmir-upload-mcp
journalctl -u ragmir-upload-mcp -f

# Logs
journalctl -u ragmir-mcp -n 50 --no-pager
```

## Troubleshooting

### Service won't start

```bash
# Check Node.js version
node --version  # Must be >= 22

# Check logs
journalctl -u ragmir-mcp -n 50

# Check mcpo
curl http://localhost:8000/docs
```

### Connection refused

```bash
# Check if port is listening
ss -tlnp | grep 8000

# Check firewall
sudo ufw allow 8000/tcp

# Check API key
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:8000/ragmir/ragmir_list_projects -X POST -d '{}'
```

### Project not found

Projects are stored in `/opt/ragmir-projects/`. Create via MCP:

```bash
curl -X POST http://localhost:8000/ragmir/ragmir_create_project \
  -H "Authorization: Bearer CHANGE-ME" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-project"}'
```

## Known upstream issues

The MCP server delegates to the global `@jcode.labs/ragmir` package. Issues in
that package that affect this server are tracked here.

### `rgr ingest` silently fails on every PDF

**Symptom.** `rgr ingest` exits 0 but every PDF emits
`Parsing: pdf.destroy is not a function`; the per-file `errors` counter in
the run summary increments.

**Cause.** Upstream `packages/ragmir-core/src/parsing.ts:686` calls
`await pdf.destroy()` unconditionally in a `finally` block. `unpdf@1.8.0`
removed `PDFDocumentProxy.destroy()` from the returned proxy. Upstream
`packages/ragmir-core/package.json` declares `"unpdf": "^1.4.0"`, which
allowed the breaking bump. Verified at runtime:

- `unpdf@1.6.2` — `typeof pdf.destroy === 'function'`, `await pdf.destroy()`
  resolves cleanly.
- `unpdf@1.8.0` — `typeof pdf.destroy === 'undefined'`, calling it throws
  `pdf.destroy is not a function`.

**Reported.** https://github.com/jcode-works/jcode-ragmir/issues/158

**Workaround.** Apply the local one-line patch via the idempotent script:

```bash
scripts/apply-rgr-pdf-patch.sh
```

The script wraps the call in a type guard:

```diff
-        await pdf.destroy();
+        if (typeof pdf.destroy === "function") await pdf.destroy();
```

It is idempotent (running it again is a no-op) and runs automatically as
the `postinstall` hook of this repo (`package.json`). If upstream ships a fix
(pin to `unpdf ~1.6.x` or a defensive guard in `parsing.ts`), restore the
original file and delete the script:

```bash
# List backups
ls /usr/local/node22/lib/node_modules/@jcode.labs/ragmir/dist/parsing.js.bak.*

# Restore
cp /usr/local/node22/lib/node_modules/@jcode.labs/ragmir/dist/parsing.js.bak.<timestamp> \
   /usr/local/node22/lib/node_modules/@jcode.labs/ragmir/dist/parsing.js
```

### `rgr ingest` rejects YAML files with frontmatter

**Symptom.** Any `.yaml` / `.yml` file containing more than one YAML
document (the Hugo / Jekyll / Eleventy / Hexo / Pelican frontmatter
pattern) fails to ingest with:

```
YAML.parse() ERROR: Source contains multiple documents;
please use YAML.parseAllDocuments() at line 5, column 1
```

The file is silently skipped — `indexedFiles` does not increment for it
and `rgr audit` reports it as missing from the index.

**Cause.** Upstream `packages/ragmir-core/src/parsing.ts:86` (compiled
`dist/parsing.js`) handles `.yaml` / `.yml` via `YAML.parse()`. The
`yaml` npm package (v2.9.0) refuses multi-document sources in `parse()`
and points at `parseAllDocuments()` for that case.

**Reported.** https://github.com/jcode-works/jcode-ragmir/issues/159

**Workaround.** Apply the local multi-line patch via the idempotent script:

```bash
scripts/apply-rgr-yaml-patch.sh
```

The script replaces the single `YAML.stringify(YAML.parse(...))` call
with `YAML.parseAllDocuments(...)` + `map` + `join("\n")`:

```diff
-        text = YAML.stringify(YAML.parse(await readFile(file.absolutePath, "utf8")));
+        const docs = YAML.parseAllDocuments(await readFile(file.absolutePath, "utf8"));
+        text = docs.map((d) => YAML.stringify(d)).join("\n");
```

Both documents (frontmatter + body) become indexable text and the file
ingests cleanly. Empty / frontmatter-only documents stringify to `null`
and are handled by the existing downstream null-text path.

## License

MIT
