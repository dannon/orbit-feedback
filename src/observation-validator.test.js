import { describe, it, expect } from "vitest";
import { LEAK_PATTERNS, PUBLIC_GALAXY_SERVERS, validateObservation } from "./observation-validator.js";

// One well-formed observation per contract C1. Every rejection case below is
// this object with a single field replaced, so a failure points at one rule.
const good = () => ({
  schemaVersion: 1,
  id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  clientTs: "2026-09-30T12:00:00.000Z",
  client: { app: "orbit", version: "0.6.1", platform: "darwin" },
  installToken: "a".repeat(32),
  kind: "tool-error",
  stage: "tool-parameterization",
  trigger: "tool_error",
  tools: [
    { id: "toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view", version: "1.20" },
  ],
  mcpTool: "galaxy_run_tool",
  datatypes: ["bam", "fasta"],
  signature: "Tool execution failed: input <path> missing index",
  galaxy: { version: "24.2", server: "usegalaxy.eu" },
  description: "The tool needs a prebuilt index that is not installed on the server.",
});

function errs(patch) {
  const res = validateObservation({ ...good(), ...patch });
  expect(res.ok).toBe(false);
  return res.errors;
}

describe("validateObservation -- accepts", () => {
  it("a well-formed observation", () => {
    expect(validateObservation(good())).toEqual({ ok: true });
  });

  it("every public server name plus the literal 'private'", () => {
    expect(PUBLIC_GALAXY_SERVERS).toEqual([
      "usegalaxy.org", "usegalaxy.eu", "usegalaxy.org.au", "usegalaxy.fr",
      "usegalaxy.no", "usegalaxy.cz", "test.galaxyproject.org",
    ]);
    for (const server of [...PUBLIC_GALAXY_SERVERS, "private"]) {
      expect(validateObservation({ ...good(), galaxy: { server } })).toEqual({ ok: true });
    }
  });

  it("the placeholders normalizeSignature leaves behind", () => {
    const signature = "failed for <id> at <path> from <url> by <email> after <n> tries";
    expect(validateObservation({ ...good(), signature })).toEqual({ ok: true });
  });

  it("the literal 'unknown' signature the client falls back to", () => {
    expect(validateObservation({ ...good(), signature: "unknown" })).toEqual({ ok: true });
  });

  it("an empty description (the auto-mode fallback)", () => {
    expect(validateObservation({ ...good(), description: "" })).toEqual({ ok: true });
  });

  it("an omitted mcpTool, tool version, galaxy version and wsl flag", () => {
    const o = good();
    delete o.mcpTool;
    delete o.galaxy.version;
    o.tools = [{ id: "samtools_view" }];
    expect(validateObservation(o)).toEqual({ ok: true });
  });

  it("an explicit wsl boolean", () => {
    const o = good();
    o.client.wsl = true;
    expect(validateObservation(o)).toEqual({ ok: true });
  });

  it("exactly five tools and five datatypes, and empty arrays", () => {
    const o = good();
    o.tools = Array.from({ length: 5 }, (_, i) => ({ id: `tool_${i}` }));
    o.datatypes = ["a", "b", "c", "d", "e"];
    expect(validateObservation(o)).toEqual({ ok: true });
    expect(validateObservation({ ...good(), tools: [], datatypes: [] })).toEqual({ ok: true });
  });

  it("strings at exactly their caps", () => {
    const o = good();
    o.signature = "s".repeat(200);
    o.description = "z".repeat(500); // not a hex letter, or long-hex fires
    o.mcpTool = "m".repeat(80);
    o.tools = [{ id: "t".repeat(200), version: "v".repeat(40) }];
    o.datatypes = ["x".repeat(40)];
    o.client.version = "c".repeat(40);
    o.galaxy.version = "g".repeat(40);
    expect(validateObservation(o)).toEqual({ ok: true });
  });

  it("'history' and friends when no number follows", () => {
    const description = "The history panel showed the dataset as hidden.";
    expect(validateObservation({ ...good(), description })).toEqual({ ok: true });
  });
});

