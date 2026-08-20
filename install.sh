#!/usr/bin/env bash
# install.sh — Ragmir Universal MCP Server installer
# Usage: curl -sSL https://raw.githubusercontent.com/cioinside/ragmir-mcp-server/main/install.sh | bash
set -euo pipefail

INSTALL_DIR="${RAGMIR_MCP_INSTALL_DIR:-/usr/local/lib/ragmir-server}"
PROJECTS_DIR="${RAGMIR_PROJECTS_DIR:-/opt/ragmir-projects}"
PORT="${RAGMIR_MCP_PORT:-8000}"
API_KEY="${RAGMIR_MCP_API_KEY:-CHANGE-ME}"
UPLOAD_PORT="${RAGMIR_UPLOAD_PORT:-8002}"
UPLOAD_MCP_PORT="${RAGMIR_UPLOAD_MCP_PORT:-8003}"
UPLOAD_MCP_HOST="${RAGMIR_UPLOAD_MCP_HOST:-127.0.0.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Ragmir Universal MCP Server Installer ==="
echo ""

# Check Node.js >= 22
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install Node.js >= 22 first."
  exit 1
fi

NODE_VER=$(node -e "console.log(process.version)")
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js $NODE_VER found, but >= 22 is required."
  exit 1
fi
echo "Node.js: $NODE_VER ✓"

# Check rgr CLI
if ! command -v rgr &>/dev/null; then
  echo ""
  echo "Installing Ragmir CLI globally..."
  npm install -g @jcode.labs/ragmir
fi
echo "Ragmir CLI: $(rgr --version) ✓"

# Check uvx (for mcpo)
if ! command -v uvx &>/dev/null && ! command -v mcpo &>/dev/null; then
  echo ""
  echo "Installing uv (for mcpo)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "mcpo: available ✓"

# Install server
echo ""
echo "Installing server to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/server.js" "$INSTALL_DIR/server.js"
chmod +x "$INSTALL_DIR/server.js"
echo "Server: $INSTALL_DIR/server.js ✓"

if [ -d "$SCRIPT_DIR/upload-client" ]; then
  mkdir -p "$INSTALL_DIR/upload-client"
  cp -r "$SCRIPT_DIR/upload-client/." "$INSTALL_DIR/upload-client/"
  echo "Upload-client: $INSTALL_DIR/upload-client ✓"
  echo "Installing upload-client dependencies..."
  (cd "$INSTALL_DIR/upload-client" && npm install --no-audit --no-fund --silent) \
    && echo "Upload-client deps: installed ✓" \
    || echo "Upload-client deps: FAILED (agent can't upload binaries; ragmir search/write still work)"
fi

# Create projects directory
mkdir -p "$PROJECTS_DIR"
echo "Projects: $PROJECTS_DIR ✓"

# Generate mcpo config
echo ""
echo "Generating mcpo config..."
cat > /etc/ragmir/mcpo-config.json << MCFG
{
  "mcpServers": {
    "ragmir": {
      "command": "node",
      "args": ["$INSTALL_DIR/server.js"],
      "env": {
        "RAGMIR_PROJECTS_DIR": "$PROJECTS_DIR"
      }
    }
  }
}
MCFG
echo "Config: /etc/ragmir/mcpo-config.json ✓"

# Find uvx path
UVX_PATH=$(which uvx 2>/dev/null || echo "$HOME/.local/bin/uvx")

# Generate systemd service
echo "Generating systemd service..."
cat > /etc/systemd/system/ragmir-mcp.service << SVCEOF
[Unit]
Description=Ragmir MCP Server (via mcpo)
After=network.target

[Service]
Type=simple
Environment=PATH=/usr/local/node22/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
ExecStart=$UVX_PATH mcpo --config /etc/ragmir/mcpo-config.json --port $PORT --api-key "$API_KEY"
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable ragmir-mcp.service
systemctl restart ragmir-mcp.service

sleep 2
if systemctl is-active --quiet ragmir-mcp.service; then
  echo "Service (mcpo REST): active ✓"
else
  echo "Service (mcpo REST): FAILED (check: journalctl -u ragmir-mcp)"
  exit 1
fi

