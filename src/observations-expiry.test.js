import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase, testEnv } from "./test-support.js";
import { deleteExpiredObservations } from "./observations.js";
import worker from "./index.js";

function insert(id, expiresAt, receivedAt = "2026-09-30T00:00:00.000Z") {
  return env.DB.prepare(
    `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, ip_hash, retract_hash, observation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, receivedAt, expiresAt, "other", "unknown", "s", "[]", "h", "ip", "r", "{}");
}

async function ids() {
  const res = await env.DB.prepare("SELECT id FROM observations ORDER BY id").all();
  return res.results.map((r) => r.id);
}

beforeEach(resetDatabase);

describe("deleteExpiredObservations", () => {
  it("deletes only rows at or past expires_at", async () => {
    await env.DB.batch([
      insert("long-gone", "2020-01-01T00:00:00.000Z"),
      insert("exactly-now", "2026-10-01T00:00:00.000Z"),
      insert("still-good", "2099-01-01T00:00:00.000Z"),
    ]);
    const deleted = await deleteExpiredObservations(
      { DB: env.DB }, new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(deleted).toBe(2);
    expect(await ids()).toEqual(["still-good"]);
  });

  it("returns 0 and changes nothing on an empty table", async () => {
    expect(await deleteExpiredObservations({ DB: env.DB })).toBe(0);
  });

  it("never touches the feedback table", async () => {
    await env.DB.prepare(
      "INSERT INTO feedback (id, received_at, payload) VALUES (?, ?, ?)",
    ).bind("f1", "2020-01-01T00:00:00.000Z", "{}").run();
    await env.DB.batch([insert("stale", "2020-01-01T00:00:00.000Z")]);
    await deleteExpiredObservations({ DB: env.DB });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first()).n).toBe(1);
  });
});

describe("scheduled()", () => {
  it("runs the sweep", async () => {
    await env.DB.batch([
      insert("stale", "2020-01-01T00:00:00.000Z"),
      insert("fresh", "2099-01-01T00:00:00.000Z"),
    ]);
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "23 4 * * *" }, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(await ids()).toEqual(["fresh"]);
  });

  it("swallows a sweep failure rather than throwing out of the handler", async () => {
    const broken = { DB: { prepare() { throw new Error("no such table: observations"); } } };
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: "23 4 * * *" }, broken, ctx),
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});
