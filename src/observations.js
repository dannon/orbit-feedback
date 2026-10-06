// The /observations intake queue (contract C2). Everything here treats the body
// as hostile: it is machine-generated content from a contributor's machine, and
// nothing in it is ever published.
import { addDaysIso, monthlyHmacHex, randomHex, sha256Hex } from "./hash.js";
import { validateObservation } from "./observation-validator.js";

export const MAX_OBSERVATION_BYTES = 16 * 1024;
export const OBSERVATION_RATE_LIMIT_PER_DAY = 200;
export const OBSERVATION_RETENTION_DAYS = 180;

const INSTALL_HASH_CHARS = 32;
const RETRACT_TOKEN_BYTES = 16;
const DAY_MS = 86400_000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Fails closed, unlike /feedback. A private queue should refuse writes it can
// neither authenticate nor pseudonymise, rather than quietly storing them raw.
function requireIngest(request, env) {
  if (!env.FEEDBACK_KEY || !env.OBS_HASH_SECRET) {
    return json({ ok: false, error: "observations not configured" }, 503);
  }
  if (request.headers.get("X-Orbit-Feedback-Key") !== env.FEEDBACK_KEY) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

export async function handlePostObservation(request, env, now = new Date()) {
  const denied = requireIngest(request, env);
  if (denied) return denied;

  // Reject on the declared length first, then on the true encoded size:
  // content-length can be absent or lie, and raw.length counts UTF-16 units.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_OBSERVATION_BYTES) return json({ ok: false, error: "payload too large" }, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_OBSERVATION_BYTES) {
    return json({ ok: false, error: "payload too large" }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  const verdict = validateObservation(payload);
  if (!verdict.ok) return json({ ok: false, error: "invalid", errors: verdict.errors }, 400);

  const installHash = await monthlyHmacHex(
    payload.installToken, env.OBS_HASH_SECRET, INSTALL_HASH_CHARS, now,
  );
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM observations WHERE install_hash = ? AND received_at > ?")
    .bind(installHash, sinceIso)
    .first();
  if (recent && recent.n >= OBSERVATION_RATE_LIMIT_PER_DAY) {
    return json({ ok: false, error: "rate limited" }, 429);
  }

  // The token goes back to the contributor once and is never stored; only its
  // hash is, so a leaked table cannot be used to retract anyone else's rows.
  const retractToken = randomHex(RETRACT_TOKEN_BYTES);
  const receivedAt = now.toISOString();
  const { installToken, ...stored } = payload;

  try {
    await env.DB
      .prepare(
        `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        payload.id,
        receivedAt,
        addDaysIso(receivedAt, OBSERVATION_RETENTION_DAYS),
        payload.kind,
        payload.stage,
        payload.signature,
        JSON.stringify(payload.tools.map((t) => t.id)),
        installHash,
        await sha256Hex(retractToken),
        JSON.stringify(stored),
      )
      .run();
  } catch (err) {
    // A resend after a lost 202 collides on the primary key. Say so, so the
    // client can stop resending and record the row as sent without a token,
    // rather than treating a generic 500 as a blip worth retrying.
    if (String(err && err.message).includes("UNIQUE constraint failed")) {
      return json({ ok: false, error: "duplicate", id: payload.id }, 409);
    }
    throw err;
  }

  return json({ ok: true, id: payload.id, retractToken }, 202);
}

const RETRACT_TOKEN = /^[0-9a-f]{32}$/;

// "Idempotent" here means a repeat call has no side effects, not that it reports
// success twice: once the row is gone so is its retract_hash, so a second call
// cannot verify the token and answers 404 like every other miss. A wrong token,
// an unknown id and an already-retracted id are deliberately indistinguishable.
// The id and the hash are matched inside one DELETE, so there is no
// read-then-write window and no hash comparison in JS.
export async function handleDeleteObservation(request, env, id) {
  const denied = requireIngest(request, env);
  if (denied) return denied;

  const token = request.headers.get("X-Retract-Token") || "";
  if (!RETRACT_TOKEN.test(token)) return json({ ok: false, error: "not found" }, 404);

  const res = await env.DB
    .prepare("DELETE FROM observations WHERE id = ? AND retract_hash = ?")
    .bind(id, await sha256Hex(token))
    .run();
  if (!res.meta || res.meta.changes !== 1) return json({ ok: false, error: "not found" }, 404);
  return json({ ok: true, deleted: true }, 200);
}

const ADMIN_DEFAULT_LIMIT = 100;
const ADMIN_MAX_LIMIT = 500;

// Basic auth is checked by the router before this runs. retract_hash is left out
// of the SELECT so it cannot leak into a triage transcript; install_hash stays
// because triage counts distinct installs per cluster.
export async function handleAdminObservations(request, env) {
  const params = new URL(request.url).searchParams;
  // Clamp both ends: SQLite reads a negative LIMIT as "no limit", which would
  // walk straight past the cap.
  const requested = parseInt(params.get("limit") || "", 10) || ADMIN_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), ADMIN_MAX_LIMIT);
  const offset = Math.max(parseInt(params.get("offset") || "0", 10) || 0, 0);
  // Every stored received_at sorts above the empty string, so an absent or
  // unparseable `since` means "everything" rather than "nothing".
  const sinceRaw = params.get("since");
  // Re-serialise so the string comparison against ISO received_at is honest:
  // "Oct 1 2026" parses, but compared raw it sorts above every ISO date.
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : "";

  const res = await env.DB
    .prepare(
      `SELECT id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, observation
       FROM observations WHERE received_at > ? ORDER BY received_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(since, limit, offset)
    .all();

  return json({ ok: true, rows: (res.results || []).map(withObservationFields) }, 200);
}

// Surface the stored observation's fields as first-class row properties, the same
// way /admin/feedback does, so triage does not have to parse the blob. The row's
// own columns win on a key collision; an unparseable blob falls back to columns.
function withObservationFields(row) {
  let parsed = null;
  try {
    const candidate = JSON.parse(row.observation);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate;
  } catch {
    parsed = null;
  }
  let toolIds = row.tool_ids;
  try {
    const candidate = JSON.parse(row.tool_ids);
    if (Array.isArray(candidate)) toolIds = candidate;
  } catch {
    // Leave the raw string; a malformed row should still be readable.
  }
  return { ...(parsed || {}), ...row, tool_ids: toolIds };
}

// Retention is enforced here, not by a column default: D1 has no TTL, so the
// daily cron is the only thing that makes the 180-day promise true.
export async function deleteExpiredObservations(env, now = new Date()) {
  const res = await env.DB
    .prepare("DELETE FROM observations WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
  return (res.meta && res.meta.changes) || 0;
}
