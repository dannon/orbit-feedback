import { describe, it, expect } from "vitest";
import { addDaysIso, monthKey, monthlyHmacHex, randomHex, sha256Hex } from "./hash.js";

describe("monthKey", () => {
  it("is the UTC year and month, zero-padded", () => {
    expect(monthKey(new Date("2026-09-30T23:30:00Z"))).toBe("2026-09");
    expect(monthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(monthKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("uses UTC, not local time", () => {
    // 2026-10-01T00:30Z is still September in any negative-offset zone.
    expect(monthKey(new Date("2026-10-01T00:30:00Z"))).toBe("2026-10");
  });
});

describe("monthlyHmacHex", () => {
  it("is stable within a month and rotates across months", async () => {
    const early = await monthlyHmacHex("tok", "s", 32, new Date("2026-09-01T00:00:00Z"));
    const late = await monthlyHmacHex("tok", "s", 32, new Date("2026-09-30T23:59:59Z"));
    const next = await monthlyHmacHex("tok", "s", 32, new Date("2026-10-01T00:00:00Z"));
    expect(early).toBe(late);
    expect(early).not.toBe(next);
  });

  it("returns exactly the requested number of lowercase hex chars", async () => {
    const when = new Date("2026-09-15T00:00:00Z");
    expect(await monthlyHmacHex("tok", "s", 32, when)).toMatch(/^[0-9a-f]{32}$/);
    expect(await monthlyHmacHex("tok", "s", 16, when)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("depends on the secret", async () => {
    const when = new Date("2026-09-15T00:00:00Z");
    const a = await monthlyHmacHex("tok", "secret-one", 32, when);
    const b = await monthlyHmacHex("tok", "secret-two", 32, when);
    expect(a).not.toBe(b);
  });

  it("depends on the value", async () => {
    const when = new Date("2026-09-15T00:00:00Z");
    const a = await monthlyHmacHex("tok-a", "s", 32, when);
    const b = await monthlyHmacHex("tok-b", "s", 32, when);
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("is 64 lowercase hex chars and deterministic", async () => {
    const a = await sha256Hex("hello");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("hello")).toBe(a);
    expect(await sha256Hex("hellp")).not.toBe(a);
  });
});

describe("randomHex", () => {
  it("returns two hex chars per byte and differs between calls", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("addDaysIso", () => {
  it("adds whole days and keeps the time of day", () => {
    expect(addDaysIso("2026-09-30T12:00:00.000Z", 180)).toBe("2027-03-29T12:00:00.000Z");
    expect(addDaysIso("2026-09-30T12:00:00.000Z", 1)).toBe("2026-10-01T12:00:00.000Z");
  });
});
