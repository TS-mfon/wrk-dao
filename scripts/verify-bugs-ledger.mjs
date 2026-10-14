// Validates BUGS.md as a ledger rather than as prose.
//
//   node scripts/verify-bugs-ledger.mjs
//
// Success prints exactly one line: BUGS-LEDGER OK <n> entries (<f> fixed, <o> open)
//
// What this enforces, and why
// ---------------------------
// A bug list whose entries are neither fixed nor open is a list nobody can act on. So
// every entry must carry a reproduction and a root cause, and then resolve one of two
// ways: `fixed` with a `Covered by:` naming what now catches it, or `open` with an
// `Open reason:` saying why it is still open. An entry that says "Status: fixed" and
// names nothing is the shape this refuses — it is a claim with no oracle behind it.
//
// The checker self-tests against malformed fixtures before trusting the real file. A
// structural validator that has never rejected anything proves nothing by staying quiet.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LEDGER = resolve(ROOT, "BUGS.md");

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set(["fixed", "open", "wontfix"]);

const FIELD = (name) =>
  new RegExp(`^-\\s+\\*\\*${name}:\\*\\*\\s*(.+)$`, "im");

/** Split a ledger into `### BUG-NNN — title` sections. */
function parseEntries(source) {
  const lines = source.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const heading = /^###\s+(BUG-\d+)\s+—\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) entries.push(current);
      current = { id: heading[1], title: heading[2], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(current);
  return entries.map((entry) => ({ ...entry, body: entry.body.join("\n") }));
}

function field(body, name) {
  const found = FIELD(name).exec(body);
  return found ? found[1].trim() : null;
}

/** Returns a list of human-readable problems. Empty means the ledger is well formed. */
function validate(source) {
  const problems = [];
  const entries = parseEntries(source);

  if (entries.length === 0) {
    problems.push("no BUG-NNN entries found");
    return { problems, entries };
  }

  const seen = new Set();
  const numbers = [];

  for (const entry of entries) {
    const where = `${entry.id}`;

    if (seen.has(entry.id)) problems.push(`${where}: duplicate id`);
    seen.add(entry.id);
    numbers.push(Number(entry.id.slice(4)));

    if (!entry.title || entry.title.length < 12) {
      problems.push(`${where}: title is missing or too short to identify the defect`);
    }

    const severity = field(entry.body, "Severity");
    if (!severity) problems.push(`${where}: no Severity`);
    else if (!SEVERITIES.has(severity)) {
      problems.push(`${where}: Severity ${JSON.stringify(severity)} is not one of ${[...SEVERITIES].join(", ")}`);
    }

    const status = field(entry.body, "Status");
    if (!status) problems.push(`${where}: no Status`);
    else if (!STATUSES.has(status)) {
      problems.push(`${where}: Status ${JSON.stringify(status)} is not one of ${[...STATUSES].join(", ")}`);
    }

    if (!field(entry.body, "Area")) problems.push(`${where}: no Area`);

    const repro = field(entry.body, "Reproduce");
    if (!repro) problems.push(`${where}: no Reproduce`);
    else if (repro.length < 30) {
      problems.push(`${where}: Reproduce is too short to follow (${repro.length} chars)`);
    }

    const cause = field(entry.body, "Root cause");
    if (!cause) problems.push(`${where}: no Root cause`);
    else if (cause.length < 30) {
      problems.push(`${where}: Root cause is too short to be a cause (${cause.length} chars)`);
    }

    // The part that makes this a ledger rather than a list.
    if (status === "fixed") {
      if (!field(entry.body, "Fix")) problems.push(`${where}: fixed but no Fix`);
      const covered = field(entry.body, "Covered by");
      if (!covered) {
        problems.push(`${where}: fixed but nothing is named under "Covered by" — a fix with no oracle is a claim`);
      } else if (!/[A-Za-z0-9]/.test(covered)) {
        problems.push(`${where}: "Covered by" is empty`);
      }
    } else if (status === "open" || status === "wontfix") {
      const reason = field(entry.body, "Open reason");
      if (!reason) problems.push(`${where}: ${status} but no "Open reason"`);
      else if (reason.length < 20) {
        problems.push(`${where}: "Open reason" is too short to be a reason (${reason.length} chars)`);
      }
    }
  }

  // Numbering must be dense and ascending, so a deleted entry is visible as a gap
  // rather than silently renumbering the ones after it.
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index] !== index + 1) {
      problems.push(
        `entry numbering is not dense from 001: expected BUG-${String(index + 1).padStart(3, "0")}, found BUG-${String(sorted[index]).padStart(3, "0")}`,
      );
      break;
    }
  }

  return { problems, entries };
}

