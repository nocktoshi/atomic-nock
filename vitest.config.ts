import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    server: {
      deps: {
        // @nockchain/rose-ts is pure TS; inline for vitest module resolution.
        inline: [/@nockchain/],
      },
    },
  },
});