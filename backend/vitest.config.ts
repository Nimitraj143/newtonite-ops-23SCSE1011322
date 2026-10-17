import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    env: {
      DATABASE_URL: "postgres://ops:ops@localhost:5432/ops_test",
      JWT_SECRET: "test-secret",
    },
    fileParallelism: false, // test files share one database, so run them one after another
    testTimeout: 20000,
  },
});