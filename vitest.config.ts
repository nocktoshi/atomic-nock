import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    server: {
      deps: {
        // iris-sdk / rose-wasm use extensionless internal imports and .wasm assets.
        inline: [/@nockbox/, /@nockchain/],
      },
    },
  },
});