// Strict mirror of validateObservation in loom's shared/observation-contract.js
// (contract C1). The client runs the same rules before it sends; this copy exists
// because the queue must not trust the client to have run them. The regexes, the
// caps and the `<field>:<rule>` error strings are deliberately identical to the
// client's so a rejection can be diffed across the two -- if you change one here,
// change it there in the same change.
//
// This is a security control, not a courtesy: the whole promise of the intake
// queue is that nothing identifying leaves the contributor's machine. Error
// strings name a field and a rule, never a submitted value.

// Contract C7. Single source is PUBLIC_GALAXY_SERVERS in loom's
// shared/observation-contract.js; this is a verbatim copy.
export const PUBLIC_GALAXY_SERVERS = Object.freeze([
  "usegalaxy.org",
  "usegalaxy.eu",
  "usegalaxy.org.au",
  "usegalaxy.fr",
  "usegalaxy.no",
  "usegalaxy.cz",
  "test.galaxyproject.org",
]);
const PRIVATE_SERVER = "private";

const OBSERVATION_SCHEMA_VERSION = 1;
const OBSERVATION_APPS = ["orbit", "loom-cli"];
const OBSERVATION_PLATFORMS = ["darwin", "linux", "win32"];
const OBSERVATION_KINDS = [
  "tool-error",
  "retry-loop",
  "assertion-failed",
  "user-correction",
  "silent-wrong-result",
  "other",
];
const OBSERVATION_STAGES = [
  "data-acquisition",
  "metadata-reconciliation",
  "tool-parameterization",
  "job-execution",
  "result-interpretation",
  "unknown",
];
const OBSERVATION_TRIGGERS = ["tool_error", "retry_loop", "assertion", "user_correction", "explicit"];

const SIGNATURE_MAX = 200;
const DESCRIPTION_MAX = 500;
const TOOLS_MAX = 5;
const TOOL_ID_MAX = 200;
const TOOL_VERSION_MAX = 40;
const MCP_TOOL_MAX = 80;
const DATATYPES_MAX = 5;
const DATATYPE_MAX = 40;
const VERSION_MAX = 40;

