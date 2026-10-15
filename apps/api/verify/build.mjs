import { existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const required = ["dist/app.js", "dist/server.js", "dist/auth.js", "dist/chain.js", "dist/readmodel.js", "dist/writes.js", "dist/networks.js", "dist/problem.js"];
const missing = required.filter((p) => !existsSync(resolve(ROOT, p)));
if (missing.length) { console.error(`API-BUILD FAILED: missing ${missing.join(", ")}`); process.exit(1); }
console.log(`API-BUILD OK ${required.length} artefact(s)`);
