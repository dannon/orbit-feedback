import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { BASIC_AUTH, resetDatabase, testEnv } from "./test-support.js";

beforeEach(resetDatabase);

describe("schema.sql", () => {
  it("creates both tables", async () => {
    const res = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = res.results.map((r) => r.name);
    expect(names).toContain("feedback");
    expect(names).toContain("observations");
  });

  it("gives observations exactly the C2 columns", async () => {
    const res = await env.DB.prepare("PRAGMA table_info(observations)").all();
    expect(res.results.map((r) => r.name)).toEqual([
      "id", "received_at", "expires_at", "kind", "stage", "signature",
      "tool_ids", "install_hash", "retract_hash", "observation",
    ]);
  });

  it("makes id the primary key and every other column NOT NULL", async () => {
    // SQLite does not imply NOT NULL on a TEXT primary key (only on an INTEGER
    // one, which aliases the rowid), so id reports notnull = 0. The route always
    // binds a validated UUID, so that is fine -- just do not assert otherwise.
    const res = await env.DB.prepare("PRAGMA table_info(observations)").all();
    const byName = Object.fromEntries(res.results.map((c) => [c.name, c]));
    expect(byName.id.pk).toBe(1);
    for (const name of ["received_at", "expires_at", "kind", "stage", "signature",
                        "tool_ids", "install_hash", "retract_hash", "observation"]) {
      expect(byName[name].notnull, `${name} should be NOT NULL`).toBe(1);
      expect(byName[name].pk).toBe(0);
    }
  });

  it("refuses a row missing a NOT NULL column", async () => {
    await expect(
      env.DB.prepare("INSERT INTO observations (id, received_at) VALUES (?, ?)")
        .bind("partial", "t").run(),
    ).rejects.toThrow();
  });

  it("creates the three observation indexes", async () => {
    const res = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_obs%' ORDER BY name")
      .all();
    expect(res.results.map((r) => r.name)).toEqual([
      "idx_obs_cluster", "idx_obs_expires", "idx_obs_received",
    ]);
  });

  it("is idempotent -- applying it twice is fine", async () => {
    await resetDatabase();
    await resetDatabase();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("rejects a duplicate observation id", async () => {
    const insert = () => env.DB.prepare(
      `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("dup", "t", "t", "other", "unknown", "s", "[]", "h", "r", "{}").run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});

describe("test-support", () => {
  it("clears rows between calls", async () => {
    await env.DB.prepare(
      `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("x", "t", "t", "other", "unknown", "s", "[]", "h", "r", "{}").run();
    await resetDatabase();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM observations").first()).n).toBe(0);
  });

  it("builds an env with the ingest key and lets a test blank a secret", () => {
    expect(testEnv().FEEDBACK_KEY).toBe("test-ingest-key");
    expect(testEnv().OBS_HASH_SECRET).toBe("test-obs-secret");
    expect(testEnv({ OBS_HASH_SECRET: undefined }).OBS_HASH_SECRET).toBeUndefined();
    expect(BASIC_AUTH.authorization).toMatch(/^Basic /);
  });
});
