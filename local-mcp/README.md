# NANCE Local MCP Server — v0.6.0

Stdio MCP server for Claude Desktop. Provides two layers:

## Layer 1 — Remote proxy (via CF Worker)
All `memory.*` and `proxy.*` tools forward to the live NANCE CF Worker at `https://saumil-memory-gateway.saumil-nance.workers.dev`. Single source of truth — no logic duplication.

## Layer 2 — Local OS tools
Tools that require filesystem or process access — impossible on CF Worker.

| Tool | What it does |
|---|---|
| `local.fs.read` | Read any local file |
| `local.fs.write` | Write/append to local file |
| `local.fs.list` | List directory contents |
| `local.fs.delete` | Delete a file |
| `local.shell.run` | Execute shell commands (requires `NANCE_ALLOW_SHELL=true`) |
| `local.http.fetch` | Fetch any URL, hit local services |

## Install

```bash
cd local-mcp
npm install
```

## Configure Claude Desktop

Edit `claude_desktop_config.json` — replace `/ABSOLUTE/PATH/TO/ghost-memory-mcp/local-mcp/server.js` with your actual path.

On Windows:
```json
"args": ["C:\\Users\\LOQ\\OneDrive\\Desktop\\New folder (3)\\ghost-memory-mcp\\local-mcp\\server.js"]
```

Config file location:
- **Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

## Shell tool

Disabled by default. To enable:
```json
"NANCE_ALLOW_SHELL": "true"
```

This gives Claude arbitrary command execution on your machine. Enable deliberately.

## Architecture

```
Claude Desktop
    │
    ▼  stdio
NANCE local server (Node.js)
    │                    │
    ▼  HTTP POST /mcp    ▼  OS calls
NANCE CF Worker       local.fs.*
(memory, github,      local.shell.*
 vectors, notion)     local.http.*
```