describe("validateObservation -- rejects", () => {
  const cases = [
    ["an unknown top-level key", { extra: 1 }, "extra:unknown-key"],
    ["an unknown client key", { client: { app: "orbit", version: "1", platform: "linux", nope: 1 } }, "client.nope:unknown-key"],
    ["an unknown tool key", { tools: [{ id: "t", path: "x" }] }, "tools[0].path:unknown-key"],
    ["an unknown galaxy key", { galaxy: { server: "private", host: "x" } }, "galaxy.host:unknown-key"],
    ["the wrong schemaVersion", { schemaVersion: 2 }, "schemaVersion:unsupported"],
    ["a string schemaVersion", { schemaVersion: "1" }, "schemaVersion:unsupported"],
    ["a non-uuid id", { id: "not-a-uuid" }, "id:not-a-uuid-v4"],
    ["a uuid of the wrong version", { id: "3f2b1c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d" }, "id:not-a-uuid-v4"],
    ["an uppercase uuid (the client only emits lowercase)", { id: "3F2B1C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D" }, "id:not-a-uuid-v4"],
    ["an unparseable clientTs", { clientTs: "last tuesday" }, "clientTs:not-iso-8601"],
    ["a clientTs with an offset instead of Z", { clientTs: "2026-09-30T12:00:00+02:00" }, "clientTs:not-iso-8601"],
    ["a missing client block", { client: undefined }, "client:not-an-object"],
    ["an unknown client app", { client: { app: "vscode", version: "1", platform: "linux" } }, "client.app:not-allowed"],
    ["an empty client version", { client: { app: "orbit", version: "", platform: "linux" } }, "client.version:bad-length"],
    ["an unknown platform", { client: { app: "orbit", version: "1", platform: "solaris" } }, "client.platform:not-allowed"],
    ["a non-boolean wsl", { client: { app: "orbit", version: "1", platform: "linux", wsl: "yes" } }, "client.wsl:not-a-boolean"],
    ["an uppercase install token", { installToken: "A".repeat(32) }, "installToken:not-32-hex"],
    ["a short install token", { installToken: "abc" }, "installToken:not-32-hex"],
    ["a missing install token", { installToken: undefined }, "installToken:not-32-hex"],
    ["an unknown kind", { kind: "weird" }, "kind:not-allowed"],
    ["an unknown stage", { stage: "weird" }, "stage:not-allowed"],
    ["an unknown trigger", { trigger: "weird" }, "trigger:not-allowed"],
    ["six tools", { tools: Array.from({ length: 6 }, () => ({ id: "t" })) }, "tools:too-many"],
    ["a non-array tools", { tools: "samtools" }, "tools:not-an-array"],
    ["a non-object tool", { tools: ["samtools"] }, "tools[0]:not-an-object"],
    ["an over-long tool id", { tools: [{ id: "t".repeat(201) }] }, "tools[0].id:bad-length"],
    ["an empty tool id", { tools: [{ id: "" }] }, "tools[0].id:bad-length"],
    ["a non-string tool version", { tools: [{ id: "t", version: 1.2 }] }, "tools[0].version:bad-length"],
    ["six datatypes", { datatypes: ["a", "b", "c", "d", "e", "f"] }, "datatypes:too-many"],
    ["a non-array datatypes", { datatypes: "bam" }, "datatypes:not-an-array"],
    ["an over-long datatype", { datatypes: ["d".repeat(41)] }, "datatypes[0]:bad-length"],
    ["an empty datatype", { datatypes: [""] }, "datatypes[0]:bad-length"],
    ["an over-long mcpTool", { mcpTool: "m".repeat(81) }, "mcpTool:bad-length"],
    ["a server that is neither public nor 'private'", { galaxy: { server: "galaxy.example.org" } }, "galaxy.server:not-allowed"],
    ["a public server with different case", { galaxy: { server: "UseGalaxy.org" } }, "galaxy.server:not-allowed"],
    ["a missing galaxy block", { galaxy: undefined }, "galaxy:not-an-object"],
    ["an over-long galaxy version", { galaxy: { server: "private", version: "9".repeat(41) } }, "galaxy.version:bad-length"],
    ["an over-long signature", { signature: "x".repeat(201) }, "signature:bad-length"],
    ["an empty signature", { signature: "" }, "signature:bad-length"],
    ["a missing signature", { signature: undefined }, "signature:bad-length"],
    ["an over-long description", { description: "x".repeat(501) }, "description:bad-length"],
    ["a missing description", { description: undefined }, "description:bad-length"],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => {
      expect(errs(patch)).toContain(expected);
    });
  }
});

