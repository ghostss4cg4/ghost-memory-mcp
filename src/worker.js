/**
 * NANCE — Neural Archive & Node Connection Engine
 * Cloudflare Worker: persistent memory MCP gateway
 *
 * Tier 1: Upstash Redis  → master knowledge graph (fast reads)
 * Tier 2: Qdrant         → vector semantic search
 * Tier 3: Notion         → long-form archive
 *
 * Secrets (set via GitHub Actions or scripts/set-secrets.sh):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   QDRANT_URL, QDRANT_API_KEY
 *   NOTION_TOKEN, NOTION_PAGE_ID
 *   MCP_AUTH_TOKEN
 */

// ── CORS + AUTH ────────────────────────────────────────────────
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function checkAuth(request, env) {
  const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  const key  = (request.headers.get('x-api-key') || '').trim();
  return (auth || key) === env.MCP_AUTH_TOKEN;
}

// ── UPSTASH REDIS ──────────────────────────────────────────────
async function redisCmd(env, ...args) {
  const res = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/${args.map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  return res.json();
}

async function graphGet(env) {
  const r = await redisCmd(env, 'HGETALL', 'memory:graph');
  const pairs = r.result || [];
  const obj = {};
  for (let i = 0; i < pairs.length; i += 2) obj[pairs[i]] = pairs[i + 1];
  return obj;
}

async function graphSet(env, field, value) {
  return redisCmd(env, 'HSET', 'memory:graph', field, value);
}

async function graphDel(env, field) {
  return redisCmd(env, 'HDEL', 'memory:graph', field);
}

async function logEvent(env, text) {
  await redisCmd(env, 'LPUSH', 'memory:log', JSON.stringify({ ts: Date.now(), text }));
  await redisCmd(env, 'LTRIM', 'memory:log', '0', '49');
}

async function getLog(env, n = 20) {
  const r = await redisCmd(env, 'LRANGE', 'memory:log', '0', String(n - 1));
  return (r.result || []).map(s => { try { return JSON.parse(s); } catch { return { text: s }; } });
}

// ── QDRANT ─────────────────────────────────────────────────────
const QDRANT_COLLECTION = 'saumil_memory';

async function qdrantReq(env, method, path, body) {
  const res = await fetch(`${env.QDRANT_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': env.QDRANT_API_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function ensureCollection(env) {
  return qdrantReq(env, 'PUT', `/collections/${QDRANT_COLLECTION}`, {
    vectors: { size: 384, distance: 'Cosine' }
  });
}

function pseudoEmbed(text, dims = 384) {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % dims] += (text.charCodeAt(i) - 64) / 128;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

async function qdrantUpsert(env, id, text, payload = {}) {
  return qdrantReq(env, 'PUT', `/collections/${QDRANT_COLLECTION}/points`, {
    points: [{ id, vector: pseudoEmbed(text), payload: { text, ...payload } }]
  });
}

async function qdrantSearch(env, text, limit = 5) {
  return qdrantReq(env, 'POST', `/collections/${QDRANT_COLLECTION}/points/search`, {
    vector: pseudoEmbed(text), limit, with_payload: true
  });
}

// ── NOTION ─────────────────────────────────────────────────────
async function notionReq(env, method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function notionAppend(env, text, title) {
  return notionReq(env, 'POST', '/pages', {
    parent: { page_id: env.NOTION_PAGE_ID },
    properties: { title: { title: [{ text: { content: title || 'Memory Entry' } }] } },
    children: [{ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: text } }] } }]
  });
}

async function notionSearch(env, query) {
  return notionReq(env, 'POST', '/search', {
    query, filter: { property: 'object', value: 'page' }, page_size: 5
  });
}

// ── TOOL REGISTRY ──────────────────────────────────────────────
const TOOLS = {
  'memory.ping': async (env) =>
    ({ status: 'ok', ts: Date.now(), worker: 'saumil-memory-gateway' }),

  'memory.snapshot': async (env) =>
    ({ graph: await graphGet(env), recent_log: await getLog(env, 10) }),

  'memory.graph.get': async (env) =>
    ({ graph: await graphGet(env) }),

  'memory.graph.set': async (env, { field, value }) => {
    if (!field || value === undefined) throw new Error('field and value required');
    await graphSet(env, field, String(value));
    await logEvent(env, `SET graph.${field} = ${String(value).slice(0, 60)}`);
    return { ok: true, field, value };
  },

  'memory.graph.delete': async (env, { field }) => {
    if (!field) throw new Error('field required');
    await graphDel(env, field);
    await logEvent(env, `DEL graph.${field}`);
    return { ok: true, field };
  },

  'memory.log.get': async (env, { n } = {}) =>
    ({ log: await getLog(env, n || 20) }),

  'memory.log.append': async (env, { text }) => {
    if (!text) throw new Error('text required');
    await logEvent(env, text);
    return { ok: true };
  },

  'memory.vector.ensure_collection': async (env) =>
    ensureCollection(env),

  'memory.vector.upsert': async (env, { id, text, payload = {} }) => {
    if (!id || !text) throw new Error('id and text required');
    await qdrantUpsert(env, id, text, payload);
    return { ok: true, id };
  },

  'memory.vector.search': async (env, { text, limit }) => {
    if (!text) throw new Error('text required');
    const r = await qdrantSearch(env, text, limit || 5);
    return { results: r.result || [] };
  },

  'memory.notion.append': async (env, { text, title }) => {
    if (!text) throw new Error('text required');
    const page = await notionAppend(env, text, title);
    return { ok: true, page_id: page.id, url: page.url };
  },

  'memory.notion.search': async (env, { query }) => {
    if (!query) throw new Error('query required');
    const r = await notionSearch(env, query);
    return { results: (r.results || []).map(p => ({
      id: p.id, url: p.url,
      title: p.properties?.title?.title?.[0]?.plain_text || 'Untitled',
      last_edited: p.last_edited_time
    })) };
  }
};

// ── MAIN HANDLER ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS')
      return cors(new Response(null, { status: 204 }));

    if (pathname === '/health')
      return json({ status: 'ok', ts: Date.now(), worker: 'saumil-memory-gateway' });

    if (!checkAuth(request, env))
      return json({ error: 'Unauthorized' }, 401);

    if (pathname === '/snapshot' && request.method === 'GET')
      return json({ ok: true, result: await TOOLS['memory.snapshot'](env) });

    if (pathname === '/graph' && request.method === 'GET')
      return json({ ok: true, result: await TOOLS['memory.graph.get'](env) });

    if (pathname === '/call' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400); }

      const { tool, params = {} } = body;
      if (!tool) return json({ error: 'tool required' }, 400);

      const fn = TOOLS[tool];
      if (!fn) return json({ error: `Unknown tool: ${tool}`, available: Object.keys(TOOLS) }, 404);

      try {
        return json({ ok: true, result: await fn(env, params) });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    return json({
      name: 'NANCE Memory Gateway',
      endpoints: ['/health', '/snapshot', '/graph', '/call'],
      tools: Object.keys(TOOLS)
    });
  }
};
