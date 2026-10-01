import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { INGEST_KEY, resetDatabase, testEnv } from "./test-support.js";
import worker from "./index.js";

function observation(patch = {}) {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    clientTs: "2026-09-30T12:00:00.000Z",
    client: { app: "loom-cli", version: "0.6.1", platform: "linux" },
    installToken: "a".repeat(32),
    kind: "retry-loop",
    stage: "job-execution",
    trigger: "retry_loop",
    tools: [{ id: "bwa_mem" }],
    datatypes: ["fastqsanger"],
    signature: "Job failed three times with the same message",
    galaxy: { server: "private" },
    description: "",
    ...patch,
  };
}

async function submit(patch = {}) {
  const body = observation(patch);
  const res = await worker.fetch(
    new Request("https://x/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orbit-Feedback-Key": INGEST_KEY },
      body: JSON.stringify(body),
    }),
    testEnv(),
  );
  expect(res.status).toBe(202);
  const { retractToken } = await res.json();
  return { id: body.id, retractToken };
}

function retract(id, token, headers = {}) {
  return new Request(`https://x/observations/${id}`, {
    method: "DELETE",
    headers: {
      "X-Orbit-Feedback-Key": INGEST_KEY,
      ...(token ? { "X-Retract-Token": token } : {}),
      ...headers,
    },
  });
}

async function count() {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n;
}

beforeEach(resetDatabase);

describe("DELETE /observations/:id", () => {
  it("deletes the row when the token matches", async () => {
    const { id, retractToken } = await submit();
    const res = await worker.fetch(retract(id, retractToken), testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(await count()).toBe(0);
  });

  it("404s a wrong token and leaves the row in place", async () => {
    const { id } = await submit();
    const res = await worker.fetch(retract(id, "b".repeat(32)), testEnv());
    expect(res.status).toBe(404);
    expect(await count()).toBe(1);
  });

  it("404s a missing token header", async () => {
    const { id } = await submit();
    expect((await worker.fetch(retract(id), testEnv())).status).toBe(404);
    expect(await count()).toBe(1);
  });

  it("404s a malformed token without reaching the database", async () => {
    const { id } = await submit();
    for (const bad of ["", "short", "A".repeat(32), "z".repeat(32), "a".repeat(64)]) {
      expect((await worker.fetch(retract(id, bad), testEnv())).status).toBe(404);
    }
    expect(await count()).toBe(1);
  });

  it("404s an unknown id even with a real token from another row", async () => {
    const { retractToken } = await submit();
    const res = await worker.fetch(retract(crypto.randomUUID(), retractToken), testEnv());
    expect(res.status).toBe(404);
    expect(await count()).toBe(1);
  });

  it("will not let one row's token delete another row", async () => {
    const first = await submit();
    const second = await submit();
    const res = await worker.fetch(retract(second.id, first.retractToken), testEnv());
    expect(res.status).toBe(404);
    expect(await count()).toBe(2);
  });

  it("404s a repeat retraction -- idempotent means no side effects, not a second success", async () => {
    const { id, retractToken } = await submit();
    expect((await worker.fetch(retract(id, retractToken), testEnv())).status).toBe(200);
    expect((await worker.fetch(retract(id, retractToken), testEnv())).status).toBe(404);
    expect(await count()).toBe(0);
  });

  it("401s without the ingest key and 503s when unconfigured", async () => {
    const { id, retractToken } = await submit();
    const noKey = new Request(`https://x/observations/${id}`, {
      method: "DELETE",
      headers: { "X-Retract-Token": retractToken },
    });
    expect((await worker.fetch(noKey, testEnv())).status).toBe(401);
    expect(
      (await worker.fetch(retract(id, retractToken), testEnv({ OBS_HASH_SECRET: undefined }))).status,
    ).toBe(503);
    expect(await count()).toBe(1);
  });

  it("404s a traversal-shaped id without reaching the database", async () => {
    await submit();
    const req = new Request(
      "https://x/observations/" + encodeURIComponent("../feedback"),
      { method: "DELETE", headers: { "X-Orbit-Feedback-Key": INGEST_KEY, "X-Retract-Token": "a".repeat(32) } },
    );
    expect((await worker.fetch(req, testEnv())).status).toBe(404);
    expect(await count()).toBe(1);
  });

  it("frees rate-limit budget, which is the documented trade", async () => {
    const { id, retractToken } = await submit();
    const { install_hash: installHash } = await env.DB
      .prepare("SELECT install_hash FROM observations LIMIT 1").first();
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 199; i++) {
      stmts.push(env.DB.prepare(
        `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`seed-${i}`, now, now, "other", "unknown", "s", "[]", installHash, "r", "{}"));
    }
    await env.DB.batch(stmts);
    expect(await count()).toBe(200);
    await worker.fetch(retract(id, retractToken), testEnv());
    expect(await count()).toBe(199);
  });
});
