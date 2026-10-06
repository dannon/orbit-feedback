// Hashing primitives shared by /feedback and /observations.
//
// Both install tokens and client IPs are keyed on OBS_HASH_SECRET plus the
// current UTC month, so a leaked table cannot be joined across month boundaries:
// the same install looks like a different row set in October than in September.

const encoder = new TextEncoder();

export function monthKey(now = new Date()) {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function monthlyHmacHex(value, secret, chars, now = new Date()) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${secret}|${monthKey(now)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(signature).slice(0, chars);
}

export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function addDaysIso(iso, days) {
  return new Date(Date.parse(iso) + days * 86400_000).toISOString();
}
