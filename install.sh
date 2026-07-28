#!/usr/bin/env bash
# install.sh — Ragmir Universal MCP Server installer
# Usage: curl -sSL https://raw.githubusercontent.com/cioinside/ragmir-mcp-server/main/install.sh | bash
set -euo pipefail

INSTALL_DIR="${RAGMIR_MCP_INSTALL_DIR:-/usr/local/lib/ragmir-server}"
PROJECTS_DIR="${RAGMIR_PROJECTS_DIR:-/opt/ragmir-projects}"
PORT="${RAGMIR_MCP_PORT:-8000}"
API_KEY="${RAGMIR_MCP_API_KEY:-CHANGE-ME}"
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
  echo "Service: active ✓"
else
  echo "Service: FAILED (check: journalctl -u ragmir-mcp)"
  exit 1
fi

# Open firewall
if command -v ufw &>/dev/null; then
  ufw allow "$PORT/tcp" 2>/dev/null || true
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Server URL:  http://$(hostname -I | awk '{print $1}'):$PORT/ragmir/"
echo "OpenAPI docs: http://$(hostname -I | awk '{print $1}'):$PORT/ragmir/docs"
echo "API Key:      $API_KEY"
echo ""
echo "Management:"
echo "  systemctl status ragmir-mcp"
echo "  journalctl -u ragmir-mcp -f"
echo ""
echo "Remote OpenCode config (~/.config/opencode/opencode.jsonc):"
echo "  \"ragmir\": { \"type\": \"remote\", \"url\": \"http://$(hostname -I | awk '{print $1}'):$PORT/ragmir\" }"
