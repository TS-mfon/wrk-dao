import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A suite that collects nothing must fail, not pass quietly. verify/tests.mjs
    // additionally asserts that every expected test file actually ran.
    passWithNoTests: false,
    environment: "node",
  },
});
