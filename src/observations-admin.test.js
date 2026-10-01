import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { BASIC_AUTH, INGEST_KEY, resetDatabase, testEnv } from "./test-support.js";
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

async function submit(patch = {}) {
  const res = await worker.fetch(
    new Request("https://x/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orbit-Feedback-Key": INGEST_KEY },
      body: JSON.stringify(observation(patch)),
    }),
    testEnv(),
  );
  expect(res.status).toBe(202);
  // The ORDER BY is on received_at, so give consecutive rows distinct timestamps.
  await new Promise((r) => setTimeout(r, 2));
}

function adminReq(query = "", headers = BASIC_AUTH) {
  return new Request("https://x/admin/observations" + query, { method: "GET", headers });
}

async function read(query = "", headers = BASIC_AUTH) {
  const res = await worker.fetch(adminReq(query, headers), testEnv());
  return { status: res.status, body: await res.json() };
}

beforeEach(resetDatabase);

describe("GET /admin/observations", () => {
  it("requires Basic auth", async () => {
    expect((await worker.fetch(adminReq("", {}), testEnv())).status).toBe(401);
  });

  it("503s when no admin password is configured", async () => {
    const res = await worker.fetch(adminReq(), testEnv({ ADMIN_PASSWORD: undefined }));
    expect(res.status).toBe(503);
  });

  it("401s a wrong password", async () => {
    const wrong = { authorization: "Basic " + btoa("admin:nope") };
    expect((await worker.fetch(adminReq("", wrong), testEnv())).status).toBe(401);
  });

  it("returns an empty list when there is nothing queued", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, rows: [] });
  });

  it("breaks the stored observation out onto each row", async () => {
    await submit();
    const { body } = await read();
    const row = body.rows[0];
    expect(row.signature).toBe("Tool execution failed: missing index");
    expect(row.kind).toBe("tool-error");
    expect(row.stage).toBe("tool-parameterization");
    expect(row.trigger).toBe("tool_error");
    expect(row.galaxy).toEqual({ version: "24.2", server: "usegalaxy.eu" });
    expect(row.client).toEqual({ app: "orbit", version: "0.6.1", platform: "darwin" });
    expect(row.datatypes).toEqual(["bam"]);
    expect(row.mcpTool).toBe("galaxy_run_tool");
    expect(row.tools).toEqual([{ id: "samtools_view", version: "1.20" }]);
    expect(typeof row.received_at).toBe("string");
    expect(typeof row.expires_at).toBe("string");
  });

  it("parses tool_ids into an array for clustering", async () => {
    await submit({ tools: [{ id: "bwa_mem" }, { id: "samtools_sort" }] });
    const { body } = await read();
    expect(body.rows[0].tool_ids).toEqual(["bwa_mem", "samtools_sort"]);
  });

  it("exposes install_hash for distinct-install counts but never retract_hash", async () => {
    await submit();
    const { body } = await read();
    expect(body.rows[0].install_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(body.rows[0].retract_hash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("retract_hash");
  });

  it("never exposes an install token", async () => {
    await submit();
    const { body } = await read();
    expect(body.rows[0].installToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("a".repeat(32));
  });

  it("returns rows newest first", async () => {
    for (const kind of ["tool-error", "retry-loop", "other"]) await submit({ kind });
    const { body } = await read();
    expect(body.rows.map((r) => r.kind)).toEqual(["other", "retry-loop", "tool-error"]);
  });

  it("pages with limit and offset", async () => {
    for (const kind of ["tool-error", "retry-loop", "other"]) await submit({ kind });
    const { body } = await read("?limit=1&offset=1");
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].kind).toBe("retry-loop");
  });

  it("caps limit at 500 and floors offset at 0", async () => {
    await submit();
    expect((await read("?limit=99999")).body.rows.length).toBe(1);
    expect((await read("?offset=-5")).body.rows.length).toBe(1);
    expect((await read("?limit=notanumber")).body.rows.length).toBe(1);
  });

  it("does not let a negative limit lift the cap", async () => {
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 501; i++) {
      stmts.push(env.DB.prepare(
        `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`seed-${i}`, now, now, "other", "unknown", "s", "[]", "h", "r", "{}"));
    }
    await env.DB.batch(stmts);
    expect((await read("?limit=-1")).body.rows.length).toBe(1);
    expect((await read("?limit=99999")).body.rows.length).toBe(500);
    expect((await read()).body.rows.length).toBe(100);
  });

  it("filters with since", async () => {
    for (const kind of ["tool-error", "retry-loop", "other"]) await submit({ kind });
    const all = (await read()).body.rows;
    const since = all[1].received_at;
    const after = (await read(`?since=${encodeURIComponent(since)}`)).body.rows;
    expect(after.map((r) => r.kind)).toEqual(["other"]);
    expect((await read(`?since=${encodeURIComponent(all[0].received_at)}`)).body.rows).toEqual([]);
  });

  it("ignores an unparseable since rather than returning nothing", async () => {
    await submit();
    expect((await read("?since=last%20tuesday")).body.rows.length).toBe(1);
  });

  it("tolerates a row whose observation column is not JSON", async () => {
    await env.DB.prepare(
      `INSERT INTO observations (id, received_at, expires_at, kind, stage, signature, tool_ids, install_hash, retract_hash, observation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("broken", "2026-09-30T00:00:00.000Z", "2027-03-29T00:00:00.000Z",
      "other", "unknown", "sig", "{ not json", "h", "r", "{ not json").run();
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.rows[0].id).toBe("broken");
    expect(body.rows[0].signature).toBe("sig");
    expect(body.rows[0].tool_ids).toBe("{ not json");
  });
});
