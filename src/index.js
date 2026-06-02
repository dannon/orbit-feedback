// Capture-only feedback Worker. Accepts a validated POST and stores one D1 row.
// Mirrors ~/work/gta's shape (hashIP, Basic-auth admin) minus all cert machinery.

const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_HOUR = 20;
const SOURCES = new Set(["orbit", "loom-cli"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/feedback" && request.method === "POST") {
        return await handleFeedback(request, env);
      }
      if (url.pathname === "/admin/feedback" && request.method === "GET") {
        return await handleAdmin(request, env);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  },
};

async function handleFeedback(request, env) {
  if (env.FEEDBACK_KEY) {
    const got = request.headers.get("X-Orbit-Feedback-Key");
    if (got !== env.FEEDBACK_KEY) return json({ ok: false, error: "unauthorized" }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);

  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (!isValid(payload)) return json({ ok: false, error: "invalid payload" }, 422);

  const ipHash = await hashIP(request.headers.get("cf-connecting-ip") || "unknown");
  const sinceIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND received_at > ?")
    .bind(ipHash, sinceIso)
    .first();
  if (recent && recent.n >= RATE_LIMIT_PER_HOUR) return json({ ok: false, error: "rate limited" }, 429);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO feedback (id, received_at, client_ts, source, app_version, title, body, payload, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, now, str(payload.clientTs), str(payload.source),
      str(payload.sysinfo && payload.sysinfo.appVersion),
      str(payload.title), str(payload.body), raw, ipHash,
    )
    .run();

  return json({ ok: true, id }, 201);
}

async function handleAdmin(request, env) {
  const unauth = requireBasicAuth(request, env);
  if (unauth) return unauth;
  const limit = Math.min(parseInt(new URL(request.url).searchParams.get("limit") || "50", 10) || 50, 500);
  const res = await env.DB
    .prepare("SELECT id, received_at, source, app_version, title, body FROM feedback ORDER BY received_at DESC LIMIT ?")
    .bind(limit)
    .all();
  return json({ ok: true, rows: res.results || [] }, 200);
}

function isValid(p) {
  if (typeof p !== "object" || p === null) return false;
  if (p.schemaVersion !== 1) return false;
  if (typeof p.source !== "string" || !SOURCES.has(p.source)) return false;
  if (typeof p.title !== "string" || p.title.trim().length === 0) return false;
  if (typeof p.body !== "string") return false;
  if (typeof p.clientTs !== "string") return false;
  return true;
}

function requireBasicAuth(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return json({ ok: false, error: "admin not configured" }, 503);
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    return new Response("auth required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="orbit-feedback"' } });
  }
  const decoded = atob(auth.slice(6));
  const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
  if (password !== expected) return new Response("forbidden", { status: 401 });
  return null;
}

function str(v) { return v == null ? null : String(v); }

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function hashIP(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
