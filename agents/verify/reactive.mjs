// leaf-1.6.4:G6 — the agents react to what the API returns rather than replaying a script.
//
// This is what separates a demo from a product claim. Two runs of a hardcoded script
// produce identical transcripts whatever the mission says; two runs of an agent that reads
// the acceptance criteria must not.
//
// The gate runs three scenarios:
//
//   A  the canonical-JSON brief: 2 criteria, 1_000_000 atomic
//   B  the indexer brief:        3 criteria, 2_500_000 atomic, different criterion ids
//   C  the canonical-JSON brief again
//
// A vs B must differ, and in the places the briefs differ. A vs C must be IDENTICAL — that
// control is the load-bearing part, because without it "the transcripts differ" is also
// what nondeterminism looks like, and the gate would pass on an agent that merely varied.

import { runScenario, skeleton, fingerprint } from "./_scenario.mjs";
import { stopAll, BRIEF, OTHER_BRIEF, criteriaOf, fail } from "./_world.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

try {
  const a = await runScenario({ brief: BRIEF });
  const b = await runScenario({ brief: OTHER_BRIEF });
  const c = await runScenario({ brief: BRIEF });

  // ── both briefs reach settlement ──────────────────────────────────────────
  for (const [label, run, brief] of [["A", a, BRIEF], ["B", b, OTHER_BRIEF], ["C", c, BRIEF]]) {
    check(
      run.commissioner?.settled === true,
      `run ${label} (${brief.criteria.length} criteria) did not settle: ${run.commissionerError?.message ?? run.mandate?.state ?? "no mandate"}`,
    );
    check(run.worker?.submitted === true, `run ${label}: the worker did not submit work`);
  }

  // ── the determinism controls: same brief, same run ────────────────────────
  //
  // Two of them, because a run has two things that could vary. The PATH the agents take
  // through the protocol, and what they WROTE while taking it. Both must be stable across
  // runs of one brief, or a difference between briefs proves nothing.
  const skeletonA = skeleton(a.commissionerTranscript) + "\n--\n" + skeleton(a.workerTranscript);
  const skeletonB = skeleton(b.commissionerTranscript) + "\n--\n" + skeleton(b.workerTranscript);
  const skeletonC = skeleton(c.commissionerTranscript) + "\n--\n" + skeleton(c.workerTranscript);

  const firstDivergence = (left, right) => {
    const l = left.split("\n");
    const r = right.split("\n");
    const index = l.findIndex((line, at) => line !== r[at]);
    return index === -1
      ? `${l.length} vs ${r.length} lines`
      : `line ${index + 1}: ${JSON.stringify(l[index])} vs ${JSON.stringify(r[index])}`;
  };

  check(
    skeletonA === skeletonC,
    `two runs of the SAME brief took different paths, so a path difference between briefs would prove nothing. ${firstDivergence(skeletonA, skeletonC)}`,
  );

  const printA = fingerprint(a);
  const printB = fingerprint(b);
  const printC = fingerprint(c);
  check(
    printA === printC,
    `two runs of the SAME brief wrote different payloads, so a payload difference between briefs would prove nothing. ${firstDivergence(printA, printC)}`,
  );

  // ── reactivity: a different brief produces a different run ────────────────
  //
  // The path is deliberately NOT required to differ: the protocol has one shape, and an
  // agent that took a different route through it for a mission with one more criterion
  // would be a bug. What must differ is what the agents wrote.
  check(
    printA !== printB,
    "the two briefs produced identical payloads; the agents are replaying a script rather than reading the mission",
  );
  check(
    skeletonA === skeletonB,
    `the two briefs took different paths through the protocol, which the protocol does not have: ${firstDivergence(skeletonA, skeletonB)}`,
  );

  // ── and the differences are in the places the briefs differ ───────────────
  const criteriaA = criteriaOf(a.mission);
  const criteriaB = criteriaOf(b.mission);
  check(criteriaA.length === BRIEF.criteria.length, `run A published ${criteriaA.length} criteria, the brief had ${BRIEF.criteria.length}`);
  check(criteriaB.length === OTHER_BRIEF.criteria.length, `run B published ${criteriaB.length} criteria, the brief had ${OTHER_BRIEF.criteria.length}`);

  // The worker's plan: one step per criterion the mission actually published.
  const planA = JSON.parse(String(a.proposal?.payload ?? "{}")).execution_plan ?? [];
  const planB = JSON.parse(String(b.proposal?.payload ?? "{}")).execution_plan ?? [];
  check(
    planA.length === criteriaA.length && planB.length === criteriaB.length,
    `the plans have ${planA.length} and ${planB.length} steps for ${criteriaA.length} and ${criteriaB.length} criteria`,
  );
  check(planA.length !== planB.length, "the worker wrote the same number of plan steps for briefs with different criteria counts");
  for (const criterion of criteriaB) {
    check(
      planB.some((planStep) => String(planStep).includes(criterion.id)),
      `run B's plan never names criterion ${criterion.id}, so the proposal does not answer that brief`,
    );
  }
  // The ids are disjoint between the briefs, so a plan that mentioned the other brief's
  // criteria would be a template rather than an answer.
  for (const criterion of criteriaA) {
    check(
      !planB.some((planStep) => String(planStep).includes(criterion.id)),
      `run B's plan names ${criterion.id}, which belongs to the other brief`,
    );
  }

  // The bid follows the mission's budget, not a constant.
  check(
    String(a.proposal?.requested_budget_atomic) === BRIEF.budgetAtomic &&
      String(b.proposal?.requested_budget_atomic) === OTHER_BRIEF.budgetAtomic,
    `the worker bid ${a.proposal?.requested_budget_atomic} and ${b.proposal?.requested_budget_atomic} on budgets of ` +
      `${BRIEF.budgetAtomic} and ${OTHER_BRIEF.budgetAtomic}`,
  );

  // The evidence it published: one artefact per criterion it was asked to meet.
  check(
    a.evidence.total === criteriaA.length && b.evidence.total === criteriaB.length,
    `the deliverables carry ${a.evidence.total} and ${b.evidence.total} evidence items for ${criteriaA.length} and ${criteriaB.length} criteria`,
  );
  check(a.evidence.total !== b.evidence.total, "both runs produced the same amount of evidence for different briefs");

  // The commissioner's DAO cap follows its own brief, which is why run B could be
  // commissioned at all: a fixed cap below 2_500_000 would have refused the mission.
  const missionB = JSON.parse(String(b.mission?.payload ?? "{}"));
  check(
    String(missionB.budget?.amount_atomic) === OTHER_BRIEF.budgetAtomic,
    `run B's mission is budgeted at ${missionB.budget?.amount_atomic}, not the brief's ${OTHER_BRIEF.budgetAtomic}`,
  );
  const rulesB = JSON.parse(String(b.dao?.rules ?? "{}"));
  check(
    String(rulesB.max_mission_budget_atomic) === OTHER_BRIEF.budgetAtomic,
    `run B's DAO caps missions at ${rulesB.max_mission_budget_atomic}, not the brief's ${OTHER_BRIEF.budgetAtomic}; ` +
      `a fixed cap would have refused the mission the commissioner was created to publish`,
  );

  // And the transcripts record what each run observed, so the difference is auditable
  // rather than inferred from the read model afterwards.
  const observedA = a.workerTranscript.all.find((entry) => entry.action === "selectMission")?.observed;
  const observedB = b.workerTranscript.all.find((entry) => entry.action === "selectMission")?.observed;
  check(
    String(observedA?.budget_atomic) === BRIEF.budgetAtomic && String(observedB?.budget_atomic) === OTHER_BRIEF.budgetAtomic,
    `the transcripts record budgets ${observedA?.budget_atomic} and ${observedB?.budget_atomic}`,
  );

  if (problems.length === 0) {
    const lines = (text) => text.split("\n");
    const differing = lines(printA).filter((line, index) => line !== lines(printB)[index]).length;
    console.log(
      `AGENTS-REACTIVE OK ${criteriaA.length} vs ${criteriaB.length} criteria — two runs of one brief wrote byte-identical ` +
        `payloads over an identical ${lines(skeletonA).length}-step path; a different brief kept the path and changed ` +
        `${differing} payload line(s): plans of ${planA.length} vs ${planB.length} steps, bids of ${a.proposal?.requested_budget_atomic} ` +
        `vs ${b.proposal?.requested_budget_atomic}, evidence of ${a.evidence.total} vs ${b.evidence.total} items; both settled`,
    );
  }
} catch (error) {
  problems.push(`a scenario threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await stopAll();
}

if (problems.length > 0) fail("AGENTS-REACTIVE", problems);
