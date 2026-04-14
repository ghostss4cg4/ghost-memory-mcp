/**
 * SAUMIL MEMORY MCP GATEWAY
 * Cloudflare Worker exposing MCP-compatible HTTP endpoints
 * Tier 1: Upstash Redis  → master knowledge graph (fast, ~200 tok reads)
 * Tier 2: Qdrant         → vector semantic search
 * Tier 3: Notion         → archival / long-form docs
 *
 * All three Claude accounts point at this single Worker URL as custom connector.
 *
 * ENV SECRETS (set via wrangler secret put):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   QDRANT_URL
 *   QDRANT_API_KEY
 *   NOTION_TOKEN
 *   NOTION_PAGE_ID
 *   MCP_AUTH_TOKEN  ← shared secret so only Claude can call this Worker
 */

// ─────────────────────────────────────────────
// CORS + AUTH helpers
// ─────────────────────────────────────────────
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

function authFail() {
  return json({ error: "Unauthorized" }, 401);
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const key  = request.headers.get("x-api-key") || "";
  const token = auth.replace("Bearer ", "").trim() || key.trim();
  return token === env.MCP_AUTH_TOKEN;
}

// ─────────────────────────────────────────────
// UPSTASH REDIS
// ─────────────────────────────────────────────
async function redisCmd(env, ...args) {
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  return res.json();
}

// Master graph: stored as a Redis HASH under key "memory:graph"
async function graphGet(env) {
  const r = await redisCmd(env, "HGETALL", "memory:graph");
  const pairs = r.result || [];
  const obj = {};
  for (let i = 0; i < pairs.length; i += 2) obj[pairs[i]] = pairs[i + 1];
  return obj;
}

async function graphSet(env, field, value) {
  return redisCmd(env, "HSET", "memory:graph", field, value);
}

async function graphDel(env, field) {
  return redisCmd(env, "HDEL", "memory:graph", field);
}

// Recent context list (capped at 50)
async function logEvent(env, text) {
  const key = "memory:log";
  await redisCmd(env, "LPUSH", key, JSON.stringify({ ts: Date.now(), text }));
  await redisCmd(env, "LTRIM", key, "0", "49");
}

async function getLog(env, n = 20) {
  const r = await redisCmd(env, "LRANGE", "memory:log", "0", String(n - 1));
  return (r.result || []).map(s => JSON.parse(s));
}

// ─────────────────────────────────────────────
// QDRANT VECTOR SEARCH
// ─────────────────────────────────────────────
const QDRANT_COLLECTION = "saumil_memory";

