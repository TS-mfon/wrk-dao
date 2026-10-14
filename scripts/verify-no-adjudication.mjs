// Asserts that a custody contract contains no adjudication surface.
//
//   node scripts/verify-no-adjudication.mjs contracts/base/src/WRKEscrow.sol
//
// Success prints exactly one line: NO-ADJUDICATION OK <n> file(s)
//
// Why this exists
// ---------------
// docs/ARCHITECTURE.md §1 separates four authorities, and the failure mode it guards
// against is one component acquiring two. An escrow that can decide *whether* work
// was good has taken judgment authority from GenLayer; an escrow with an admin key
// can redirect a payout without any decision at all. Both are catastrophic, both are
// easy to add by accident while fixing something else, and neither shows up as a
// failing test — the suite keeps passing, the contract simply means something
// different.
//
// So this is a structural check, not a behavioural one: it reads the source and
// refuses the shapes that would grant the second authority.
//
// Three families are refused:
//
//   1. Judgment vocabulary — a function or state variable named for deciding
//      quality (verdict, score, adjudicate, approveWork, rating, …). The escrow
//      receives basis points that attestors co-signed; it never forms an opinion.
//   2. Privileged roles — owner/admin/governance/pause surfaces. The escrow is
//      deliberately roleless: `usdc`, `verifier` and the window are immutable or
//      constant, and an "upgrade" is a fresh deployment. A pause is an admin key
//      that can freeze a worker's money, which is why there isn't one.
//   3. Unbounded value movement — a transfer helper reachable by an arbitrary
//      caller with an arbitrary recipient (sweep, rescue, withdrawTo, …). That is
//      the drain, written politely.
//
// The check carries its own proof. Before trusting a clean result it runs the same
// scanner over a fixture that deliberately contains every forbidden shape and fails
// if the scanner stays quiet. An absence assertion that has never fired tells you
// nothing by staying silent.

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Patterns are matched against *code*, after comments and string literals are
 * stripped. The contracts' own documentation discusses adjudication at length,
 * because explaining the boundary is part of documenting it — a scanner that read
 * comments would have to be loosened until it stopped catching anything.
 */
