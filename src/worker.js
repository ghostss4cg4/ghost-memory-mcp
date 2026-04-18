// NANCE Memory Gateway — v0.4.0
// Stage 2: Real embeddings via CF Workers AI @cf/baai/bge-small-en-v1.5
// Stage 4: proxy.github + proxy.google scaffolding (secrets-gated)

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

function checkAuth(request, env) {
  const auth = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  const key  = (request.headers.get("x-api-key") || "").trim();
  return (auth || key) === env.MCP_AUTH_TOKEN;
}

// ── Redis ────────────────────────────────────────────────────
async function redisCmd(env, ...args) {
  const res = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/${args.map(encodeURIComponent).join("/")}`,
    { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  return res.json();
}
async function graphGet(env) {
  const r = await redisCmd(env, "HGETALL", "memory:graph");
  const pairs = r.result || [];
  const obj = {};
  for (let i = 0; i < pairs.length; i += 2) obj[pairs[i]] = pairs[i + 1];
  return obj;
}
async function graphSet(env, field, value) { return redisCmd(env, "HSET", "memory:graph", field, value); }
async function graphDel(env, field)         { return redisCmd(env, "HDEL", "memory:graph", field); }
async function logEvent(env, text) {
  await redisCmd(env, "LPUSH", "memory:log", JSON.stringify({ ts: Date.now(), text }));
  await redisCmd(env, "LTRIM", "memory:log", "0", "49");
}
async function getLog(env, n = 20) {
  const r = await redisCmd(env, "LRANGE", "memory:log", "0", String(n - 1));
  return (r.result || []).map(s => { try { return JSON.parse(s); } catch { return { text: s }; } });
}

// ── Embeddings (CF Workers AI) ───────────────────────────────
// Replaces pseudoEmbed. Calls bge-small-en-v1.5 (384-dim, cosine).
// Falls back to pseudoEmbed only if AI binding is missing (local dev).
async function embed(env, text) {
  if (env.AI) {
    const res = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [text] });
    return res.data[0];
  }
  // local dev fallback — deterministic hash, NOT semantically meaningful
  console.warn("[NANCE] AI binding missing — falling back to pseudoEmbed");
  return pseudoEmbedFallback(text);
}
function pseudoEmbedFallback(text, dims = 384) {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % dims] += (text.charCodeAt(i) - 64) / 128;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

// ── Qdrant ───────────────────────────────────────────────────
const QDRANT_COLLECTION = "saumil_memory";
async function qdrantReq(env, method, path, body) {
  const res = await fetch(`${env.QDRANT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "api-key": env.QDRANT_API_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}
async function ensureCollection(env) {
  return qdrantReq(env, "PUT", `/collections/${QDRANT_COLLECTION}`, {
    vectors: { size: 384, distance: "Cosine" }
  });
}
async function qdrantUpsert(env, id, text, payload = {}) {
  const vector = await embed(env, text);
  return qdrantReq(env, "PUT", `/collections/${QDRANT_COLLECTION}/points`, {
    points: [{ id, vector, payload: { text, ...payload } }]
  });
}
async function qdrantSearch(env, text, limit = 5) {
  const vector = await embed(env, text);
  return qdrantReq(env, "POST", `/collections/${QDRANT_COLLECTION}/points/search`, {
    vector, limit, with_payload: true
  });
}

// ── Notion ───────────────────────────────────────────────────
async function notionReq(env, method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}
async function notionAppend(env, text, title) {
  return notionReq(env, "POST", "/pages", {
    parent: { page_id: env.NOTION_PAGE_ID },
    properties: { title: { title: [{ text: { content: title || "Memory Entry" } }] } },
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }]
  });
}
async function notionSearch(env, query) {
  return notionReq(env, "POST", "/search", {
    query,
    filter: { property: "object", value: "page" },
    page_size: 5
  });
}

