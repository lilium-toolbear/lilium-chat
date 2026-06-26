import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  resolve: {
    alias: {
      "./pg-client": new URL("./src/profile/pg-client.stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
