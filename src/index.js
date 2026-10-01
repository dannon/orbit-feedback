// Capture-only feedback Worker. Accepts a validated POST and stores one D1 row.
// Mirrors ~/work/gta's shape (hashIP, Basic-auth admin) minus all cert machinery.

import {
  deleteExpiredObservations,
  handleAdminObservations,
  handleDeleteObservation,
  handlePostObservation,
} from "./observations.js";
import { monthlyHmacHex, sha256Hex } from "./hash.js";

const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_HOUR = 20;
const SOURCES = new Set(["orbit", "loom-cli", "orbit-cli"]);
// Validated ids are UUIDs; this is the cheap shape gate on the path segment so a
// traversal-shaped id never reaches a bind parameter.
const OBSERVATION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const IP_HASH_CHARS = 16;
// Exactly the FeedbackPayload interface in loom's shared/feedback-contract.d.ts.
// Both senders (the brain's /feedback command and Orbit's report modal) build
// from it, so anything else means the client and this Worker disagree.
const FEEDBACK_KEYS = new Set([
  "schemaVersion", "source", "testerId", "title", "body",
  "sysinfo", "activityTail", "shellTail", "clientTs",
]);

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
      if (url.pathname === "/observations" && request.method === "POST") {
        return await handlePostObservation(request, env);
      }
      const retract = /^\/observations\/([^/]+)$/.exec(url.pathname);
      if (retract && request.method === "DELETE") {
        const id = safeDecode(retract[1]);
        if (id === null || !OBSERVATION_ID.test(id)) return json({ ok: false, error: "not found" }, 404);
        return await handleDeleteObservation(request, env, id);
      }
      if (url.pathname === "/admin/observations" && request.method === "GET") {
        const unauth = requireBasicAuth(request, env);
        if (unauth) return unauth;
        return await handleAdminObservations(request, env);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      // Don't echo internal error text (SQL/table names, runtime throws) to
      // clients; log it server-side and return a generic message.
      console.error("feedback worker error", err);
      return json({ ok: false, error: "internal error" }, 500);
    }
  },

  // Daily retention sweep for the observations table. A failure is logged and
  // swallowed: tomorrow's run picks up whatever this one missed, and throwing
  // out of a cron handler only gets it retried against the same broken state.
  async scheduled(event, env, ctx) {
    try {
      const deleted = await deleteExpiredObservations(env);
      console.log("observation expiry sweep", { cron: event && event.cron, deleted });
    } catch (err) {
      console.error("observation expiry sweep failed", err);
    }
  },
};

async function handleFeedback(request, env) {
  if (env.FEEDBACK_KEY) {
    const got = request.headers.get("X-Orbit-Feedback-Key");
    if (got !== env.FEEDBACK_KEY) return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Reject early on the declared length, then re-check the true byte size after
  // reading (Content-Length can be absent or lie; raw.length counts UTF-16 units,
  // so measure encoded bytes for an accurate cap).
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, 413);
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (!isValid(payload)) return json({ ok: false, error: "invalid payload" }, 422);

  const ipHash = await hashIP(request.headers.get("cf-connecting-ip") || "unknown", env);
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
      `INSERT INTO feedback (id, received_at, client_ts, source, app_version, title, body, payload, ip_hash, tester_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, now, str(payload.clientTs), str(payload.source),
      str(payload.sysinfo && payload.sysinfo.appVersion),
      str(payload.title), str(payload.body), raw, ipHash, str(payload.testerId),
    )
    .run();

  return json({ ok: true, id }, 201);
}

async function handleAdmin(request, env) {
  const unauth = requireBasicAuth(request, env);
  if (unauth) return unauth;
  const params = new URL(request.url).searchParams;
  const limit = Math.min(parseInt(params.get("limit") || "50", 10) || 50, 500);
  const offset = Math.max(parseInt(params.get("offset") || "0", 10) || 0, 0);
  const res = await env.DB
    .prepare("SELECT id, received_at, source, app_version, title, body, payload, tester_id FROM feedback ORDER BY received_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all();
  return json({ ok: true, rows: (res.results || []).map(withPayloadFields) }, 200);
}

// Surface the stored payload's top-level fields (schemaVersion, sysinfo,
// activityTail, shellTail, clientTs, ...) as first-class row properties so admins
// don't have to JSON.parse the blob. The raw payload string is retained, and the
// row's own DB columns win on any key collision.
function withPayloadFields(row) {
  let fields;
  try { fields = JSON.parse(row.payload); } catch { return row; }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return row;
  return { ...fields, ...row };
}

function isValid(p) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  // Strict: an unknown top-level key means the client and this Worker disagree
  // about the contract, so refuse rather than store a shape nobody validated.
  // Log how many (never the names or values -- both are client-controlled) so a
  // client that adds a field shows up in the log instead of silently vanishing.
  const unknown = Object.keys(p).filter((k) => !FEEDBACK_KEYS.has(k));
  if (unknown.length > 0) {
    console.error("feedback payload has unknown top-level keys", { count: unknown.length });
    return false;
  }
  if (p.schemaVersion !== 1) return false;
  if (typeof p.source !== "string" || !SOURCES.has(p.source)) return false;
  if (typeof p.title !== "string" || p.title.trim().length === 0) return false;
  if (typeof p.body !== "string") return false;
  if (typeof p.clientTs !== "string") return false;
  if (p.testerId !== undefined && typeof p.testerId !== "string") return false;
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

// A malformed escape is a 404 like any other bad id, not a 500.
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function str(v) { return v == null ? null : String(v); }

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// Monthly-keyed HMAC once OBS_HASH_SECRET is set, so a leaked table cannot be
// joined across months. Falls back to the original bare SHA-256 prefix while the
// secret is unset, because /feedback is live and a deploy that lands before
// `wrangler secret put` must keep ingesting. The hash changing at a month
// boundary only resets one hour of rate-limit history.
async function hashIP(ip, env) {
  if (env && env.OBS_HASH_SECRET) {
    return await monthlyHmacHex(ip, env.OBS_HASH_SECRET, IP_HASH_CHARS);
  }
  return (await sha256Hex(ip)).slice(0, IP_HASH_CHARS);
}
