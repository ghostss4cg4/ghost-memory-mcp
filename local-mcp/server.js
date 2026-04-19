#!/usr/bin/env node
// NANCE Local MCP Server — v0.6.0
// Speaks stdio MCP protocol for Claude Desktop.
// Two layers:
//   1. Remote proxy — forwards memory.* and proxy.* to the live CF Worker
//   2. Local tools  — filesystem, shell, browser (OS-level, can't run on CF)
//
// Config via env vars (set in claude_desktop_config.json):
//   NANCE_WORKER_URL   — CF Worker base URL (default: https://saumil-memory-gateway.saumil-nance.workers.dev)
//   NANCE_AUTH_TOKEN   — MCP_AUTH_TOKEN value
//   NANCE_ALLOW_SHELL  — set to "true" to enable local.shell.run (disabled by default for safety)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const WORKER_URL  = process.env.NANCE_WORKER_URL  || "https://saumil-memory-gateway.saumil-nance.workers.dev";
const AUTH_TOKEN  = process.env.NANCE_AUTH_TOKEN  || "";
const ALLOW_SHELL = process.env.NANCE_ALLOW_SHELL === "true";

// ── Remote proxy ─────────────────────────────────────────────
// Calls POST /mcp on the CF Worker and returns the result text.
async function callWorker(toolName, args = {}) {
  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify({
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
  });
  const data = await res.json();
  if (data.isError) throw new Error(data.content?.[0]?.text || "Worker error");
  return data.content?.[0]?.text || "{}";
}

// ── MCP Server ───────────────────────────────────────────────
const server = new McpServer({
  name: "NANCE",
  version: "0.6.0"
});

// ── Remote tools (proxy to CF Worker) ────────────────────────
// Each tool just forwards to callWorker. Schema mirrors the CF manifest.

server.tool("memory.ping", "Health check against the NANCE CF Worker.", {}, async () => ({
  content: [{ type: "text", text: await callWorker("memory.ping") }]
}));

server.tool("memory.snapshot", "Full memory graph + last 10 log entries.", {}, async () => ({
  content: [{ type: "text", text: await callWorker("memory.snapshot") }]
}));

server.tool("memory.graph.get", "Fetch all key-value fields from the memory graph.", {}, async () => ({
  content: [{ type: "text", text: await callWorker("memory.graph.get") }]
}));

server.tool("memory.graph.set", "Write a key-value field to the memory graph.",
  { field: z.string().describe("Key to write"), value: z.string().describe("Value to store") },
  async ({ field, value }) => ({ content: [{ type: "text", text: await callWorker("memory.graph.set", { field, value }) }] })
);

server.tool("memory.graph.delete", "Delete a field from the memory graph.",
  { field: z.string().describe("Key to delete") },
  async ({ field }) => ({ content: [{ type: "text", text: await callWorker("memory.graph.delete", { field }) }] })
);

server.tool("memory.log.get", "Get recent event log entries.",
  { n: z.number().int().optional().describe("Number of entries (default 20)") },
  async ({ n } = {}) => ({ content: [{ type: "text", text: await callWorker("memory.log.get", { n }) }] })
);

server.tool("memory.log.append", "Append a text entry to the event log.",
  { text: z.string().describe("Log entry text") },
  async ({ text }) => ({ content: [{ type: "text", text: await callWorker("memory.log.append", { text }) }] })
);

server.tool("memory.vector.search", "Semantic search over stored memory vectors.",
  { text: z.string().describe("Query text"), limit: z.number().int().optional().describe("Max results") },
  async ({ text, limit }) => ({ content: [{ type: "text", text: await callWorker("memory.vector.search", { text, limit }) }] })
);

server.tool("memory.vector.upsert", "Embed text and upsert into Qdrant.",
  { id: z.string(), text: z.string(), payload: z.record(z.any()).optional() },
  async ({ id, text, payload }) => ({ content: [{ type: "text", text: await callWorker("memory.vector.upsert", { id, text, payload }) }] })
);

server.tool("memory.notion.append", "Append a page to NANCE Notion workspace.",
  { text: z.string(), title: z.string().optional() },
  async ({ text, title }) => ({ content: [{ type: "text", text: await callWorker("memory.notion.append", { text, title }) }] })
);

server.tool("memory.notion.search", "Search NANCE Notion pages.",
  { query: z.string() },
  async ({ query }) => ({ content: [{ type: "text", text: await callWorker("memory.notion.search", { query }) }] })
);

