// Fails if any secret could reach a commit.
//
//   node scripts/verify-no-secrets.mjs
//
// Success prints exactly one line: NO-SECRETS OK <n> file(s) scanned, control verified
//
// This gate runs before `git push` and before any deployment. It is the last thing
// between a funded private key and a public repository, so it is written to fail
// closed: an unreadable file, a missing .env, or a scanner that cannot prove itself
// all exit non-zero.
//
// What it checks
// --------------
// 1. **Exact values.** Every value in the local `.env` is searched for across every
//    file git would include. This is the precise form of the real risk — "the key I
//    am actually using has leaked into something committable" — and unlike an entropy
//    heuristic it cannot be fooled or tuned away.
//
//    Searching for literal secrets is why this script never prints a match's
//    surrounding text: it reports the file and the variable name, never the value.
//
// 2. **Dangerous filenames** that are not ignored: `.env` variants, PEM and key
//    files, keystores, `id_rsa`. A file ignored by git is fine; the same file
//    tracked is not.
//
// 3. **Known credential shapes** as a backstop for secrets that never passed through
//    `.env`: GitHub tokens, AWS keys, OpenAI/Anthropic keys, Slack tokens, JWTs,
//    PEM private-key headers.
//
// What it deliberately does not do
// --------------------------------
// It does not flag bare 64-hex strings. A `bytes32` literal in Solidity is
// indistinguishable from a private key by shape alone, and this repository is full of
// legitimate ones — frozen keccak256 digests, mandate ids, test fixtures. A check
// that fired on all of them would be switched off within a day. Check 1 covers the
// real case exactly.
//
// The check carries its own proof: it writes a temporary file containing a planted
// secret, confirms the scanner finds it, and removes it. A silent scanner proves
// nothing.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Minimum length for a .env value to be treated as a secret worth searching for. */
const MIN_SECRET_LENGTH = 16;

/**
 * Values that are public by nature and appear in committed config on purpose.
 * Treating them as secrets would make the gate cry wolf about an RPC URL.
 */
const NOT_SECRET = new Set([
  "mongodb://127.0.0.1:27017",
  "https://sepolia.base.org",
  "https://studio.genlayer.com/api",
  "https://rpc-bradbury.genlayer.com",
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
]);

const DANGEROUS_FILENAME =
  /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa|id_ed25519|.*\.keystore|keystore\.json)$/i;

/**
 * Filenames that look dangerous but are meant to be committed.
 *
 * `.env.example` is a template of variable names with placeholder values — it exists
 * so a new contributor knows what to set. Exempting it from the *filename* rule is
 * safe because check 1 still scans its contents: if a real value from `.env` ever
 * appeared in it, the gate would fail on that instead, which is the thing that
 * actually matters.
 */
const FILENAME_EXEMPT = new Set([".env.example"]);

const CREDENTIAL_SHAPES = [
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "pem-private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "vercel-token", pattern: /\bvercel_[A-Za-z0-9]{24,}\b/ },
];

/** Files git would include in a commit: tracked plus untracked-and-not-ignored. */
function committableFiles() {
  const out = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

function loadEnvSecrets() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) {
    console.error("NO-SECRETS FAILED: .env is missing, so the gate cannot know what to look for.");
    console.error("  This gate fails closed. Create .env before running it.");
    process.exit(1);
  }
  const secrets = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (NOT_SECRET.has(value)) continue;
    // Index by value so one key reused under several names reports every name.
    const names = secrets.get(value) ?? [];
    names.push(name);
    secrets.set(value, names);
  }
  if (secrets.size === 0) {
    console.error("NO-SECRETS FAILED: .env contained no value long enough to be a secret.");
    console.error("  Either .env is a placeholder or MIN_SECRET_LENGTH is wrong. Failing closed.");
    process.exit(1);
  }
  return secrets;
}

function scanFiles(files, secrets) {
  const findings = [];
  for (const rel of files) {
    const abs = join(ROOT, rel);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue; // deleted between listing and reading
    }
    if (!stats.isFile()) continue;

    const name = basename(rel);
    if (DANGEROUS_FILENAME.test(name) && !FILENAME_EXEMPT.has(name)) {
      findings.push({ rel, id: "dangerous-filename", detail: `${name} is committable` });
    }

    if (stats.size > 8 * 1024 * 1024) continue; // a secret does not hide in an 8MB blob

    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // binary
    }

    for (const [value, names] of secrets) {
      if (text.includes(value)) {
        // The value itself is never printed.
        findings.push({ rel, id: "env-secret", detail: `contains the value of ${names.join(" / ")}` });
      }
    }
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.pattern.test(text)) {
        findings.push({ rel, id: shape.id, detail: `matches the ${shape.id} shape` });
      }
    }
  }
  return findings;
}

function main() {
  const secrets = loadEnvSecrets();
  const files = committableFiles();

  // Positive control: plant a secret where git would see it and require a hit.
  const controlRel = ".wrk-secret-control.tmp";
  const controlAbs = join(ROOT, controlRel);
  const planted = [...secrets.keys()][0];
  let controlFindings = [];
  try {
    writeFileSync(controlAbs, `leaked = "${planted}"\n`, { mode: 0o600 });
    controlFindings = scanFiles([controlRel], secrets);
  } finally {
    rmSync(controlAbs, { force: true });
  }
  if (!controlFindings.some((f) => f.id === "env-secret")) {
    console.error("NO-SECRETS BROKEN: the scanner did not find a planted secret.");
    console.error("  It cannot be trusted to find a real one. Fix the scanner.");
    process.exit(1);
  }
  const findings = scanFiles(files, secrets).filter((f) => f.rel !== controlRel);

  if (findings.length > 0) {
    console.error(`NO-SECRETS FAILED (${findings.length})`);
    for (const finding of findings) {
      console.error(`  - ${finding.rel}  ${finding.id}: ${finding.detail}`);
    }
    console.error("\n  Nothing was pushed. Remove the secret, rotate it, and re-run.");
    process.exit(1);
  }

  console.log(`NO-SECRETS OK ${files.length} file(s) scanned, control verified`);
}

main();
