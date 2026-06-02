import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "./index.js";

function fakeEnv(overrides = {}) {
  const rows = [];
  const DB = {
    rows,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { this._args = a; return this; },
        async run() {
          if (/^INSERT/i.test(sql)) rows.push(this._args);
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (/COUNT/i.test(sql)) return { n: rows.filter((r) => r[8] === this._args[0]).length };
          return null;
        },
        async all() { return { results: rows.map((r) => ({ id: r[0] })) }; },
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

const valid = {
  schemaVersion: 1, source: "orbit", title: "Bug", body: "x",
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

  it("rejects an invalid payload with 422", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(post({ ...valid, title: "" }), env);
    expect(res.status).toBe(422);
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

  it("404s unknown routes", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://x/nope"), env);
    expect(res.status).toBe(404);
  });
});
