# 🧠 NANCE — Neural Archive & Node Connection Engine

Saumil's persistent memory system. Single Cloudflare Worker gateway → Upstash Redis (Tier 1) + Qdrant (Tier 2) + Notion (Tier 3).

All Claude accounts share one Worker URL as custom MCP connector.

---

## 🚀 Deploy via GitHub Actions (Zero Terminal Work)

### Step 1 — Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**.
See `.env.example` for all values and where to find them.

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token (Workers:Edit) |
| `CF_ACCOUNT_ID` | `6706c2846e87f59e781520f0c9796b95` |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `QDRANT_URL` | Qdrant cluster endpoint |
| `QDRANT_API_KEY` | Qdrant API key |
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_PAGE_ID` | `342557cbe0ee816bba58e3979a7e08ce` |
| `MCP_AUTH_TOKEN` | Shared auth token for Worker calls |

### Step 2 — Trigger Deploy

**Actions → Deploy NANCE Worker → Run workflow → Run workflow**

> ⚠️ The GitHub Actions workflow file needs **Workflows** permission to be pushed via API.
> To add it: go to `github.com/settings/installations` → Claude app → Permissions → **Workflows: Read & Write**
> Or paste the file manually from `docs/deploy-workflow.yml.txt`

Worker live at: `https://saumil-memory-gateway.workers.dev`

---

## 🛠 Manual Deploy (Codespace terminal)

```bash
npm install -g wrangler
export CLOUDFLARE_API_TOKEN=<your_token>
wrangler deploy src/worker.js --name saumil-memory-gateway --compatibility-date 2026-04-14
source .env && bash scripts/set-secrets.sh
```

---

## 📡 API Reference

**Base URL:** `https://saumil-memory-gateway.workers.dev`
**Auth:** `Authorization: Bearer <MCP_AUTH_TOKEN>`

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | ❌ | Health check |
| `/snapshot` | GET | ✅ | Graph + recent log |
| `/graph` | GET | ✅ | All Redis graph fields |
| `/call` | POST | ✅ | Invoke any tool |

### Tools via `POST /call` → `{"tool": "...", "params": {...}}`

| Tool | Params | Description |
|------|--------|-------------|
| `memory.snapshot` | — | **Call at convo start** — full context |
| `memory.graph.get` | — | Full knowledge graph |
| `memory.graph.set` | `{field, value}` | Set a fact |
| `memory.graph.delete` | `{field}` | Delete a fact |
| `memory.log.get` | `{n}` | Recent N events |
| `memory.log.append` | `{text}` | Log an event |
| `memory.vector.ensure_collection` | — | Init Qdrant (run once) |
| `memory.vector.upsert` | `{id, text, payload}` | Store semantic memory |
| `memory.vector.search` | `{text, limit}` | Semantic search |
| `memory.notion.append` | `{text, title}` | Archive to Notion |
| `memory.notion.search` | `{query}` | Search Notion |
| `memory.ping` | — | Ping |

---

## 🗂 Notion Structure

Root: 🧠 NANCE — Saumil Memory System
- 📝 Memory Entries — auto-archived memories (NOTION_PAGE_ID points here)
- 📊 Graph Snapshots — Redis graph dumps
- 📈 Session Logs — per-session activity
- 🏗️ System Docs — architecture reference

---

## 🔌 Add as Claude Connector

In all Claude accounts: **Settings → Connectors → Add custom connector**
- URL: `https://saumil-memory-gateway.workers.dev`
- Auth: Bearer `<MCP_AUTH_TOKEN>`

---

## 🔬 Retrieval Architecture

See `docs/retrieval-pipeline.md` — 3-stage pipeline:
- Stage 1: Qdrant cosine similarity (✅ live)
- Stage 2: LLMLingua-2 compression (🔲 HF Space endpoint)
- Stage 3: Terse schema formatting (🔲 prompt layer, do this first)
