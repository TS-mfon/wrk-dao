import { existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const required = ["dist/index.js", "dist/index.d.ts", "dist/client.js", "dist/ids.js", "dist/signer.js", "dist/payloads.js"];
const missing = required.filter((p) => !existsSync(resolve(ROOT, p)));
if (missing.length) { console.error(`SDK-BUILD FAILED: missing ${missing.join(", ")}`); process.exit(1); }
console.log(`SDK-BUILD OK ${required.length} artefact(s)`);
