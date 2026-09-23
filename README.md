# orbit-feedback

Capture-only feedback ingest for Loom / Orbit. A Cloudflare Worker backed by a
D1 table. It accepts a validated `POST /feedback` payload, stores one row, and
exposes a Basic-auth `GET /admin/feedback` read endpoint. No HTML, no surveys,
no certs -- just capture.

## Wire contract

`POST /feedback` accepts JSON:

```jsonc
{
  "schemaVersion": 1,
  "source": "orbit" | "loom-cli" | "orbit-cli",
  "title": "non-empty string",
  "body": "string",
  "sysinfo": { /* optional diagnostics */ },
  "activityTail": "optional string",
  "shellTail": "optional string",
  "clientTs": "ISO string"
}
```

Responses: `201 {ok,id}` on success; `400` bad JSON; `413` over 256 KB; `422`
invalid payload; `429` rate limited (20/hr per hashed IP); `401` when the
optional `X-Orbit-Feedback-Key` header is required but missing/wrong (only
enforced when the `FEEDBACK_KEY` secret is set).

## First-time setup (Cloudflare)

These steps need a Cloudflare account and run on the operator's machine:

```bash
npm install

# 1. Create the D1 database. Paste the printed database_id into wrangler.toml.
npx wrangler d1 create orbit-feedback

# 2. Apply the schema to the remote D1.
npm run db:remote

# 3. Set the admin password (used by GET /admin/feedback Basic auth).
npx wrangler secret put ADMIN_PASSWORD
# Optional: require a shared header on POSTs.
# npx wrangler secret put FEEDBACK_KEY

# 4. Deploy. Prints the https://orbit-feedback.<subdomain>.workers.dev URL.
npm run deploy
```

Paste the deployed URL into the Loom repo's
`shared/feedback-contract.js` as `FEEDBACK_ENDPOINT_URL` (no trailing slash).

## Local dev

```bash
npm run db:local       # seed the local .wrangler D1
npm run dev            # wrangler dev on :8787

curl -sX POST localhost:8787/feedback -H 'Content-Type: application/json' \
  -d '{"schemaVersion":1,"source":"orbit","title":"hi","body":"hello","clientTs":"2026-06-02T00:00:00Z"}'
```

## Reading feedback

Via the admin endpoint (read-only Basic auth -- the username is ignored, only
the password is checked against `ADMIN_PASSWORD`):

```bash
curl -s "https://orbit-feedback.<subdomain>.workers.dev/admin/feedback?limit=500&offset=0" \
  -u "admin:$ADMIN_PASSWORD"
```

Returns newest-first rows as `{ ok, rows: [...] }`. Each row carries the stored
columns (`id, received_at, source, app_version, title, body, tester_id`) and the
full `payload` JSON string, plus every top-level field from that payload broken
out as its own property (`schemaVersion, clientTs, sysinfo, activityTail,
shellTail, testerId, ...`) so you don't have to parse the blob yourself. On a key
collision the stored column wins; an unparseable `payload` falls back to the raw
columns. `limit` defaults to 50 and is capped at 500; page past that with `offset`.

Or straight from D1:

```bash
npx wrangler d1 execute orbit-feedback --remote \
  --command "SELECT id, received_at, source, title FROM feedback ORDER BY received_at DESC LIMIT 20"
# Full payload for one row:
npx wrangler d1 execute orbit-feedback --remote --command "SELECT * FROM feedback"
```

## Tests

```bash
npm install
npm test          # vitest run
```
