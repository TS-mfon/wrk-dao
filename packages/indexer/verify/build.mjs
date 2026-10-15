// Emits the build gate's token only when dist really holds the compiled surface.
//
// `tsc -b` exiting zero is necessary and not sufficient: an incremental build with a
// stale .tsbuildinfo can exit zero having emitted nothing. So this checks the artefacts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli.js",
  "dist/store.js",
  "dist/events.js",
  "dist/schemas.js",
  "dist/indexer.js",
  "dist/rebuild.js",
  "dist/reorg.js",
  "dist/checkpoint.js",
  "dist/digest.js",
  "dist/collections.js",
  "dist/config.js",
  "dist/sources/source.js",
  "dist/sources/replay.js",
  "dist/sources/base.js",
  "dist/sources/genlayer.js",
];

const missing = required.filter((path) => !existsSync(resolve(ROOT, path)));
if (missing.length > 0) {
  console.error(`INDEXER-BUILD FAILED: ${missing.length} artefact(s) missing`);
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

// The built entry point must actually re-export the surface, not just exist.
const entry = readFileSync(resolve(ROOT, "dist/index.js"), "utf8");
for (const name of ["Store", "project", "indexOnce", "rebuildAndCompare", "ReplaySource"]) {
  if (!entry.includes(name)) {
    console.error(`INDEXER-BUILD FAILED: dist/index.js does not re-export ${name}`);
    process.exit(1);
  }
}

console.log(`INDEXER-BUILD OK ${required.length} artefact(s)`);
