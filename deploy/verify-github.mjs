// Verifies the repository is on GitHub with the working tree fully pushed.
//
//   node deploy/verify-github.mjs
//
// Success prints exactly one line:
//   GITHUB OK <owner>/<repo> <sha> <n> file(s) on remote
//
// Why each check is here
// ----------------------
// "I pushed it" is three separate claims, and the interesting failures are the ones
// where two of them hold:
//
//   1. a remote exists and points at GitHub;
//   2. the remote branch head equals the local head — a push that silently went to a
//      different branch, or a commit made after the push, both break this;
//   3. the working tree is clean — a clean push of a dirty tree means the repository
//      does not contain the work that was verified locally;
//   4. the remote actually holds the files, counted — a repository created with
//      `--source` but never pushed still answers "yes" to (1).
//
// It also refuses to pass while a credential is committable, by running the secret
// scanner itself rather than trusting that it ran earlier. root:G14 is a precondition of
// this gate, not a sibling, and a push is not undoable.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const problems = [];

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 180_000 }).trim();
  } catch (error) {
    if (allowFail) return null;
    problems.push(`git ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`);
    return null;
  }
}

/** GitHub's API is reachable but flaky here; retry before calling it a failure. */
function gh(args, attempts = 3) {
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", timeout: 180_000 }).trim();
    } catch (error) {
      last = (error.stderr || error.message || "").trim();
    }
  }
  problems.push(`gh ${args.join(" ")} failed after ${attempts} attempt(s): ${last}`);
  return null;
}

// ── 0. the blocking precondition ────────────────────────────────────────────

try {
  const output = execFileSync("node", ["scripts/verify-no-secrets.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (!/NO-SECRETS OK/.test(output)) {
    problems.push(`the secret scanner did not report success:\n${output.trim()}`);
  }
} catch (error) {
  problems.push(
    `the secret scanner failed, so this gate cannot pass:\n${(error.stdout || "") + (error.stderr || error.message)}`,
  );
}

// ── 1. a GitHub remote ──────────────────────────────────────────────────────

const remoteUrl = git(["remote", "get-url", "origin"], { allowFail: true });
if (!remoteUrl) {
  problems.push("no `origin` remote is configured");
} else if (!/github\.com/.test(remoteUrl)) {
  problems.push(`origin is not a GitHub remote: ${remoteUrl}`);
}

const slug = remoteUrl
  ? (/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl) || []).slice(1, 3).join("/")
  : "";
if (remoteUrl && !slug) problems.push(`could not read owner/repo out of ${remoteUrl}`);

// ── 2. the pushed head equals the local head ────────────────────────────────

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const localHead = git(["rev-parse", "HEAD"]);

let remoteHead = null;
if (branch && branch !== "HEAD") {
  for (let attempt = 1; attempt <= 3 && !remoteHead; attempt += 1) {
    const line = git(["ls-remote", "origin", `refs/heads/${branch}`], { allowFail: true });
    if (line) remoteHead = line.split(/\s+/)[0];
  }
  if (!remoteHead) {
    problems.push(`origin has no branch ${branch}, so nothing was pushed to it`);
  } else if (remoteHead !== localHead) {
    problems.push(
      `remote ${branch} is at ${remoteHead} but local HEAD is ${localHead} — the push is not current`,
    );
  }
} else {
  problems.push("HEAD is detached, so there is no branch to compare against the remote");
}

// ── 3. a clean tree ─────────────────────────────────────────────────────────
// A clean push of a dirty tree is the failure this catches: the remote would not hold
// the work that the local gates were run against.

const dirty = git(["status", "--porcelain"], { allowFail: true });
if (dirty) {
  const lines = dirty.split("\n").filter(Boolean);
  problems.push(
    `the working tree has ${lines.length} uncommitted change(s), so the remote does not hold what was verified:\n` +
      lines.slice(0, 10).map((line) => `      ${line}`).join("\n") +
      (lines.length > 10 ? `\n      … and ${lines.length - 10} more` : ""),
  );
}

// ── 4. the remote really holds the files ────────────────────────────────────

let remoteFiles = null;
if (slug && branch && branch !== "HEAD") {
  const counted = gh([
    "api",
    `repos/${slug}/git/trees/${branch}?recursive=1`,
    "--jq",
    '.tree | map(select(.type=="blob")) | length',
  ]);
  if (counted !== null) {
    remoteFiles = Number(counted);
    const localFiles = (git(["ls-files"], { allowFail: true }) || "").split("\n").filter(Boolean).length;
    if (!Number.isFinite(remoteFiles) || remoteFiles === 0) {
      problems.push(`the remote tree is empty — the repository exists but holds no files`);
    } else if (remoteFiles !== localFiles) {
      problems.push(
        `the remote holds ${remoteFiles} file(s) but ${localFiles} are tracked locally`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`GITHUB FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`GITHUB OK ${slug} ${localHead} ${remoteFiles} file(s) on remote`);
