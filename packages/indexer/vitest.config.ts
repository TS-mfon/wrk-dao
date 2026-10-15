import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The read-model suites talk to a real mongod. Serial, because several of them
    // assert on whole-collection digests and a parallel writer would make those
    // digests depend on scheduling rather than on the indexer.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
