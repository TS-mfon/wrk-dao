// leaf-1.6.4:G8 — the run produces a transcript naming every API call, its status, and the
// on-chain id it affected.
//
// The point is auditability. A console log that says "settled!" is a claim; a transcript
// that can be checked against what the chain actually saw is evidence. So this gate does
// not inspect the transcript's prose — it compares the transcript against the list of calls
// the world recorded, and fails if the two disagree in either direction:
//
//   a call with no entry   is a write that happened unrecorded, which is the audit hole
//   an entry with no call  is the transcript claiming something that never happened
//
// Because that comparison is the whole gate, it runs against a doctored transcript first.
// A completeness check that has never caught an omission is not a check.

import { runScenario, WRITES } from "./_scenario.mjs";
import { stopAll, BRIEF, fail } from "./_world.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const ID_SHAPE = /^(agt|dao|msn|prp|mnd|dlv|dec|stl|pay|evd)_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUSES = new Set(["ok", "refused", "failed", "skipped"]);

/**
 * Compares a run's transcripts against the calls the world recorded.
 *
 * Returns a list of disagreements. `entries` is passed in rather than read off the
 * transcripts so the negative control below can hand it a doctored list.
 */
function reconcile(entries, chainCalls) {
  const disagreements = [];

  // What the transcripts claim was written, as chain method names.
  const claimed = [];
  for (const entry of entries) {
    const chainMethod = WRITES[entry.action];
    if (!chainMethod) continue;
    // A refused or failed write still reached the chain — that is what refused it — so it
    // counts as an attempt. A skipped one did not.
    if (entry.status === "skipped") continue;
    claimed.push(chainMethod);
  }

  const tally = (list) => {
    const counts = new Map();
    for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
    return counts;
  };
  const claimedCounts = tally(claimed);
  const actualCounts = tally(chainCalls);

  for (const [method, actual] of actualCounts) {
    const stated = claimedCounts.get(method) ?? 0;
    if (stated < actual) {
      disagreements.push(
        `${method} reached the chain ${actual} time(s) but the transcript records ${stated}; ` +
          `${actual - stated} write(s) happened without being recorded`,
      );
    }
  }
  for (const [method, stated] of claimedCounts) {
    const actual = actualCounts.get(method) ?? 0;
    if (stated > actual) {
      disagreements.push(
        `the transcript records ${method} ${stated} time(s) but only ${actual} reached the chain; the transcript overstates what happened`,
      );
    }
  }
  return disagreements;
}

