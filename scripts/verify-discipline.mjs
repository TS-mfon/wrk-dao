// Two absence assertions that the build's honesty depends on, each proven
// against a known-positive control before its result is trusted.
//
//   node scripts/verify-discipline.mjs cleanroom
//   node scripts/verify-discipline.mjs scope
//
// An absence check that has never fired is indistinguishable from a broken one,
// so both modes first run the same scanner over a synthetic file that MUST trip
// it. If the control does not trip, the run fails even when the repository is
// clean -- a silent scanner is worse than no scanner.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "out", "cache", "coverage",
  "__pycache__", ".pytest_cache", ".venv", "broadcast", "artifacts", "lib",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".sol", ".json",
  ".md", ".yml", ".yaml", ".toml", ".sh", ".env", ".txt", "",
]);

/**
 * Clean-room rule. The project owner instructed twice that this build must not
 * read from or depend on their other local repositories. A stray import or path
 * reference would make the deliverable unbuildable anywhere else and would
 * violate a direct instruction, so it is a gate rather than a convention.
 */
const CLEANROOM_PATTERNS = [
  { re: /workify-protocol/i, why: "reference to the owner's workify-protocol repo" },
  { re: /mandate-court/i, why: "reference to the owner's mandate-court repo" },
  { re: /treasury-copilot/i, why: "reference to the owner's treasury-copilot repo" },
  { re: /\/home\/sudodave\/(?!wrk-dao|\.claude|\.agents)[A-Za-z0-9._-]+/, why: "absolute path into another project under the owner's home" },
  { re: /\.\.\/\.\.\/\.\.\/(?:workify|mandate|treasury|marketplace)/i, why: "relative traversal into a sibling project" },
];

/**
 * SPEC §113 "Do not initially build". These are not merely out of scope -- the
 * spec's argument is that they are unnecessary to prove the core protocol and
 * that building them dilutes it. Scope creep here is a silent failure: the build
 * still passes, it just stops being the thing that was specified.
 */
const SCOPE_PATTERNS = [
  { re: /\bERC721\b|\bIERC721\b/, why: "NFT membership (§113 do-not-build)" },
  { re: /\bgovernanceToken\b|\bGovernanceToken\b|\bgovernance_token\b/, why: "token governance (§113 do-not-build)" },
  { re: /\bdaoToken\b|\bDAOToken\b|\bdao_token\b/, why: "DAO token (§113 do-not-build)" },
  { re: /\bcastVote\b|\bcast_vote\b|\bhumanVote\b|\bhuman_vote\b/, why: "human voting (§113 do-not-build)" },
  { re: /\bChatMessage\b|\bchat_message\b|\bsendChat\b/, why: "chat (§113 do-not-build)" },
  { re: /\bstakingRewards\b|\bstaking_rewards\b|\bbondingCurve\b|\bbonding_curve\b/, why: "speculative financial mechanism (§113 do-not-build)" },
];

/** Files exempt from scanning: they legitimately quote the forbidden terms. */
const EXEMPT = new Set([
  "docs/SPEC.md",              // the spec names the do-not-build list verbatim
  "scripts/verify-discipline.mjs", // this file holds the patterns
  ".unlazy/wrk/PLAN.md",       // the plan names the clean-room rule
  "docs/ARCHITECTURE.md",      // documents the deviations by name
]);

/**
 * Directory prefixes exempt from the scan.
 *
 * `.unlazy/wrk/gates/` holds the gate ledgers. Every leaf brief in them must name
 * the prohibited repositories verbatim -- an unambiguous "do not read
 * ~/workify-protocol" is the instruction itself, so the ledgers cannot be written
 * without the names the cleanroom pattern looks for.
 *
 * This is not a hole in the check. Nothing under `.unlazy/` is compiled, imported,
 * or shipped; it is driver-authored instruction text. The one way a ledger could
 * act is through a `CHECK:` command, and those are already gated by the unlazy
 * checker's approval boundary, which prints every command, its resolved shell, cwd
 * and PATH, and refuses to execute it until it has been read and approved. The
 * scan still covers every file that becomes code.
 */
const EXEMPT_PREFIXES = [".unlazy/wrk/gates/"];

function isExempt(rel) {
  if (EXEMPT.has(rel)) return true;
  return EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function scanText(text, patterns) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { re, why } of patterns) {
      if (re.test(lines[i])) hits.push({ line: i + 1, why, text: lines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}

function scanRepo(patterns) {
  const findings = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (isExempt(rel)) continue;
    if (!TEXT_EXT.has(extname(file))) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable; not a text finding
    }
    for (const hit of scanText(text, patterns)) findings.push({ file: rel, ...hit });
  }
  return findings;
}

const MODES = {
  cleanroom: {
    patterns: CLEANROOM_PATTERNS,
    token: "CLEANROOM OK",
    control: [
      'import { thing } from "/home/sudodave/workify-protocol/src/thing";',
      'const p = "../../../mandate-court/apps/web";',
    ].join("\n"),
    failed: "CLEANROOM FAILED",
    blurb: "the build references another project on this machine",
  },
  scope: {
    patterns: SCOPE_PATTERNS,
    token: "SCOPE-DISCIPLINE OK",
    control: [
      "contract Membership is ERC721 {}",
      "const governanceToken = deploy();",
      "function castVote(uint256 id) external {}",
    ].join("\n"),
    failed: "SCOPE-DISCIPLINE FAILED",
    blurb: "the build contains a §113 do-not-build feature",
  },
};

const mode = MODES[process.argv[2]];
if (!mode) {
  console.error(`usage: node scripts/verify-discipline.mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

// Positive control first. A scanner that cannot fire proves nothing by staying
// quiet, so its own correctness is established before its silence is believed.
const controlHits = scanText(mode.control, mode.patterns);
if (controlHits.length < 2) {
  console.error(
    `${mode.failed}: positive control tripped only ${controlHits.length} pattern(s); ` +
      `the scanner is broken, so a clean result would be meaningless.`,
  );
  process.exit(1);
}

const findings = scanRepo(mode.patterns);
if (findings.length > 0) {
  console.error(`${mode.failed} (${findings.length}): ${mode.blurb}`);
  for (const f of findings.slice(0, 30)) {
    console.error(`  - ${f.file}:${f.line}  ${f.why}\n      ${f.text}`);
  }
  if (findings.length > 30) console.error(`  ... and ${findings.length - 30} more`);
  process.exit(1);
}

let scanned = 0;
for (const file of walk(ROOT)) if (TEXT_EXT.has(extname(file))) scanned++;
console.log(`${mode.token} ${scanned} files scanned, control verified (${controlHits.length} patterns)`);
