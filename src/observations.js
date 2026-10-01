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

  return json({ ok: true, id: payload.id, retractToken }, 202);
}

export async function handleDeleteObservation(request, env, id) {
  const denied = requireIngest(request, env);
  if (denied) return denied;
  return json({ ok: false, error: "not implemented" }, 501);
}

export async function handleAdminObservations(request, env) {
  return json({ ok: false, error: "not implemented" }, 501);
}

export async function deleteExpiredObservations(env, now = new Date()) {
  return 0;
}