server.tool("memory.context.build",
  "Build compressed NANCE context block (graph + log + semantic). Call at session start.",
  { query: z.string().optional().describe("Semantic anchor query") },
  async ({ query } = {}) => ({ content: [{ type: "text", text: await callWorker("memory.context.build", { query }) }] })
);

server.tool("memory.context.ingest",
  "Ingest a conversation turn into all memory layers. Call at session end.",
  {
    id: z.string().describe("Unique turn ID e.g. turn_20260419_001"),
    text: z.string().describe("Turn content"),
    tags: z.array(z.string()).optional(),
    graph_updates: z.record(z.string()).optional()
  },
  async (params) => ({ content: [{ type: "text", text: await callWorker("memory.context.ingest", params) }] })
);

server.tool("proxy.github",
  "Proxy authenticated GitHub API requests via NANCE CF Worker.",
  {
    method: z.enum(["GET","POST","PATCH","PUT","DELETE"]).optional().default("GET"),
    path: z.string().describe("GitHub API path e.g. /repos/ghostss4cg4/ghost-memory-mcp/issues"),
    body: z.record(z.any()).optional()
  },
  async ({ method, path, body }) => ({ content: [{ type: "text", text: await callWorker("proxy.github", { method, path, body }) }] })
);

// ── Local-only tools ──────────────────────────────────────────
// These require OS access and cannot run on CF Worker.

server.tool("local.fs.read",
  "Read a file from the local filesystem. Returns text content.",
  { path: z.string().describe("Absolute or relative file path") },
  async ({ path: filePath }) => {
    const abs = path.resolve(filePath);
    const content = await fs.readFile(abs, "utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

server.tool("local.fs.write",
  "Write text content to a local file. Creates directories if needed.",
  {
    path: z.string().describe("Absolute or relative file path"),
    content: z.string().describe("Text content to write"),
    append: z.boolean().optional().describe("Append instead of overwrite (default false)")
  },
  async ({ path: filePath, content, append = false }) => {
    const abs = path.resolve(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (append) await fs.appendFile(abs, content, "utf-8");
    else await fs.writeFile(abs, content, "utf-8");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: abs, mode: append ? "append" : "write" }) }] };
  }
);

server.tool("local.fs.list",
  "List files in a local directory.",
  {
    path: z.string().describe("Directory path"),
    recursive: z.boolean().optional().describe("List recursively (default false)")
  },
  async ({ path: dirPath, recursive = false }) => {
    const abs = path.resolve(dirPath);
    async function listDir(dir, depth = 0) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel  = path.relative(abs, full);
        results.push({ path: rel, type: e.isDirectory() ? "dir" : "file" });
        if (recursive && e.isDirectory() && depth < 4) results.push(...await listDir(full, depth + 1));
      }
      return results;
    }
    const entries = await listDir(abs);
    return { content: [{ type: "text", text: JSON.stringify({ root: abs, entries }) }] };
  }
);

server.tool("local.fs.delete",
  "Delete a local file.",
  { path: z.string() },
  async ({ path: filePath }) => {
    await fs.unlink(path.resolve(filePath));
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
);

server.tool("local.shell.run",
  ALLOW_SHELL
    ? "Execute a shell command. Returns stdout and stderr. NANCE_ALLOW_SHELL=true."
    : "Shell execution is DISABLED. Set NANCE_ALLOW_SHELL=true in claude_desktop_config.json to enable.",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory (default: process.cwd())"),
    timeout: z.number().int().optional().describe("Timeout in ms (default 30000)")
  },
  async ({ command, cwd, timeout = 30000 }) => {
    if (!ALLOW_SHELL) throw new Error("Shell execution disabled. Set NANCE_ALLOW_SHELL=true to enable.");
    const { stdout, stderr } = await execAsync(command, { cwd: cwd || process.cwd(), timeout });
    return { content: [{ type: "text", text: JSON.stringify({ stdout, stderr }) }] };
  }
);

server.tool("local.http.fetch",
  "Fetch a URL and return the response body. Useful for scraping or hitting local services.",
  {
    url: z.string().url(),
    method: z.enum(["GET","POST","PUT","DELETE"]).optional().default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.string().optional()
  },
  async ({ url, method = "GET", headers = {}, body }) => {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    return { content: [{ type: "text", text: JSON.stringify({ status: res.status, body: text.slice(0, 8000) }) }] };
  }
);

// ── Start ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[NANCE] Local MCP server running. Worker:", WORKER_URL);