// ── Stage 4: Google OAuth helper ─────────────────────────────
// Returns a fresh access token using stored refresh token.
// Requires secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
async function googleAccessToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google proxy secrets not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN via wrangler secret put.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token"
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google token refresh failed: ${data.error} — ${data.error_description}`);
  return data.access_token;
}

// ── Context helpers ──────────────────────────────────────────
function terseGraph(graph) {
  const PRIORITY = ["name","age","college","year","cgpa","gate_target","current_project","project_status","stack","next_action"];
  const lines = [];
  for (const k of PRIORITY)       if (graph[k] !== undefined) lines.push(`${k}: ${String(graph[k]).slice(0, 80)}`);
  for (const [k, v] of Object.entries(graph)) if (!PRIORITY.includes(k)) lines.push(`${k}: ${String(v).slice(0, 80)}`);
  return lines.join("\n");
}
function terseLog(entries, n = 5) {
  return entries.slice(0, n).map(e => {
    const t = e.ts ? new Date(e.ts).toISOString().slice(11, 16) : "??:??";
    return `${t} — ${String(e.text).slice(0, 100)}`;
  }).join("\n");
}
function terseVec(results) {
  return results.map((r, i) => {
    const score = (r.score || 0).toFixed(3);
    const text  = (r.payload?.text || "").slice(0, 120);
    return `[${i + 1}|${score}] ${text}`;
  }).join("\n");
}
function buildContextBlock(graph, log, vecResults, query) {
  const parts = ["=== NANCE CONTEXT ==="];
  const g = terseGraph(graph);
  if (g) parts.push("[GRAPH]\n" + g);
  const l = terseLog(log, 5);
  if (l) parts.push("[RECENT]\n" + l);
  if (vecResults && vecResults.length) parts.push(`[SEMANTIC:${(query||"").slice(0,40)}]\n` + terseVec(vecResults));
  parts.push("=== END ===");
  let block = parts.join("\n\n");
  if (block.length > 2000) block = block.slice(0, 1950) + "\n…(truncated)\n=== END ===";
  return block;
}

// ── ingestTurn ───────────────────────────────────────────────
async function ingestTurn(env, turn) {
  const { id, text, tags = [], graph_updates = {} } = turn;
  if (!id || !text) throw new Error("id and text required");
  const results = {};
  for (const [field, value] of Object.entries(graph_updates)) await graphSet(env, field, String(value));
  await logEvent(env, `INGEST:${id} — ${text.slice(0, 80)}`);
  results.redis = { ok: true, graph_fields_written: Object.keys(graph_updates).length };
  const numericId = Math.abs(id.split("").reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0));
  await qdrantUpsert(env, numericId, text, { source_id: id, tags, ts: Date.now() });
  results.qdrant = { ok: true, point_id: numericId };
  const notionPage = await notionAppend(env, text, id);
  results.notion = { ok: true, page_id: notionPage.id, url: notionPage.url };
  return results;
}

// ── TOOLS ────────────────────────────────────────────────────
const TOOLS = {

  // Core memory tools (Stage 1–3, unchanged)
  "memory.ping":         async (env) => ({ status: "ok", ts: Date.now(), worker: "saumil-memory-gateway" }),
  "memory.snapshot":     async (env) => ({ graph: await graphGet(env), recent_log: await getLog(env, 10) }),
  "memory.graph.get":    async (env) => ({ graph: await graphGet(env) }),
  "memory.graph.set":    async (env, { field, value }) => {
    if (!field || value === undefined) throw new Error("field and value required");
    await graphSet(env, field, String(value));
    await logEvent(env, `SET graph.${field} = ${String(value).slice(0, 60)}`);
    return { ok: true, field, value };
  },
  "memory.graph.delete": async (env, { field }) => {
    if (!field) throw new Error("field required");
    await graphDel(env, field);
    await logEvent(env, `DEL graph.${field}`);
    return { ok: true, field };
  },
  "memory.log.get":      async (env, { n } = {}) => ({ log: await getLog(env, n || 20) }),
  "memory.log.append":   async (env, { text }) => {
    if (!text) throw new Error("text required");
    await logEvent(env, text);
    return { ok: true };
  },
  "memory.vector.ensure_collection": async (env) => ensureCollection(env),
  "memory.vector.upsert": async (env, { id, text, payload = {} }) => {
    if (!id || !text) throw new Error("id and text required");
    await qdrantUpsert(env, id, text, payload);
    return { ok: true, id };
  },
  "memory.vector.search": async (env, { text, limit }) => {
    if (!text) throw new Error("text required");
    const r = await qdrantSearch(env, text, limit || 5);
    return { results: r.result || [] };
  },
  "memory.notion.append": async (env, { text, title }) => {
    if (!text) throw new Error("text required");
    const page = await notionAppend(env, text, title);
    return { ok: true, page_id: page.id, url: page.url };
  },
  "memory.notion.search": async (env, { query }) => {
    if (!query) throw new Error("query required");
    const r = await notionSearch(env, query);
    return { results: (r.results || []).map(p => ({
      id: p.id, url: p.url,
      title: p.properties?.title?.title?.[0]?.plain_text || "Untitled",
      last_edited: p.last_edited_time
    })) };
  },

  // Stage 3 — context layer
  "memory.context.build": async (env, { query } = {}) => {
    const [graph, log] = await Promise.all([graphGet(env), getLog(env, 10)]);
    const searchQuery = query || (log[0]?.text || "general context");
    const vecRaw = await qdrantSearch(env, searchQuery, 5);
    const vecResults = vecRaw.result || [];
    const block = buildContextBlock(graph, log, vecResults, searchQuery);
    return { block, stats: { graph_keys: Object.keys(graph).length, log_entries: log.length, vec_hits: vecResults.length } };
  },
  "memory.context.ingest": async (env, params) => ingestTurn(env, params),

  // ── Stage 4a: GitHub Proxy ───────────────────────────────
  // Requires secret: GITHUB_TOKEN (fine-grained PAT or classic)
  // Usage: { method?, path, body? }
  // path is the GitHub API path, e.g. "/repos/ghostss4cg4/ghost-memory-mcp/issues"
  "proxy.github": async (env, { method = "GET", path, body } = {}) => {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret not configured. Run: wrangler secret put GITHUB_TOKEN");
    if (!path) throw new Error("path required (e.g. /repos/owner/repo/issues)");
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NANCE-Memory-Gateway/0.4.0",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  },

  // ── Stage 4b: Gmail Proxy ────────────────────────────────
  // Requires secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
  // Usage: { method?, path, body? }
  // path is relative to https://gmail.googleapis.com
  // e.g. "/gmail/v1/users/me/messages?maxResults=10"
  "proxy.gmail": async (env, { method = "GET", path, body } = {}) => {
    if (!path) throw new Error("path required (e.g. /gmail/v1/users/me/messages)");
    const token = await googleAccessToken(env);
    const res = await fetch(`https://gmail.googleapis.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  },

  // ── Stage 4c: Google Calendar Proxy ─────────────────────
  // Requires secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
  // Usage: { method?, path, body? }
  // path is relative to https://www.googleapis.com/calendar/v3
  // e.g. "/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true"
  "proxy.calendar": async (env, { method = "GET", path, body } = {}) => {
    if (!path) throw new Error("path required (e.g. /calendars/primary/events)");
    const token = await googleAccessToken(env);
    const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  }
};

