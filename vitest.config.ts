import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,js}"],
    coverage: {
      reporter: ["text", "json-summary"]
    },
    restoreMocks: true,
    testTimeout: 10_000
  }
});
