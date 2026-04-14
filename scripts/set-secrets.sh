#!/bin/bash
# Inject all secrets into the deployed Cloudflare Worker.
# Run AFTER: wrangler deploy src/worker.js --name saumil-memory-gateway
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxxx bash scripts/set-secrets.sh
#
# Read values from environment — nothing hardcoded here.
# Set them first:
#   export UPSTASH_REDIS_REST_URL="https://..."
#   export UPSTASH_REDIS_REST_TOKEN="..."
#   export QDRANT_URL="https://..."
#   export QDRANT_API_KEY="..."
#   export NOTION_TOKEN="ntn_..."
#   export NOTION_PAGE_ID="..."
#   export MCP_AUTH_TOKEN="..."
#
# Or: cp .env.example .env  →  fill values  →  source .env && bash scripts/set-secrets.sh

set -e
WORKER="saumil-memory-gateway"

put() {
  local KEY=$1
  local VAL="${!KEY}"
  if [ -z "$VAL" ]; then
    echo "  ⚠️  $KEY not set — skipping"
    return
  fi
  echo "  → $KEY"
  printf '%s' "$VAL" | npx wrangler secret put "$KEY" --name "$WORKER" --stdin
}

echo "=== Setting NANCE secrets ==="
put UPSTASH_REDIS_REST_URL
put UPSTASH_REDIS_REST_TOKEN
put QDRANT_URL
put QDRANT_API_KEY
put NOTION_TOKEN
put NOTION_PAGE_ID
put MCP_AUTH_TOKEN

echo ""
echo "✅ Done. Test: curl https://saumil-memory-gateway.workers.dev/health"
