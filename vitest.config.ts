import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // cada arquivo sobe o próprio PGlite em memória
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
