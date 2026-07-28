# Ragmir MCP Server

Universal MCP server for [Ragmir](https://www.npmjs.com/package/@jcode.labs/ragmir) — local-first RAG knowledge base. Manage projects, upload files, ingest, and search **all via MCP over HTTP**.

Remote AI agents (OpenCode, Claude, Cursor, etc.) can create projects, provide files, build vector indexes, and query the knowledge base — without SSH or CLI access.

## Features

- **14 MCP tools** — project management, file operations, indexing, search
- **Remote access** — any agent on the LAN can use it via HTTP
- **Multi-project** — unlimited projects, each with its own vector index
- **OpenAPI docs** — auto-generated interactive docs at `/docs`
- **Zero cloud** — fully local, no data leaves your network

## Architecture

```
[Remote Agent / OpenCode]                  [Open WebUI]
         │                                       │
         │  SSE (MCP transport)                  │  REST (OpenAPI)
         ▼                                       ▼
    supergateway :8001                     mcpo :8000
         │                                       │
         │  stdio (stdin/stdout)                 │  stdio
         ▼                                       ▼
    ragmir-server.js  ◄─── shared ───►   ragmir-server.js
         │                                       │
         ├── rgr CLI (search, ingest, ask, research)
         └── /opt/ragmir-projects/ (project storage)
```

Two ports, one server:
- **Port 8001** — SSE transport (MCP protocol) for OpenCode, Claude, Cursor
- **Port 8000** — REST/OpenAPI proxy (via mcpo) for Open WebUI

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
| `RAGMIR_MCP_PORT` | `8000` | HTTP port |
| `RAGMIR_MCP_API_KEY` | `CHANGE-ME` | API key for authentication |

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
| `ragmir_search` | Search with citations |
| `ragmir_ask` | Get context for a question (no LLM) |
| `ragmir_research` | Multi-query research |

## Connecting from Remote OpenCode

Add to `~/.config/opencode/opencode.jsonc` on the remote PC:

```jsonc
{
  "mcp": {
    "ragmir": {
      "type": "remote",
      "url": "http://192.168.1.100:8001",
      "enabled": true
    }
  }
}
```

Replace `192.168.1.100` with your server's IP.

**Port 8001** serves the SSE transport that OpenCode expects. Port 8000 is REST/OpenAPI (for Open WebUI).

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

## License

MIT
