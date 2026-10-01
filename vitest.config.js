import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // An in-memory D1 per vitest run. Storage is NOT isolated per test in this
      // pool version, so every real-D1 test file resets tables in beforeEach.
      miniflare: { d1Databases: { DB: ":memory:" } },
    }),
  ],
});
