import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { INGEST_KEY, resetDatabase, testEnv } from "./test-support.js";
import worker from "./index.js";

function observation(patch = {}) {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    clientTs: "2026-09-30T12:00:00.000Z",
    client: { app: "orbit", version: "0.6.1", platform: "darwin" },
    installToken: "a".repeat(32),
    kind: "tool-error",
    stage: "tool-parameterization",
    trigger: "tool_error",
    tools: [{ id: "samtools_view", version: "1.20" }],
    mcpTool: "galaxy_run_tool",
    datatypes: ["bam"],
    signature: "Tool execution failed: missing index",
    galaxy: { version: "24.2", server: "usegalaxy.eu" },
    description: "The tool needs a prebuilt index that is not on the server.",
    ...patch,
  };
}

function post(body, headers = {}) {
  return new Request("https://x/observations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Orbit-Feedback-Key": INGEST_KEY,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Clone an already-stored install_hash into n-1 extra rows so the rate-limit
// window can be exercised without computing the HMAC in the test.
async function seedRowsForSameInstall(count, receivedAt) {
  const { install_hash: installHash } = await env.DB
    .prepare("SELECT install_hash FROM observations LIMIT 1").first();
  const stmts = [];
  for (let i = 0; i < count; i++) {
    stmts.push(env.DB.prepare(
      `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, ip_hash, retract_hash, observation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`seed-${i}`, receivedAt, receivedAt, "other", "unknown", "s", "[]", installHash, "seed-ip", "r", "{}"));
  }
  await env.DB.batch(stmts);
  return installHash;
}

beforeEach(resetDatabase);

describe("POST /observations", () => {
  it("accepts a valid observation with 202 and a one-time retract token", async () => {
    const res = await worker.fetch(post(observation()), testEnv());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.retractToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stores the cluster columns the triage pass groups on", async () => {
    await worker.fetch(post(observation()), testEnv());
    const row = await env.DB.prepare("SELECT * FROM observations").first();
    expect(row.kind).toBe("tool-error");
    expect(row.stage).toBe("tool-parameterization");
    expect(row.signature).toBe("Tool execution failed: missing index");
    expect(JSON.parse(row.tool_ids)).toEqual(["samtools_view"]);
    expect(row.install_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.retract_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores the install token or the retract token itself", async () => {
    const res = await worker.fetch(post(observation()), testEnv());
    const { retractToken } = await res.json();
    const row = await env.DB.prepare("SELECT observation, retract_hash FROM observations").first();
    const stored = JSON.parse(row.observation);
    expect(stored.installToken).toBeUndefined();
    expect(stored.signature).toBe("Tool execution failed: missing index");
    expect(row.retract_hash).not.toBe(retractToken);
    expect(JSON.stringify(row)).not.toContain(retractToken);
    expect(JSON.stringify(row)).not.toContain("a".repeat(32));
  });

  it("stamps expires_at 180 days after received_at", async () => {
    await worker.fetch(post(observation()), testEnv());
    const row = await env.DB.prepare("SELECT received_at, expires_at FROM observations").first();
    const days = (Date.parse(row.expires_at) - Date.parse(row.received_at)) / 86400000;
    expect(days).toBe(180);
  });

  it("hashes the same install token to the same value and different tokens apart", async () => {
    await worker.fetch(post(observation({ installToken: "a".repeat(32) })), testEnv());
    await worker.fetch(post(observation({ installToken: "a".repeat(32) })), testEnv());
    await worker.fetch(post(observation({ installToken: "b".repeat(32) })), testEnv());
    const res = await env.DB
      .prepare("SELECT DISTINCT install_hash FROM observations").all();
    expect(res.results.length).toBe(2);
  });

  it("rejects an invalid observation with 400 and field names only", async () => {
    const res = await worker.fetch(
      post(observation({ description: "see https://usegalaxy.eu/datasets/secret" })),
      testEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid");
    expect(body.errors).toContain("description:url");
    expect(JSON.stringify(body)).not.toContain("usegalaxy.eu");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("rejects a leaked home path in the description and stores nothing", async () => {
    const res = await worker.fetch(
      post(observation({ description: "could not open /Users/jane/project/reads.bam" })),
      testEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "invalid", errors: ["description:home-path"] });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("rejects a non-ascii tool id with 400", async () => {
    const res = await worker.fetch(post(observation({ tools: [{ id: "s\u00e4mtools" }] })), testEnv());
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toContain("tools[0].id:non-ascii");
  });

  it("rejects an unknown top-level key with 400", async () => {
    const res = await worker.fetch(post(observation({ transcript: "the whole chat" })), testEnv());
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toContain("transcript:unknown-key");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await worker.fetch(post("{ not json"), testEnv());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad json");
  });

  it("rejects a body over 16 KB with 413 before validating it", async () => {
    const big = observation();
    big.description = "x".repeat(20 * 1024);
    const res = await worker.fetch(post(big), testEnv());
    expect(res.status).toBe(413);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("enforces the ingest key only when one is configured, like /feedback", async () => {
    const missing = new Request("https://x/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation()),
    });
    expect((await worker.fetch(missing, testEnv())).status).toBe(401);
    const wrong = post(observation(), { "X-Orbit-Feedback-Key": "nope" });
    expect((await worker.fetch(wrong, testEnv())).status).toBe(401);
    const noKeyConfigured = testEnv({ FEEDBACK_KEY: undefined });
    const bare = new Request("https://x/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation()),
    });
    expect((await worker.fetch(bare, noKeyConfigured)).status).toBe(202);
    expect((await worker.fetch(post(observation(), { "X-Orbit-Feedback-Key": "nope" }), noKeyConfigured)).status).toBe(202);
  });

  it("fails closed with 503 when the hash secret is unset", async () => {
    const noSecret = await worker.fetch(post(observation()), testEnv({ OBS_HASH_SECRET: undefined }));
    expect(noSecret.status).toBe(503);
    expect((await noSecret.json()).error).toBe("observations not configured");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("stores a monthly-keyed hash of the address, never the address", async () => {
    const res = await worker.fetch(post(observation(), { "cf-connecting-ip": "203.0.113.7" }), testEnv());
    expect(res.status).toBe(202);
    const row = await env.DB.prepare("SELECT ip_hash, observation FROM observations").first();
    expect(row.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    const again = await worker.fetch(post(observation(), { "cf-connecting-ip": "203.0.113.7" }), testEnv());
    expect(again.status).toBe(202);
    const rows = await env.DB.prepare("SELECT DISTINCT ip_hash AS h FROM observations").all();
    expect(rows.results.length).toBe(1);
  });

  it("rate-limits at 1000 per address per rolling 24h, across installs", async () => {
    const e = testEnv();
    const first = await worker.fetch(post(observation(), { "cf-connecting-ip": "203.0.113.9" }), e);
    expect(first.status).toBe(202);
    const { ip_hash: ipHash } = await env.DB.prepare("SELECT ip_hash FROM observations LIMIT 1").first();
    const stmts = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 999; i++) {
      stmts.push(env.DB.prepare(
        `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, ip_hash, retract_hash, observation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`ip-${i}`, now, now, "other", "unknown", "s", "[]", `install-${i % 7}`, ipHash, "r", "{}"));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const over = await worker.fetch(
      post(observation({ installToken: "e".repeat(32) }), { "cf-connecting-ip": "203.0.113.9" }), e,
    );
    expect(over.status).toBe(429);
    const elsewhere = await worker.fetch(
      post(observation({ installToken: "e".repeat(32) }), { "cf-connecting-ip": "198.51.100.4" }), e,
    );
    expect(elsewhere.status).toBe(202);
  });

  it("rate-limits at 200 per install per rolling 24h", async () => {
    const e = testEnv();
    expect((await worker.fetch(post(observation()), e)).status).toBe(202);
    await seedRowsForSameInstall(199, new Date().toISOString());
    const blocked = await worker.fetch(post(observation()), e);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("rate limited");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(200);
  });

  it("ignores rows outside the 24h window when counting", async () => {
    const e = testEnv();
    await worker.fetch(post(observation()), e);
    await seedRowsForSameInstall(199, new Date(Date.now() - 48 * 3600 * 1000).toISOString());
    expect((await worker.fetch(post(observation()), e)).status).toBe(202);
  });

  it("does not let one install's volume block another", async () => {
    const e = testEnv();
    await worker.fetch(post(observation({ installToken: "a".repeat(32) })), e);
    await seedRowsForSameInstall(199, new Date().toISOString());
    const other = await worker.fetch(post(observation({ installToken: "c".repeat(32) })), e);
    expect(other.status).toBe(202);
  });

  it("answers 409 to a resend of an id it already holds, and keeps the one row", async () => {
    const e = testEnv();
    const first = await worker.fetch(post(observation({ id: "11111111-2222-4333-8444-555555555555" })), e);
    expect(first.status).toBe(202);
    const again = await worker.fetch(post(observation({ id: "11111111-2222-4333-8444-555555555555" })), e);
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body).toEqual({ ok: false, error: "duplicate", id: "11111111-2222-4333-8444-555555555555" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first();
    expect(n.n).toBe(1);
  });

  it("returns a generic 500 and never echoes internal error text", async () => {
    const broken = testEnv({
      DB: { prepare() { throw new Error("no such table: observations"); } },
    });
    const res = await worker.fetch(post(observation()), broken);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal error");
    expect(JSON.stringify(body)).not.toContain("no such table");
  });

  it("404s the wrong method on the collection path", async () => {
    const res = await worker.fetch(new Request("https://x/observations"), testEnv());
    expect(res.status).toBe(404);
  });
});

describe("observation routes -- unmatched shapes", () => {
  it("404s a malformed percent-escape in the id instead of a 500", async () => {
    const req = new Request("https://x/observations/%E0%A4%A", {
      method: "DELETE",
      headers: { "X-Orbit-Feedback-Key": INGEST_KEY, "X-Retract-Token": "a".repeat(32) },
    });
    expect((await worker.fetch(req, testEnv())).status).toBe(404);
  });

  it("404s POST to an id path and DELETE on the collection", async () => {
    expect((await worker.fetch(post(observation()).clone(), testEnv())).status).toBe(202);
    const onId = new Request("https://x/observations/abc", { method: "POST", body: "{}" });
    expect((await worker.fetch(onId, testEnv())).status).toBe(404);
    const onCollection = new Request("https://x/observations", { method: "DELETE" });
    expect((await worker.fetch(onCollection, testEnv())).status).toBe(404);
  });
});