// ── Router ───────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (pathname === "/health")     return json({ status: "ok", ts: Date.now(), worker: "saumil-memory-gateway", version: "0.4.0" });
    if (!checkAuth(request, env))  return json({ error: "Unauthorized" }, 401);
    if (pathname === "/snapshot" && request.method === "GET") return json({ ok: true, result: await TOOLS["memory.snapshot"](env) });
    if (pathname === "/graph"    && request.method === "GET") return json({ ok: true, result: await TOOLS["memory.graph.get"](env) });
    if (pathname === "/call"     && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const { tool, params = {} } = body;
      if (!tool)     return json({ error: "tool required" }, 400);
      const fn = TOOLS[tool];
      if (!fn)       return json({ error: `Unknown tool: ${tool}`, available: Object.keys(TOOLS) }, 404);
      try   { return json({ ok: true, result: await fn(env, params) }); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({
      name: "NANCE Memory Gateway",
      version: "0.4.0",
      stage: "real-embeddings + proxy-scaffolding",
      endpoints: ["/health", "/snapshot", "/graph", "/call"],
      tools: Object.keys(TOOLS),
      proxy_tools_status: {
        "proxy.github":   env.GITHUB_TOKEN           ? "ready" : "needs GITHUB_TOKEN secret",
        "proxy.gmail":    env.GOOGLE_REFRESH_TOKEN    ? "ready" : "needs Google OAuth secrets",
        "proxy.calendar": env.GOOGLE_REFRESH_TOKEN    ? "ready" : "needs Google OAuth secrets"
      }
    });
  }
};