// The leak table, byte for byte. No `g` flags: `test()` on a global regex is
// stateful and would skip every other call.
export const LEAK_PATTERNS = Object.freeze([
  Object.freeze(["url", /https?:\/\//i]),
  Object.freeze(["home-path", /\/Users\/|\/home\//i]),
  Object.freeze(["windows-path", /[A-Za-z]:[\\/]/]),
  Object.freeze(["tilde-path", /~[\\/]/]),
  Object.freeze(["long-hex", /[0-9a-fA-F]{16,}/]),
  Object.freeze(["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/]),
  // Crude but cheap, per C1: a Galaxy id phrase followed by a number.
  Object.freeze(["galaxy-id-phrase", /\b(?:history|dataset|hid)\b[^A-Za-z0-9]{0,4}\d/i]),
  Object.freeze(["non-ascii", /[^\x20-\x7E]/]),
]);

const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "clientTs",
  "client",
  "installToken",
  "kind",
  "stage",
  "trigger",
  "tools",
  "mcpTool",
  "datatypes",
  "signature",
  "galaxy",
  "description",
]);
const CLIENT_KEYS = new Set(["app", "version", "platform", "wsl"]);
const GALAXY_KEYS = new Set(["version", "server"]);
const TOOL_KEYS = new Set(["id", "version"]);

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INSTALL_TOKEN_RE = /^[0-9a-f]{32}$/;
const NON_ASCII_RE = /[^\x20-\x7E]/;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pushUnknownKeys(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${prefix ? prefix + "." : ""}${k}:unknown-key`);
  }
}

function badString(v, max, { allowEmpty = false } = {}) {
  if (typeof v !== "string") return true;
  if (!allowEmpty && v.length === 0) return true;
  return v.length > max;
}

// Every string in `value`, at any depth, that matches `re`, as `path:name`.
// installToken is skipped: it is 32 hex by construction and already checked.
function scanStrings(value, re, name, path = "", hits = []) {
  if (typeof value === "string") {
    if (path !== "installToken" && re.test(value)) hits.push(`${path}:${name}`);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, re, name, `${path}[${i}]`, hits));
    return hits;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      scanStrings(v, re, name, path ? `${path}.${k}` : k, hits);
    }
  }
  return hits;
}

export function validateObservation(obj) {
  if (!isPlainObject(obj)) return { ok: false, errors: ["observation:not-an-object"] };
  const o = obj;
  const errors = [];

  pushUnknownKeys(o, TOP_KEYS, "", errors);
  if (o.schemaVersion !== OBSERVATION_SCHEMA_VERSION) errors.push("schemaVersion:unsupported");
  if (typeof o.id !== "string" || !UUID_V4_RE.test(o.id)) errors.push("id:not-a-uuid-v4");
  if (typeof o.clientTs !== "string" || !ISO_TS_RE.test(o.clientTs)) {
    errors.push("clientTs:not-iso-8601");
  }

  if (!isPlainObject(o.client)) {
    errors.push("client:not-an-object");
  } else {
    const c = o.client;
    pushUnknownKeys(c, CLIENT_KEYS, "client", errors);
    if (!OBSERVATION_APPS.includes(c.app)) errors.push("client.app:not-allowed");
    if (badString(c.version, VERSION_MAX)) errors.push("client.version:bad-length");
    if (!OBSERVATION_PLATFORMS.includes(c.platform)) errors.push("client.platform:not-allowed");
    if (c.wsl !== undefined && typeof c.wsl !== "boolean") errors.push("client.wsl:not-a-boolean");
  }

  if (typeof o.installToken !== "string" || !INSTALL_TOKEN_RE.test(o.installToken)) {
    errors.push("installToken:not-32-hex");
  }
  if (!OBSERVATION_KINDS.includes(o.kind)) errors.push("kind:not-allowed");
  if (!OBSERVATION_STAGES.includes(o.stage)) errors.push("stage:not-allowed");
  if (!OBSERVATION_TRIGGERS.includes(o.trigger)) errors.push("trigger:not-allowed");

  if (!Array.isArray(o.tools)) {
    errors.push("tools:not-an-array");
  } else if (o.tools.length > TOOLS_MAX) {
    errors.push("tools:too-many");
  } else {
    o.tools.forEach((t, i) => {
      if (!isPlainObject(t)) {
        errors.push(`tools[${i}]:not-an-object`);
        return;
      }
      pushUnknownKeys(t, TOOL_KEYS, `tools[${i}]`, errors);
      if (badString(t.id, TOOL_ID_MAX)) errors.push(`tools[${i}].id:bad-length`);
      if (t.version !== undefined && badString(t.version, TOOL_VERSION_MAX)) {
        errors.push(`tools[${i}].version:bad-length`);
      }
    });
  }

  if (o.mcpTool !== undefined && badString(o.mcpTool, MCP_TOOL_MAX)) {
    errors.push("mcpTool:bad-length");
  }

  if (!Array.isArray(o.datatypes)) {
    errors.push("datatypes:not-an-array");
  } else if (o.datatypes.length > DATATYPES_MAX) {
    errors.push("datatypes:too-many");
  } else {
    o.datatypes.forEach((d, i) => {
      if (badString(d, DATATYPE_MAX)) errors.push(`datatypes[${i}]:bad-length`);
    });
  }

  // Half the server's cluster key (kind, signature), so it is never empty.
  if (badString(o.signature, SIGNATURE_MAX)) errors.push("signature:bad-length");
  // Empty is allowed: auto mode sends one when its bounded model call produced
  // text the client validator refused.
  if (badString(o.description, DESCRIPTION_MAX, { allowEmpty: true })) {
    errors.push("description:bad-length");
  }

  if (!isPlainObject(o.galaxy)) {
    errors.push("galaxy:not-an-object");
  } else {
    const g = o.galaxy;
    pushUnknownKeys(g, GALAXY_KEYS, "galaxy", errors);
    const serverOk =
      typeof g.server === "string" &&
      (PUBLIC_GALAXY_SERVERS.includes(g.server) || g.server === PRIVATE_SERVER);
    if (!serverOk) errors.push("galaxy.server:not-allowed");
    if (g.version !== undefined && badString(g.version, VERSION_MAX)) {
      errors.push("galaxy.version:bad-length");
    }
  }

  // The two free-text fields carry the leak risk, so they get the full table.
  for (const field of ["signature", "description"]) {
    const value = o[field];
    if (typeof value !== "string") continue;
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(value)) errors.push(`${field}:${name}`);
    }
  }

  // C1: EVERY string is printable ASCII, not just the free-text pair. Only the
  // ASCII rule applies here -- the rest of the table would read a toolshed tool
  // id as a path. Unknown keys are walked too, so their values are checked even
  // though the payload is already refused.
  for (const hit of scanStrings(o, NON_ASCII_RE, "non-ascii")) {
    if (!errors.includes(hit)) errors.push(hit);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