async function qdrantReq(env, method, path, body) {
  const res = await fetch(`${env.QDRANT_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": env.QDRANT_API_KEY
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function ensureCollection(env) {
  // Create collection if not exists (1536-dim for text-embedding-3-small, or 768 for minilm)
  return qdrantReq(env, "PUT", `/collections/${QDRANT_COLLECTION}`, {
    vectors: { size: 384, distance: "Cosine" }
  });
}

async function qdrantUpsert(env, id, vector, payload) {
  return qdrantReq(env, "PUT", `/collections/${QDRANT_COLLECTION}/points`, {
    points: [{ id, vector, payload }]
  });
}

async function qdrantSearch(env, vector, limit = 5) {
  return qdrantReq(env, "POST", `/collections/${QDRANT_COLLECTION}/points/search`, {
    vector,
    limit,
    with_payload: true
  });
}

// Simple hash-based pseudo-embedding for free-tier usage
// Replace with real embedding API call when available
function pseudoEmbed(text, dims = 384) {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += (text.charCodeAt(i) - 64) / 128;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

// ─────────────────────────────────────────────
// NOTION
// ─────────────────────────────────────────────
async function notionReq(env, method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function notionAppend(env, text, title) {
  // Append a new page under the Memory Entries sub-page (or root if not set)
  const parentId = env.NOTION_ENTRIES_PAGE_ID || env.NOTION_PAGE_ID;
  return notionReq(env, "POST", "/pages", {
    parent: { page_id: parentId },
    properties: {
      title: { title: [{ text: { content: title || "Memory Entry" } }] }
    },
    children: [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: text } }] }
    }]
  });
}

async function notionSearch(env, query) {
  return notionReq(env, "POST", "/search", {
    query,
    filter: { property: "object", value: "page" },
    page_size: 5
  });
}

// ─────────────────────────────────────────────
// MCP TOOL DISPATCHER
// ─────────────────────────────────────────────
const TOOLS = {
  // ── GRAPH (Redis) ──────────────────────────
  "memory.graph.get": async (env, _params) => {
    return { graph: await graphGet(env) };
  },
  "memory.graph.set": async (env, { field, value }) => {
    if (!field || value === undefined) throw new Error("field and value required");
    await graphSet(env, field, String(value));
    await logEvent(env, `SET graph.${field} = ${String(value).slice(0, 80)}`);
    return { ok: true, field, value };
  },
  "memory.graph.delete": async (env, { field }) => {
    if (!field) throw new Error("field required");
    await graphDel(env, field);
    await logEvent(env, `DEL graph.${field}`);
    return { ok: true, field };
  },
  "memory.log.get": async (env, { n } = {}) => {
    return { log: await getLog(env, n || 20) };
  },
  "memory.log.append": async (env, { text }) => {
    if (!text) throw new Error("text required");
    await logEvent(env, text);
    return { ok: true };
  },

  // ── VECTOR (Qdrant) ────────────────────────
  "memory.vector.upsert": async (env, { id, text, payload }) => {
    if (!id || !text) throw new Error("id and text required");
    const vector = pseudoEmbed(text);
    await qdrantUpsert(env, id, vector, { text, ...payload });
    return { ok: true, id };
  },
  "memory.vector.search": async (env, { text, limit }) => {
    if (!text) throw new Error("text required");
    const vector = pseudoEmbed(text);
    const result = await qdrantSearch(env, vector, limit || 5);
    return { results: result.result || [] };
  },
  "memory.vector.ensure_collection": async (env, _params) => {
    return ensureCollection(env);
  },

  // ── NOTION ─────────────────────────────────
  "memory.notion.append": async (env, { text, title }) => {
    if (!text) throw new Error("text required");
    const page = await notionAppend(env, text, title);
    return { ok: true, page_id: page.id, url: page.url };
  },
  "memory.notion.search": async (env, { query }) => {
    if (!query) throw new Error("query required");
    const r = await notionSearch(env, query);
    return { results: (r.results || []).map(p => ({
      id: p.id,
      url: p.url,
      title: p.properties?.title?.title?.[0]?.plain_text || "Untitled",
      last_edited: p.last_edited_time
    }))};
  },

  // ── META ───────────────────────────────────
  "memory.ping": async (_env, _params) => {
    return { status: "ok", ts: Date.now(), worker: "saumil-memory-gateway" };
  },
  "memory.snapshot": async (env, _params) => {
    const [graph, log] = await Promise.all([graphGet(env), getLog(env, 10)]);
    return { graph, recent_log: log };
  }
};

// ─────────────────────────────────────────────
// MCP MANIFEST (tools/list)
// ─────────────────────────────────────────────
const MANIFEST = {
  schema_version: "v1",
  name_for_human: "Saumil Memory Gateway",
  name_for_model: "saumil_memory",
  description_for_human: "Persistent memory across Claude sessions — Redis graph, Qdrant vector, Notion archive.",
  description_for_model: "Use this to read/write Saumil's persistent memory. Always call memory.snapshot at conversation start to load context. Use memory.graph.set for structured facts, memory.vector.upsert for semantic memories, memory.notion.append for long-form archival.",
  auth: { type: "bearer" },
  api: { type: "openapi", url: "/openapi.json" },
  tools: Object.keys(TOOLS).map(name => ({
    name,
    description: toolDescription(name)
  }))
};

function toolDescription(name) {
  const d = {
    "memory.graph.get": "Get entire master knowledge graph from Redis (all key-value facts about Saumil)",
    "memory.graph.set": "Set a field in the master knowledge graph. Args: field (string), value (string)",
    "memory.graph.delete": "Delete a field from the knowledge graph. Args: field (string)",
    "memory.log.get": "Get recent event log. Args: n (int, default 20)",
    "memory.log.append": "Append a text entry to the event log. Args: text (string)",
    "memory.vector.upsert": "Store a memory as a vector for semantic search. Args: id (string), text (string), payload (object, optional)",
    "memory.vector.search": "Semantic search over stored memories. Args: text (string), limit (int, default 5)",
    "memory.vector.ensure_collection": "Initialize Qdrant collection (run once on setup)",
    "memory.notion.append": "Archive a long-form memory to Notion. Args: text (string), title (string, optional)",
    "memory.notion.search": "Search Notion archive by keyword. Args: query (string)",
    "memory.ping": "Health check",
    "memory.snapshot": "Get full context snapshot: graph + recent log. Call at conversation start."
  };
  return d[name] || name;
}

// ─────────────────────────────────────────────
// MAIN FETCH HANDLER
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // Public: manifest + health
    if (path === "/" || path === "/manifest.json") {
      return json(MANIFEST);
    }
    if (path === "/health") {
      return json({ status: "ok", ts: Date.now() });
    }

    // Auth required for everything else
    if (!checkAuth(request, env)) return authFail();

    // MCP tool call: POST /call  { tool, params }
    if (path === "/call" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Invalid JSON" }, 400); }

      const { tool, params = {} } = body;
      if (!tool) return json({ error: "tool required" }, 400);

      const fn = TOOLS[tool];
      if (!fn) return json({ error: `Unknown tool: ${tool}` }, 404);

      try {
        const result = await fn(env, params);
        return json({ ok: true, result });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // Convenience GET shortcuts
    if (path === "/snapshot" && request.method === "GET") {
      const result = await TOOLS["memory.snapshot"](env, {});
      return json({ ok: true, result });
    }

    if (path === "/graph" && request.method === "GET") {
      const result = await TOOLS["memory.graph.get"](env, {});
      return json({ ok: true, result });
    }

    return json({ error: "Not found" }, 404);
  }
};