# --- SSE Gateway (for OpenCode/Claude/Cursor) ---
SSE_PORT="${RAGMIR_SSE_PORT:-8001}"

cat > /etc/systemd/system/ragmir-sse.service << SSEEOF
[Unit]
Description=Ragmir MCP Server (mcp-proxy SSE)
After=network.target

[Service]
Type=simple
Environment=PATH=/usr/local/node22/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
ExecStart=$(which npx 2>/dev/null || echo "/usr/local/node22/bin/npx") mcp-proxy --port $SSE_PORT --host 0.0.0.0 -- node $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SSEEOF

systemctl daemon-reload
systemctl enable ragmir-sse.service
systemctl restart ragmir-sse.service

sleep 3
if systemctl is-active --quiet ragmir-sse.service; then
  echo "Service (SSE gateway): active ✓"
else
  echo "Service (SSE gateway): FAILED (check: journalctl -u ragmir-sse)"
fi

# --- Upload MCP (SSE wrapper for upload-client, used by remote agents) ---
cat > /etc/systemd/system/ragmir-upload-mcp.service << UPLOADMCP
[Unit]
Description=Ragmir Upload MCP Server (mcp-proxy SSE)
After=network.target ragmir-upload.service

[Service]
Type=simple
Environment=PATH=/usr/local/node22/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
Environment=RAGMIR_UPLOAD_URL=http://localhost:$UPLOAD_PORT/upload
ExecStart=$(which npx 2>/dev/null || echo "/usr/local/node22/bin/npx") mcp-proxy --port $UPLOAD_MCP_PORT --host $UPLOAD_MCP_HOST -- node $INSTALL_DIR/upload-client/upload-client.mjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UPLOADMCP

if [ -f "$INSTALL_DIR/upload-client/upload-client.mjs" ]; then
  systemctl daemon-reload
  systemctl enable ragmir-upload-mcp.service
  systemctl restart ragmir-upload-mcp.service
  sleep 3
  if systemctl is-active --quiet ragmir-upload-mcp.service; then
    echo "Service (upload-mcp SSE): active ✓"
  else
    echo "Service (upload-mcp SSE): FAILED (check: journalctl -u ragmir-upload-mcp)"
  fi
else
  echo "Service (upload-mcp SSE): skipped (upload-client not installed)"
fi

# Open firewall
if command -v ufw &>/dev/null; then
  ufw allow "$PORT/tcp" 2>/dev/null || true
  ufw allow "$SSE_PORT/tcp" 2>/dev/null || true
  ufw allow "$UPLOAD_PORT/tcp" 2>/dev/null || true
  [ "$UPLOAD_MCP_HOST" = "0.0.0.0" ] && ufw allow "$UPLOAD_MCP_PORT/tcp" 2>/dev/null || true
fi

SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=== Installation Complete ==="
echo ""
echo "REST/OpenAPI (Open WebUI): http://$SERVER_IP:$PORT/ragmir/"
echo "SSE (OpenCode/Claude):    http://$SERVER_IP:$SSE_PORT"
echo "Upload MCP SSE (binaries): http://$SERVER_IP:$UPLOAD_MCP_PORT/sse (host=$UPLOAD_MCP_HOST)"
echo "HTTP upload (legacy):     http://$SERVER_IP:$UPLOAD_PORT/upload"
echo "OpenAPI docs:             http://$SERVER_IP:$PORT/ragmir/docs"
echo "API Key:                  $API_KEY"
echo ""
echo "Management:"
echo "  systemctl status ragmir-mcp          # REST proxy"
echo "  systemctl status ragmir-sse          # SSE gateway (ragmir MCP)"
echo "  systemctl status ragmir-upload-mcp   # SSE gateway (ragmir-upload MCP)"
echo "  systemctl status ragmir-upload       # HTTP upload (legacy /upload endpoint)"
echo ""
echo "Remote OpenCode config (~/.config/opencode/opencode.jsonc):"
echo "  \"ragmir\": { \"type\": \"remote\", \"url\": \"http://$SERVER_IP:$SSE_PORT/sse\", \"enabled\": true },"
echo "  \"ragmir-upload\": { \"type\": \"remote\", \"url\": \"http://$SERVER_IP:$UPLOAD_MCP_PORT/sse\", \"enabled\": true }"
