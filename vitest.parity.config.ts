import { defineConfig } from "vitest/config";

// Dedicated config for the parity export: inline the iris/rose wasm packages so
// Vite (not Node's strict ESM) resolves their extensionless internal imports and
// handles the .wasm assets.
export default defineConfig({
  test: {
    include: ["src/parity-export.test.ts"],
    testTimeout: 120_000,
    server: {
      deps: {
        inline: [/@nockbox/, /@nockchain/],
      },
    },
  },
});
