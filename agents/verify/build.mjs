import { existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const required = ["dist/index.js", "dist/transcript.js", "dist/commissioner/agent.js", "dist/worker/agent.js"];
const missing = required.filter((p) => !existsSync(resolve(ROOT, p)));
if (missing.length) { console.error(`AGENTS-BUILD FAILED: missing ${missing.join(", ")}`); process.exit(1); }
console.log(`AGENTS-BUILD OK ${required.length} artefact(s)`);
