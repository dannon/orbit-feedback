import { describe, it, expect } from "vitest";
import worker from "./index.js";

function fakeEnv(overrides = {}) {
  const rows = [];
  const DB = {
    rows,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) {
          this._args = a;
          return this;
        },
        async run() {
          if (/^INSERT/i.test(sql)) rows.push(this._args);
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (/COUNT/i.test(sql)) {
            // Honor BOTH binds: ip_hash (r[8], _args[0]) AND the time window
            // (received_at r[1] > sinceIso _args[1]).
            const [ipHash, sinceIso] = this._args;
            return { n: rows.filter((r) => r[8] === ipHash && r[1] > sinceIso).length };
          }
          return null;
        },
        async all() {
          // Honor the real query: project exactly the SELECTed columns and
          // apply OFFSET only when the SQL asks for it, so tests exercise the
          // worker's SQL rather than a hardcoded mock shape.
          const cols = /SELECT (.+?) FROM/i.exec(sql)[1].split(",").map((c) => c.trim());
          const hasOffset = /OFFSET\s+\?/i.test(sql);
          const colIndex = {
            id: 0, received_at: 1, client_ts: 2, source: 3,
            app_version: 4, title: 5, body: 6, payload: 7, ip_hash: 8, tester_id: 9,
          };
          const [limit, offset] = this._args;
          const ordered = [...rows].reverse(); // received_at DESC ~ newest first
          const start = hasOffset ? offset || 0 : 0;
          const sliced = ordered.slice(start, start + (limit ?? ordered.length));
          return {
            results: sliced.map((r) => Object.fromEntries(cols.map((c) => [c, r[colIndex[c]]]))),
          };
        },
      };
      return stmt;
    },
  };
  return { DB, ADMIN_PASSWORD: "pw", ...overrides };
}

function post(body, headers = {}) {
  return new Request("https://x/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function adminReq(headers = {}, query = "") {
  return new Request("https://x/admin/feedback" + query, { method: "GET", headers });
}

const valid = {
  schemaVersion: 1,
  source: "orbit",
  title: "Bug",
  body: "x",
  clientTs: "2026-06-02T00:00:00.000Z",
};

describe("orbit-feedback worker", () => {
  it("stores a valid POST and returns ok+id", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(post(valid), env);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.id).toBe("string");
    expect(env.DB.rows.length).toBe(1);
  });

  it("accepts a keyless POST when FEEDBACK_KEY is not configured (v1 default)", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(post(valid), env);
    expect(res.status).toBe(201);
  });

  it("rejects an invalid payload with 422", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(post({ ...valid, title: "" }), env);
    expect(res.status).toBe(422);
    expect(env.DB.rows.length).toBe(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(post("{ not json"), env);
    expect(res.status).toBe(400);
    expect(env.DB.rows.length).toBe(0);
  });

  it("rejects an oversized body with 413", async () => {
    const env = fakeEnv();
    const big = { ...valid, body: "z".repeat(300 * 1024) };
    const res = await worker.fetch(post(big), env);
    expect(res.status).toBe(413);
  });

  it("requires the key header only when FEEDBACK_KEY is set", async () => {
    const env = fakeEnv({ FEEDBACK_KEY: "secret" });
    const noKey = await worker.fetch(post(valid), env);
    expect(noKey.status).toBe(401);
    const withKey = await worker.fetch(post(valid, { "X-Orbit-Feedback-Key": "secret" }), env);
    expect(withKey.status).toBe(201);
  });

  it("rate-limits a flooding IP with 429 after the hourly cap", async () => {
    const env = fakeEnv();
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(post(valid), env);
      expect(res.status).toBe(201);
    }
    const blocked = await worker.fetch(post(valid), env);
    expect(blocked.status).toBe(429);
    expect(env.DB.rows.length).toBe(20);
  });

  it("404s unknown routes", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://x/nope"), env);
    expect(res.status).toBe(404);
  });

  it("admin read requires Basic auth", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(adminReq(), env);
    expect(res.status).toBe(401);
  });

  it("admin read returns 503 when no password is configured", async () => {
    const env = fakeEnv({ ADMIN_PASSWORD: undefined });
    const res = await worker.fetch(adminReq({ authorization: "Basic " + btoa("admin:pw") }), env);
    expect(res.status).toBe(503);
  });

  it("admin read returns rows with correct Basic auth", async () => {
    const env = fakeEnv();
    await worker.fetch(post(valid), env);
    const res = await worker.fetch(adminReq({ authorization: "Basic " + btoa("admin:pw") }), env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.rows)).toBe(true);
    expect(json.rows.length).toBe(1);
  });

  it("admin read includes the full payload for each row", async () => {
    const env = fakeEnv();
    await worker.fetch(post({ ...valid, body: "needle" }), env);
    const res = await worker.fetch(adminReq({ authorization: "Basic " + btoa("admin:pw") }), env);
    const json = await res.json();
    expect(JSON.parse(json.rows[0].payload).body).toBe("needle");
  });

  it("admin read pages with limit and offset (newest-first)", async () => {
    const env = fakeEnv();
    for (const t of ["A", "B", "C"]) await worker.fetch(post({ ...valid, title: t }), env);
    const res = await worker.fetch(
      adminReq({ authorization: "Basic " + btoa("admin:pw") }, "?limit=1&offset=1"),
      env,
    );
    const json = await res.json();
    expect(json.rows.length).toBe(1);
    expect(json.rows[0].title).toBe("B"); // C is newest; offset 1 skips it
  });

  it("captures tester_id from the payload and surfaces it in admin reads", async () => {
    const env = fakeEnv();
    await worker.fetch(post({ ...valid, testerId: "orbit-007" }), env);
    const res = await worker.fetch(adminReq({ authorization: "Basic " + btoa("admin:pw") }), env);
    const json = await res.json();
    expect(json.rows[0].tester_id).toBe("orbit-007");
  });

  it("stores a null tester_id when the payload omits it", async () => {
    const env = fakeEnv();
    await worker.fetch(post(valid), env);
    const res = await worker.fetch(adminReq({ authorization: "Basic " + btoa("admin:pw") }), env);
    const json = await res.json();
    expect(json.rows[0].tester_id).toBe(null);
  });
});