// ── self-test: the validator must reject these before it is trusted ──────────

const CONTROLS = [
  {
    name: "fixed with no oracle",
    source: `### BUG-001 — A defect with a long enough title
- **Severity:** high
- **Status:** fixed
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
- **Fix:** changed it
`,
    expect: /nothing is named under "Covered by"/,
  },
  {
    name: "open with no reason",
    source: `### BUG-001 — A defect with a long enough title
- **Severity:** low
- **Status:** open
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
`,
    expect: /open but no "Open reason"/,
  },
  {
    name: "undecided status",
    source: `### BUG-001 — A defect with a long enough title
- **Severity:** low
- **Status:** investigating
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
`,
    expect: /is not one of/,
  },
  {
    name: "no reproduction",
    source: `### BUG-001 — A defect with a long enough title
- **Severity:** low
- **Status:** open
- **Area:** somewhere
- **Root cause:** the cause was a mistake in the thing that does the work
- **Open reason:** it is still open for a stated and sufficient reason
`,
    expect: /no Reproduce/,
  },
  {
    name: "a gap in the numbering",
    source: `### BUG-001 — A defect with a long enough title
- **Severity:** low
- **Status:** open
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
- **Open reason:** it is still open for a stated and sufficient reason

### BUG-003 — Another defect with a long enough title
- **Severity:** low
- **Status:** open
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
- **Open reason:** it is still open for a stated and sufficient reason
`,
    expect: /numbering is not dense/,
  },
  { name: "an empty ledger", source: "# BUGS\n\nnothing here\n", expect: /no BUG-NNN entries/ },
];

for (const control of CONTROLS) {
  const { problems } = validate(control.source);
  if (!problems.some((problem) => control.expect.test(problem))) {
    console.error(`BUGS-LEDGER FAILED: the validator did not reject the control "${control.name}"`);
    console.error(`  expected a problem matching ${control.expect}`);
    console.error(`  got: ${problems.length ? problems.join("; ") : "(no problems at all)"}`);
    process.exit(1);
  }
}

// A control that must PASS, so the validator is not simply rejecting everything.
const WELL_FORMED = `### BUG-001 — A defect with a long enough title
- **Severity:** high
- **Status:** fixed
- **Area:** somewhere
- **Reproduce:** do the thing that makes the defect happen, repeatedly
- **Root cause:** the cause was a mistake in the thing that does the work
- **Fix:** changed it so that it no longer does that
- **Covered by:** some:G1
`;
{
  const { problems } = validate(WELL_FORMED);
  if (problems.length > 0) {
    console.error("BUGS-LEDGER FAILED: the validator rejected a well-formed control");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

// ── the real ledger ─────────────────────────────────────────────────────────

if (!existsSync(LEDGER)) {
  console.error("BUGS-LEDGER FAILED: BUGS.md does not exist");
  process.exit(1);
}

const source = readFileSync(LEDGER, "utf8");
const { problems, entries } = validate(source);

if (problems.length > 0) {
  console.error(`BUGS-LEDGER FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const counts = { fixed: 0, open: 0, wontfix: 0 };
for (const entry of entries) counts[field(entry.body, "Status")] += 1;

console.log(
  `BUGS-LEDGER OK ${entries.length} entries (${counts.fixed} fixed, ${counts.open + counts.wontfix} open)`,
);
