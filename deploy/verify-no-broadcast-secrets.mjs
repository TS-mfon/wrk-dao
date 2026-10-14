// Fails if Foundry's broadcast or cache artefacts could carry a deployer key into a
// commit.
//
//   node deploy/verify-no-broadcast-secrets.mjs
//
// Success prints exactly one line: NO-BROADCAST-SECRETS OK <n> artefact(s) checked
//
// Why this exists as its own check
// --------------------------------
// `forge script --broadcast --private-key ...` prints, on success:
//
//     Sensitive values saved to: .../cache/Deploy.s.sol/84532/run-latest.json
//
// Foundry says so plainly, and it is easy to read past while celebrating a successful
// deployment. `scripts/verify-no-secrets.mjs` would catch the leak too — it searches
// every committable file for every value in `.env` — but it reports "a secret is
// committable" without saying that a *deployment you just ran* created the file. This
// check names that specific mechanism, so the fix is obvious rather than a hunt.
//
// It is also the reason the repository ignores `contracts/base/cache/` and
// `contracts/base/broadcast/`: the first holds the key, and the second holds the raw
// signed transactions, which are not secret but are machine-local noise.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Directories Foundry writes during a broadcast. */
const ARTEFACT_DIRS = ["contracts/base/cache", "contracts/base/broadcast"];

function loadSecrets() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) {
    console.error("NO-BROADCAST-SECRETS FAILED: .env is missing, so the check cannot know what to look for.");
    process.exit(1);
  }
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // Only key-shaped values: an RPC URL appearing in a broadcast file is expected.
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) continue;
    const names = values.get(value) ?? [];
    names.push(name);
    values.set(value, names);
  }
  if (values.size === 0) {
    console.error("NO-BROADCAST-SECRETS FAILED: .env holds no 32-byte key, so nothing could be checked.");
    process.exit(1);
  }
  return values;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.size < 32 * 1024 * 1024) out.push(full);
  }
  return out;
}

function committable() {
  const out = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return new Set(out.split("\0").filter(Boolean));
}

const secrets = loadSecrets();
const tracked = committable();
const findings = [];
let checked = 0;
let keyBearing = 0;

for (const dir of ARTEFACT_DIRS) {
  const abs = join(ROOT, dir);
  // The directory itself must be invisible to git.
  if (existsSync(abs)) {
    try {
      execFileSync("git", ["-C", ROOT, "check-ignore", "-q", dir], { stdio: "ignore" });
    } catch {
      findings.push(`${dir} is NOT gitignored; a broadcast writes a deployer key under it`);
    }
  }

  for (const file of walk(abs)) {
    checked += 1;
    const rel = relative(ROOT, file).split("\\").join("/");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let holdsKey = false;
    for (const [value, names] of secrets) {
      if (text.includes(value)) {
        holdsKey = true;
        // The value is never printed, only which variable it is.
        if (tracked.has(rel)) {
          findings.push(`${rel} is committable AND contains the value of ${names.join(" / ")}`);
        }
      }
    }
    if (holdsKey) keyBearing += 1;
  }
}

if (findings.length > 0) {
  console.error(`NO-BROADCAST-SECRETS FAILED (${findings.length})`);
  for (const f of findings) console.error(`  - ${f}`);
  console.error("\n  Nothing was pushed. Add the directory to .gitignore and rotate the key if it was ever committed.");
  process.exit(1);
}

// Report the key-bearing count so the risk is visible rather than merely absent: these
// files exist on disk and hold a live deployer key, they are simply unreachable by git.
console.log(
  `NO-BROADCAST-SECRETS OK ${checked} artefact(s) checked, ${keyBearing} hold a key on disk and none are committable`,
);
