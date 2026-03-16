#!/bin/bash
# Generate bearer tokens for MCP server users
# Run once, save output to /etc/openclaw/mcp-tokens.json on gus
set -euo pipefail

ZACK_TOKEN=$(openssl rand -hex 32)
DEREK_TOKEN=$(openssl rand -hex 32)

cat <<EOF
{
  "tokens": {
    "${ZACK_TOKEN}": { "user": "zack", "identifier": "claude-code:zack" },
    "${DEREK_TOKEN}": { "user": "derek", "identifier": "claude-code:derek" }
  }
}

--- Save the above JSON to /etc/openclaw/mcp-tokens.json on gus ---
--- Give each user their token for ~/.claude/mcp.json: ---

Zack's token: ${ZACK_TOKEN}
Derek's token: ${DEREK_TOKEN}
EOF