try {
  const run = await runScenario({ brief: BRIEF });
  check(run.commissioner?.settled === true, `the scenario did not settle (${run.mandate?.state ?? "no mandate"}); there is no complete run to audit`);

  const entries = [...run.commissionerTranscript.all, ...run.workerTranscript.all];

  // ── the negative controls ─────────────────────────────────────────────────
  //
  // Two doctored transcripts, one in each direction. If `reconcile` stays quiet for either,
  // the comparison below proves nothing.
  const omitted = entries.filter((entry) => entry.action !== "submitDeliverable");
  if (reconcile(omitted, run.requests).length === 0) {
    fail("AGENTS-TRANSCRIPT", [
      "the reconciliation did not notice a transcript with its submitDeliverable entry removed, so it cannot detect an unrecorded write",
    ]);
  }
  const invented = [...entries, { step: 999, agent: "worker", action: "createMandate", status: "ok", subject: "mnd_01JQ8Z000000000000000000X1" }];
  if (reconcile(invented, run.requests).length === 0) {
    fail("AGENTS-TRANSCRIPT", [
      "the reconciliation did not notice an invented createMandate entry, so a transcript could overstate what happened",
    ]);
  }

  // ── every call the chain saw is in the transcript, and nothing more ────────
  const disagreements = reconcile(entries, run.requests);
  for (const disagreement of disagreements) problems.push(disagreement);

  // ── every entry is well formed ────────────────────────────────────────────
  for (const transcript of [run.commissionerTranscript, run.workerTranscript]) {
    const all = transcript.all;
    check(all.length > 0, `${transcript.agent}: the transcript is empty`);

    all.forEach((entry, index) => {
      const where = `${transcript.agent} step ${entry.step} (${entry.action})`;
      // Contiguous numbering from 1, so a removed entry is visible as a gap rather than
      // closing silently over itself.
      check(entry.step === index + 1, `${where}: steps are not contiguous from 1; expected ${index + 1}`);
      check(entry.agent === transcript.agent, `${where}: attributed to ${entry.agent}`);
      check(typeof entry.action === "string" && entry.action.length > 0, `${where}: no action named`);
      check(STATUSES.has(entry.status), `${where}: status ${JSON.stringify(entry.status)} is not one of ${[...STATUSES].join(", ")}`);

      // Every write names the id it affected. A write recorded without its subject is a
      // line an auditor cannot follow to the chain.
      if (WRITES[entry.action]) {
        check(typeof entry.subject === "string" && ID_SHAPE.test(entry.subject), `${where}: a write with no on-chain id (subject ${JSON.stringify(entry.subject)})`);
      }
      if (entry.subject !== undefined) {
        check(ID_SHAPE.test(entry.subject), `${where}: subject ${JSON.stringify(entry.subject)} is not an on-chain id`);
      }
      // A step that did not go through must say why. "failed" with no reason is the shape
      // this refuses.
      if (entry.status === "failed" || entry.status === "refused" || entry.status === "skipped") {
        check(
          typeof entry.detail === "string" && entry.detail.length > 0,
          `${where}: recorded ${entry.status} with no reason`,
        );
      }
    });
  }

  // ── the ids in the transcript resolve on chain ────────────────────────────
  const resolvable = new Map([
    ["createDao", run.commissioner?.daoId],
    ["createMission", run.commissioner?.missionId],
    ["submitProposal", run.worker?.proposalId],
    ["createMandate", run.commissioner?.mandateId],
    ["submitDeliverable", run.worker?.deliverableId],
  ]);
  for (const [action, expected] of resolvable) {
    const entry = entries.find((candidate) => candidate.action === action && candidate.status === "ok");
    check(entry !== undefined, `no successful ${action} entry, although the run settled`);
    check(
      entry?.subject === String(expected),
      `the transcript's ${action} names ${entry?.subject}, the run produced ${expected}`,
    );
  }

  // ── it renders and serialises ─────────────────────────────────────────────
  for (const transcript of [run.commissionerTranscript, run.workerTranscript]) {
    const rendered = transcript.render();
    check(
      rendered.split("\n").length === transcript.all.length,
      `${transcript.agent}: render() produced ${rendered.split("\n").length} lines for ${transcript.all.length} entries`,
    );
    check(!/\b\d{10,}\b/.test(rendered), `${transcript.agent}: the rendering contains a wall-clock timestamp, which makes two runs incomparable`);
    const json = JSON.parse(JSON.stringify(transcript));
    check(Array.isArray(json) && json.length === transcript.all.length, `${transcript.agent}: toJSON() does not round-trip`);
  }

  // ── and the state the run reached is in it, not just in the read model ────
  const states = entries.filter((entry) => entry.action === "mandateState").map((entry) => String(entry.observed?.state));
  check(states.includes("SETTLED"), `the transcript never records the mandate reaching SETTLED; it saw ${states.join(" -> ") || "nothing"}`);
  const finalEntry = entries.filter((entry) => entry.action === "mandateState").pop();
  check(
    typeof finalEntry?.observed?.decision_hash === "string" && /^0x[0-9a-f]{64}$/.test(String(finalEntry.observed.decision_hash)),
    `the settled state is recorded without the decision hash it settled against (${JSON.stringify(finalEntry?.observed)})`,
  );

  if (problems.length === 0) {
    console.log(
      `AGENTS-TRANSCRIPT OK ${entries.length} entry(s) reconciled against ${run.requests.length} chain call(s) — ` +
        `every write names its on-chain id, every non-success names a reason, 2 doctored controls were caught, ` +
        `and the SETTLED state is recorded with the decision hash it settled against`,
    );
  }
} catch (error) {
  problems.push(`the transcript gate threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await stopAll();
}

if (problems.length > 0) fail("AGENTS-TRANSCRIPT", problems);