const FORBIDDEN = [
  {
    id: "judgment-vocabulary",
    pattern:
      /\b(?:set|update|override|record|submit|cast)(?:Verdict|Score|Rating|Outcome|Judgment|Decision)\b|\badjudicate\w*\b|\bapproveWork\b|\brejectWork\b|\bscoreWorker\b|\bgradeDeliverable\b/i,
    why: "names a judgment operation; judgment belongs to GenLayer (docs/ARCHITECTURE.md §1)",
  },
  {
    id: "judgment-state",
    pattern: /^\s*(?:uint\d*|int\d*|bool|bytes\d*|string|address|mapping)[^;=]*\b(?:verdict|score|rating|grade|quality)\b/im,
    why: "stores a judgment; the escrow stores co-signed basis points, not opinions",
  },
  {
    id: "privileged-role",
    pattern:
      /\b(?:Ownable2?Step?|AccessControl(?:Enumerable|Defaultable)?|Ownable)\b|\bonlyOwner\b|\bonlyAdmin\b|\bonlyGovernance\b|\b_checkOwner\b|\btransferOwnership\b|\brenounceOwnership\b|\bgrantRole\b|\b_grantRole\b|\bDEFAULT_ADMIN_ROLE\b/,
    why: "introduces a privileged role; the escrow is deliberately roleless",
  },
  {
    id: "pause-surface",
    pattern: /\bPausable\b|\bwhenNotPaused\b|\b_pause\b|\bfunction\s+pause\b|\bfunction\s+unpause\b/,
    why: "a pause is an admin key that can freeze a worker's money",
  },
  {
    id: "upgrade-surface",
    pattern:
      /\b(?:UUPSUpgradeable|Initializable|ERC1967|TransparentUpgradeableProxy|_authorizeUpgrade|upgradeTo(?:AndCall)?)\b|\bdelegatecall\b/,
    why: "an upgradeable or delegatecalling custody contract can be given any behaviour later",
  },
  {
    id: "unbounded-withdrawal",
    pattern:
      /\bfunction\s+(?:sweep|rescue|drain|withdrawAll|emergencyWithdraw|recoverERC20|skim)\w*\s*\(/i,
    why: "an arbitrary-recipient transfer helper is a drain",
  },
  {
    id: "mutable-verifier",
    pattern: /\bfunction\s+set(?:Verifier|Token|Usdc|ChallengeWindow|Attestors?|Threshold)\w*\s*\(/i,
    why: "the verifier, token and window must be immutable; a setter makes every past attestation re-interpretable",
  },
  {
    id: "self-destruct",
    pattern: /\bselfdestruct\b/,
    why: "a custody contract must not be destructible",
  },
];

/** Removes comments and string literals so prose cannot trip a code pattern. */
function stripNonCode(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'") {
      const quote = char;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      // Keep a placeholder so line numbers and token boundaries survive.
      out += '""';
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

function scan(source, label) {
  const code = stripNonCode(source);
  const lines = code.split("\n");
  const findings = [];
  for (const rule of FORBIDDEN) {
    // Per-line so the report names a line; the multiline state rule gets the whole
    // body because its pattern is anchored with /m.
    if (rule.pattern.flags.includes("m")) {
      const match = rule.pattern.exec(code);
      if (match) {
        const line = code.slice(0, match.index).split("\n").length;
        findings.push({ label, line, id: rule.id, why: rule.why, text: match[0].trim() });
      }
      continue;
    }
    for (let index = 0; index < lines.length; index++) {
      const match = rule.pattern.exec(lines[index]);
      if (match) {
        findings.push({
          label,
          line: index + 1,
          id: rule.id,
          why: rule.why,
          text: match[0].trim(),
        });
      }
    }
  }
  return findings;
}

const POSITIVE_CONTROL = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// A contract whose comments claim it never adjudicates, and whose code does.
contract BadEscrow is Ownable, Pausable, UUPSUpgradeable {
    uint16 public verdict;

    function setVerdict(uint16 v) external onlyOwner { verdict = v; }
    function adjudicateMandate(bytes32 id) external { }
    function pause() external onlyOwner { _pause(); }
    function sweepTokens(address to, uint256 amount) external onlyOwner { }
    function setVerifier(address v) external onlyOwner { }
    function kill() external onlyOwner { selfdestruct(payable(msg.sender)); }
    function _authorizeUpgrade(address) internal override onlyOwner { }
    function poke(address t, bytes calldata d) external { t.delegatecall(d); }
}
`;

const CLEAN_CONTROL = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// This contract's documentation discusses adjudication, verdicts, scores, owners,
/// pausing and sweeping at length -- because explaining why none of them exists is
/// part of documenting the boundary. "setVerdict" and "onlyOwner" appear here as
/// prose and in this string literal: "function sweep(address to) onlyOwner".
contract GoodEscrow {
    uint256 public deposited;
    function execute(bytes32 settlementId) external { }
}
`;

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: node scripts/verify-no-adjudication.mjs <file.sol> [...]");
    process.exit(2);
  }

  // Positive control first: a silent scanner proves nothing.
  const control = scan(POSITIVE_CONTROL, "<positive-control>");
  const tripped = new Set(control.map((finding) => finding.id));
  const missed = FORBIDDEN.filter((rule) => !tripped.has(rule.id)).map((rule) => rule.id);
  if (missed.length > 0) {
    console.error(
      `NO-ADJUDICATION BROKEN: the positive control did not trip these detectors: ${missed.join(", ")}`,
    );
    console.error("  The check cannot be trusted until its own control fails. Fix the patterns.");
    process.exit(1);
  }

  // Negative control: prose and string literals must not trip anything.
  const clean = scan(CLEAN_CONTROL, "<clean-control>");
  if (clean.length > 0) {
    console.error("NO-ADJUDICATION BROKEN: the clean control produced findings, so the scanner reads prose:");
    for (const finding of clean) console.error(`  - ${finding.id}: ${finding.text}`);
    process.exit(1);
  }

  const findings = [];
  for (const target of targets) {
    const path = resolve(ROOT, target);
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      console.error(`NO-ADJUDICATION FAILED: cannot read ${target}: ${error.message}`);
      process.exit(1);
    }
    findings.push(...scan(source, relative(ROOT, path)));
  }

  if (findings.length > 0) {
    console.error(`NO-ADJUDICATION FAILED (${findings.length})`);
    for (const finding of findings) {
      console.error(`  - ${finding.label}:${finding.line}  ${finding.id}: ${finding.text}`);
      console.error(`      ${finding.why}`);
    }
    process.exit(1);
  }

  console.log(`NO-ADJUDICATION OK ${targets.length} file(s), control verified (${FORBIDDEN.length} patterns)`);
}

main();