describe("validateObservation -- leak table on description and signature", () => {
  it("is exactly the client's table, in order", () => {
    expect(LEAK_PATTERNS.map(([name, re]) => [name, String(re)])).toEqual([
      ["url", "/https?:\\/\\//i"],
      ["home-path", "/\\/Users\\/|\\/home\\//i"],
      ["windows-path", "/[A-Za-z]:[\\\\/]/"],
      ["tilde-path", "/~[\\\\/]/"],
      ["long-hex", "/[0-9a-fA-F]{16,}/"],
      ["email", "/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/"],
      ["galaxy-id-phrase", "/\\b(?:history|dataset|hid)\\b[^A-Za-z0-9]{0,4}\\d/i"],
      ["non-ascii", "/[^\\x20-\\x7E]/"],
    ]);
  });

  const cases = [
    ["an https url", { description: "see https://usegalaxy.eu/datasets/abc" }, "description:url"],
    ["an http url", { signature: "fetch failed for HTTP://ncbi.example/x" }, "signature:url"],
    ["a macOS home path", { signature: "cannot read /Users/jane/data.bam" }, "signature:home-path"],
    ["a Linux home path", { description: "the file at /home/jane/x was empty" }, "description:home-path"],
    ["a Windows path with a backslash", { description: "the file at C:\\Users\\jane was empty" }, "description:windows-path"],
    ["a Windows path on another drive with a slash", { description: "the file at d:/data was empty" }, "description:windows-path"],
    ["a tilde path", { description: "the file at ~/work/data was empty" }, "description:tilde-path"],
    ["a tilde path with a backslash", { description: "the file at ~\\work was empty" }, "description:tilde-path"],
    ["a long hex id", { signature: "object f2db41e1fa331b3e not found" }, "signature:long-hex"],
    ["an email address", { description: "ask jane.doe@example.org about it" }, "description:email"],
    ["history plus a number", { description: "history 42 was wrong" }, "description:galaxy-id-phrase"],
    ["dataset plus a number", { description: "Dataset #7 is empty" }, "description:galaxy-id-phrase"],
    ["hid plus a number", { description: "hid 3 is missing" }, "description:galaxy-id-phrase"],
    ["hid with a colon then a number", { signature: "hid: 3 is missing" }, "signature:galaxy-id-phrase"],
    ["non-ASCII text", { description: "caf\u00e9 crash" }, "description:non-ascii"],
    ["an embedded newline", { signature: "line one\nline two" }, "signature:non-ascii"],
    ["a tab", { signature: "col one\tcol two" }, "signature:non-ascii"],
    ["a DEL control character", { description: "bell\u007f" }, "description:non-ascii"],
  ];
  for (const [name, patch, expected] of cases) {
    it(`rejects ${name}`, () => {
      expect(errs(patch)).toContain(expected);
    });
  }

  it("reports the non-ascii hit on a free-text field only once", () => {
    const errors = errs({ description: "caf\u00e9" });
    expect(errors.filter((e) => e === "description:non-ascii")).toHaveLength(1);
  });

  it("does not apply the path rules to structured fields like a toolshed id", () => {
    expect(validateObservation({ ...good(), tools: [{ id: "toolshed.g2.bx.psu.edu/repos/a/b/c" }] }))
      .toEqual({ ok: true });
  });
});

describe("validateObservation -- printable ASCII on every string", () => {
  const cases = [
    ["a tool id", { tools: [{ id: "s\u00e4mtools" }] }, "tools[0].id:non-ascii"],
    ["a tool version", { tools: [{ id: "ok", version: "1.0-\u00e9" }] }, "tools[0].version:non-ascii"],
    ["a datatype", { datatypes: ["b\u00e9d"] }, "datatypes[0]:non-ascii"],
    ["mcpTool", { mcpTool: "galaxy_run_t\u00f6ol" }, "mcpTool:non-ascii"],
    ["client.version", { client: { app: "orbit", version: "0.8.0-\u00e9", platform: "linux" } }, "client.version:non-ascii"],
    ["galaxy.version", { galaxy: { server: "private", version: "24\u00002" } }, "galaxy.version:non-ascii"],
    ["the value under an unknown key", { extra: "\u00e9" }, "extra:non-ascii"],
  ];
  for (const [name, patch, expected] of cases) {
    it(`rejects non-ascii in ${name}`, () => {
      expect(errs(patch)).toContain(expected);
    });
  }
});

describe("validateObservation -- error hygiene", () => {
  it("never echoes a submitted value", () => {
    const errors = errs({
      description: "token sk-live-9f3a /Users/jane/secrets",
      signature: "jane.doe@example.org blew up",
      kind: "kind-sk-live",
      galaxy: { server: "galaxy.jane.example.org" },
      tools: [{ id: "x".repeat(300) + "jane" }],
    });
    const rendered = JSON.stringify(errors);
    expect(rendered).not.toContain("sk-live");
    expect(rendered).not.toContain("jane");
    expect(rendered).not.toContain("example.org");
    for (const e of errors) expect(e).toMatch(/^[A-Za-z0-9.[\]]+:[a-z0-9-]+$/);
  });

  it("rejects a non-object body without throwing", () => {
    for (const body of [[], null, "nope", 7, undefined, true]) {
      expect(validateObservation(body)).toEqual({ ok: false, errors: ["observation:not-an-object"] });
    }
  });

  it("treats a JSON __proto__ key as an ordinary unknown key", () => {
    const res = validateObservation(JSON.parse('{"__proto__": {"x": 1}}'));
    expect(res.errors).toContain("__proto__:unknown-key");
  });

  it("reports every broken rule, not just the first", () => {
    const res = validateObservation({ schemaVersion: 9 });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(5);
  });
});
