import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase } from "./test-support.js";
import { monthlyHmacHex, sha256Hex } from "./hash.js";
import worker from "./index.js";

const valid = {
  schemaVersion: 1,
  source: "orbit",
  title: "Bug",
  body: "x",
  clientTs: "2026-09-30T00:00:00.000Z",
};

function post(body, headers = {}) {
  return new Request("https://x/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function storedIpHash() {
  return (await env.DB.prepare("SELECT ip_hash FROM feedback").first()).ip_hash;
}
async function feedbackCount() {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first()).n;
}

beforeEach(resetDatabase);

describe("/feedback strict payload", () => {
  it("still accepts every documented field", async () => {
    const res = await worker.fetch(post({
      ...valid,
      testerId: "orbit-007",
      sysinfo: { appVersion: "0.6.1", platform: "darwin", wsl: false },
      activityTail: "t1 tool.end bash ok",
      shellTail: "bash(...)",
    }), { DB: env.DB });
    expect(res.status).toBe(201);
    expect(await feedbackCount()).toBe(1);
  });

  it("rejects an unknown top-level key with 422 and stores nothing", async () => {
    const res = await worker.fetch(post({ ...valid, transcript: "the whole chat" }), { DB: env.DB });
    expect(res.status).toBe(422);
    expect(await feedbackCount()).toBe(0);
  });

  it("does not echo the unknown key's value", async () => {
    const res = await worker.fetch(post({ ...valid, secretField: "sk-live-123" }), { DB: env.DB });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("sk-live-123");
  });

  it("rejects an array body", async () => {
    const res = await worker.fetch(post([valid]), { DB: env.DB });
    expect(res.status).toBe(422);
  });

  it("rejects a non-string testerId", async () => {
    const res = await worker.fetch(post({ ...valid, testerId: 7 }), { DB: env.DB });
    expect(res.status).toBe(422);
    expect(await feedbackCount()).toBe(0);
  });
});

describe("/feedback ip_hash", () => {
  it("uses the monthly HMAC when OBS_HASH_SECRET is set", async () => {
    await worker.fetch(post(valid), { DB: env.DB, OBS_HASH_SECRET: "s" });
    const hashed = await storedIpHash();
    expect(hashed).toBe(await monthlyHmacHex("203.0.113.7", "s", 16));
    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
  });

  it("falls back to the bare SHA-256 prefix while the secret is unset", async () => {
    await worker.fetch(post(valid), { DB: env.DB });
    expect(await storedIpHash()).toBe((await sha256Hex("203.0.113.7")).slice(0, 16));
  });

  it("produces a different hash under the secret than without it", async () => {
    await worker.fetch(post(valid), { DB: env.DB, OBS_HASH_SECRET: "s" });
    const withSecret = await storedIpHash();
    await resetDatabase();
    await worker.fetch(post(valid), { DB: env.DB });
    expect(await storedIpHash()).not.toBe(withSecret);
  });

  it("still rate-limits at 20 per hour with the HMAC in place", async () => {
    const e = { DB: env.DB, OBS_HASH_SECRET: "s" };
    for (let i = 0; i < 20; i++) {
      expect((await worker.fetch(post(valid), e)).status).toBe(201);
    }
    expect((await worker.fetch(post(valid), e)).status).toBe(429);
    expect(await feedbackCount()).toBe(20);
  });

  it("keeps two different IPs on separate budgets", async () => {
    const e = { DB: env.DB, OBS_HASH_SECRET: "s" };
    for (let i = 0; i < 20; i++) await worker.fetch(post(valid), e);
    const other = await worker.fetch(post(valid, { "cf-connecting-ip": "198.51.100.4" }), e);
    expect(other.status).toBe(201);
  });
});
