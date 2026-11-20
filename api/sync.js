// Sync storage for the app (replaces the old GitHub-repo sync).
//
//   GET  /api/sync                          -> { version, data }   (data is null until the first write)
//   PUT  /api/sync  { baseVersion, data }   -> { version }          409 { version } if someone wrote first
//
// Every request needs `Authorization: Bearer <SYNC_SECRET>`. Data lives in Upstash
// Redis (Vercel Marketplace "Upstash for Redis"), reached over its REST API so no
// packages are needed. Each write keeps the previous copy in a short history list.
const crypto = require("crypto");

const KEY = "template:sync";
const HISTORY_KEY = "template:sync:history";
const HISTORY_LEN = 30;

// Compare-and-set: write only when the caller saw the latest version.
const CAS_SCRIPT = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'v')) or 0
if cur ~= tonumber(ARGV[1]) then return {0, cur} end
local old = redis.call('HGET', KEYS[1], 'd')
if old then
  redis.call('LPUSH', KEYS[2], old)
  redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]) - 1)
end
redis.call('HSET', KEYS[1], 'v', cur + 1, 'd', ARGV[2], 't', ARGV[4])
return {1, cur + 1}
`;

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(cfg, command) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `redis HTTP ${res.status}`);
  return json.result;
}

function authorized(req, secret) {
  const header = req.headers.authorization || "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const want = Buffer.from(secret);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const secret = process.env.SYNC_SECRET;
  const cfg = redisConfig();
  if (!secret || !cfg) return send(res, 503, { error: "not_configured" });
  if (!authorized(req, secret)) return send(res, 401, { error: "unauthorized" });

  try {
    if (req.method === "GET") {
      const [v, d] = await redis(cfg, ["HMGET", KEY, "v", "d"]);
      return send(res, 200, { version: Number(v) || 0, data: d ? JSON.parse(d) : null });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const base = Number(body.baseVersion);
      if (!Number.isInteger(base) || base < 0 || !body.data || !Array.isArray(body.data.templates)) {
        return send(res, 400, { error: "bad_request" });
      }
      const [ok, version] = await redis(cfg, [
        "EVAL", CAS_SCRIPT, "2", KEY, HISTORY_KEY,
        String(base), JSON.stringify(body.data), String(HISTORY_LEN), new Date().toISOString(),
      ]);
      return send(res, ok === 1 ? 200 : 409, { version: Number(version) });
    }
    res.setHeader("Allow", "GET, PUT");
    return send(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return send(res, 502, { error: "storage_error", message: String(e.message || e) });
  }
};
