// Shared fixture for the tests that drive a real D1. Not imported by the Worker,
// so wrangler never bundles it.
//
// This pool version has no per-test storage isolation (isolatedStorage was
// removed), so a row written by one test is visible to the next. Every real-D1
// test file therefore runs resetDatabase() in beforeEach.
import { env } from "cloudflare:workers";
import schema from "../schema.sql?raw";

// D1's exec() splits on newlines, which multi-line CREATE TABLE statements break,
// so apply one prepared statement at a time instead.
const STATEMENTS = schema.split(";").map((s) => s.trim()).filter(Boolean);

export const INGEST_KEY = "test-ingest-key";
export const HASH_SECRET = "test-obs-secret";
export const ADMIN_PASSWORD = "test-admin-pw";
export const BASIC_AUTH = { authorization: "Basic " + btoa("admin:" + ADMIN_PASSWORD) };

export async function resetDatabase() {
  for (const statement of STATEMENTS) await env.DB.prepare(statement).run();
  await env.DB.prepare("DELETE FROM observations").run();
  await env.DB.prepare("DELETE FROM feedback").run();
}

export function testEnv(overrides = {}) {
  return {
    DB: env.DB,
    FEEDBACK_KEY: INGEST_KEY,
    OBS_HASH_SECRET: HASH_SECRET,
    ADMIN_PASSWORD,
    ...overrides,
  };
}
