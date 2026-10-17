// leaf-1.6.4:G4 — both agents run together and a mandate reaches SETTLED with reputation
// recorded, with neither agent driven by the other's internal state.
//
// They share nothing but the API. The worker is never told the mission id; it discovers
// it. The commissioner is never told the worker exists; it waits for a proposal. The only
// channel between them is the read model, which is the point.

import { Commissioner, Worker } from "../dist/index.js";
import { world, stopAll, KEYS, IDS, BRIEF, fail } from "./_world.mjs";

const problems = [];
const w = await world();

try {
  const commissionerClient = w.clientFor(IDS.commissioner, KEYS.commissioner);
  const workerClient = w.clientFor(IDS.worker, KEYS.worker);

  const commissioner = new Commissioner(commissionerClient, {
    agentId: IDS.commissioner,
    name: "Atlas Commissioning",
    operator: w.operatorOf(KEYS.commissioner),
    brief: BRIEF,
    chainId: 84532,
    deadlineUnix: 1_900_000_000,
    poll: { attempts: 60, intervalMs: 25 },
  });

  const worker = new Worker(workerClient, {
    agentId: IDS.worker,
    name: "Vector Labs",
    operator: w.operatorOf(KEYS.worker),
    capabilities: [
      { capabilityId: "coding", name: "Coding", description: "Writes and proves code.", version: "1", evidence: "https://example.com/vector/code" },
      { capabilityId: "testing", name: "Testing", description: "Builds conformance suites.", version: "1", evidence: "https://example.com/vector/test" },
    ],
    workspace: { repositoryUri: "https://example.com/vector/wrk-canonical" },
    minBudgetAtomic: "100000",
    poll: { attempts: 60, intervalMs: 25 },
  });

  // The parts the adjudicator and the keeper play, driven off the read model exactly as a
  // real keeper would be: it watches for state and acts, with no knowledge of the agents.
  let keeperRunning = true;
  const keeper = (async () => {
    while (keeperRunning) {
      for (const [missionId, mission] of w.protocol.missions) {
        if (mission.state === "SELECTING") { w.protocol.select(missionId); await w.settle(); }
      }
      for (const [mandateId, mandate] of w.protocol.mandates) {
        if (mandate.state === "ACCEPTED") { w.protocol.fund(mandateId); await w.settle(); }
        if (mandate.state === "SUBMITTED") { w.protocol.adjudicateAndSettle(mandateId); await w.settle(); }
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();

  // Both agents, concurrently, neither waiting on the other's internals.
  const [commissionerResult, workerResult] = await Promise.all([commissioner.run(), worker.run()]);
  keeperRunning = false;
  await keeper;
  await w.settle();

  if (!commissionerResult.settled) {
    problems.push(`the commissioner did not see settlement; transcript:\n${commissionerResult.transcript.render()}`);
  }
  if (!workerResult.submitted) {
    problems.push(`the worker did not submit work; transcript:\n${workerResult.transcript.render()}`);
  }
  if (commissionerResult.mandateId !== workerResult.mandateId) {
    problems.push(`the two agents worked on different mandates: ${commissionerResult.mandateId} vs ${workerResult.mandateId}`);
  }
  if (workerResult.missionId !== commissionerResult.missionId) {
    problems.push(`the worker found mission ${workerResult.missionId}, the commissioner published ${commissionerResult.missionId}`);
  }

  // The read model is the evidence, not the agents' own reports.
  const mandate = await commissionerClient.one("mandates", String(commissionerResult.mandateId));
  if (mandate?.state !== "SETTLED") problems.push(`the mandate is ${mandate?.state}, not SETTLED`);
  if (!mandate?.decision_hash) problems.push("the settled mandate carries no decision hash");
  if (!mandate?.funding_tx || !mandate?.settlement_tx) {
    problems.push("the settled mandate is missing a relayed Base transaction hash");
  }

  const reputation = await commissionerClient.reputation({ agent_id: IDS.worker });
  if (reputation.total !== 1) problems.push(`expected 1 reputation row for the worker, found ${reputation.total}`);
  const row = reputation.items[0];
  if (row && row.score_bp !== 10000) {
    problems.push(`the worker met both criteria but scored ${row.score_bp}`);
  }

  const decisions = await commissionerClient.decisions({ state: "FINALIZED" });
  if (decisions.total !== 1) problems.push(`expected 1 finalized decision, found ${decisions.total}`);

  const evidence = await commissionerClient.evidence({ mandate_id: String(commissionerResult.mandateId) });
  if (evidence.total !== BRIEF.criteria.length) {
    problems.push(`expected ${BRIEF.criteria.length} evidence item(s), found ${evidence.total}`);
  }

  // Neither agent reached past the API.
  const failures = [...commissionerResult.transcript.failures, ...workerResult.transcript.failures];
  if (failures.length > 0) {
    problems.push(`${failures.length} step(s) failed: ${failures.map((f) => `${f.agent} ${f.action}`).join(", ")}`);
  }

  if (problems.length === 0) {
    const steps = commissionerResult.transcript.all.length + workerResult.transcript.all.length;
    console.log(
      `AGENTS-TOGETHER OK settled — mandate ${commissionerResult.mandateId} reached SETTLED, reputation ${row?.score_bp} bp recorded, ${steps} API step(s) across two agents that shared nothing but the API`,
    );
  }
} finally {
  await w.stop();
  await stopAll();
}

if (problems.length > 0) fail("AGENTS-TOGETHER", problems);
