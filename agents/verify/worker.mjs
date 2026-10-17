// leaf-1.6.4:G3 — the worker agent completes its whole side unattended.
//
// The gate's substance is in what the worker is NOT given: no mission id, no DAO id, no
// proposal id. It is handed a client and a description of itself, and everything else it
// has to find. An agent handed a mission id would be testing the API's write surface; an
// agent that has to discover the work is testing what a real participant does.
//
// Two missions are published. One is priced below the worker's floor, so "it found work"
// and "it took the first row it saw" are distinguishable outcomes: the transcript must show
// it considered the cheap one, declined it with a reason, and chose the other.

import { Worker } from "../dist/index.js";
import {
  world, stopAll, keeper, until, criteriaOf,
  registerParty, createDaoAs, publishMissionAs, createMandateAs,
  KEYS, IDS, BRIEF, CHEAP_BRIEF, fail,
} from "./_world.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const w = await world();
const keep = keeper(w);

try {
  const client = w.clientFor(IDS.worker, KEYS.worker);
  const hirerClient = w.clientFor(IDS.counterparty, KEYS.counterparty);

  // ── a world with work in it, published by someone the worker never meets ──
  await registerParty(hirerClient, {
    agentId: IDS.counterparty,
    name: "Counterparty Labs",
    operator: w.operatorOf(KEYS.counterparty),
    capabilities: [{
      capabilityId: "work-commissioning", name: "Commissioning", description: "Publishes work.",
      version: "1", evidence: "https://example.com/counterparty",
    }],
  });
  const daoId = await createDaoAs(hirerClient, {
    agentId: IDS.counterparty,
    daoId: "dao_01JQ8Z000000000000000000D1",
    maxBudgetAtomic: BRIEF.budgetAtomic,
    minAcceptanceCriteria: 1,
  });
  // Published first, so it is first in the read model's seq order and the worker has to
  // walk past it rather than never seeing it.
  const cheapMissionId = await publishMissionAs(hirerClient, { agentId: IDS.counterparty, daoId, brief: CHEAP_BRIEF });
  const missionId = await publishMissionAs(hirerClient, { agentId: IDS.counterparty, daoId, brief: BRIEF });

  const config = {
    agentId: IDS.worker,
    name: "Vector Labs",
    operator: w.operatorOf(KEYS.worker),
    capabilities: [
      { capabilityId: "coding", name: "Coding", description: "Writes and proves code.", version: "1", evidence: "https://example.com/vector/code" },
      { capabilityId: "testing", name: "Testing", description: "Builds conformance suites.", version: "1", evidence: "https://example.com/vector/test" },
    ],
    workspace: { repositoryUri: "https://example.com/vector/wrk-canonical" },
    minBudgetAtomic: "100000",
    poll: { attempts: 120, intervalMs: 15 },
  };

  // The gate's own precondition: if this ever fails, the gate below proves nothing.
  const asText = JSON.stringify(config);
  for (const [label, id] of [["the mission", missionId], ["the cheap mission", cheapMissionId], ["the dao", daoId]]) {
    check(!asText.includes(id), `the worker was told ${label} id (${id}); it is supposed to discover work`);
  }

  const worker = new Worker(client, config);

  // ── registers ─────────────────────────────────────────────────────────────
  await worker.ensureRegistered();
  const agent = await client.one("agents", IDS.worker);
  check(agent !== null, "after ensureRegistered the registry does not know the worker");
  const declared = (agent?.capabilities ?? []);
  check(
    declared.length === config.capabilities.length,
    `the registry records ${declared.length} capabilities, the worker declared ${config.capabilities.length}`,
  );
  for (const capability of config.capabilities) {
    check(
      declared.includes(capability.capabilityId),
      `the registry does not record the worker's ${capability.capabilityId} capability, so a DAO requiring it would refuse the join`,
    );
  }

  // ── discovers the work, and declines what it should decline ───────────────
  const mission = await worker.discoverMission();
  check(mission !== null, "the worker found no acceptable open mission");
  check(
    String(mission?.mission_id) === missionId,
    `the worker chose mission ${mission?.mission_id}; the only one above its floor was ${missionId}`,
  );

  const declined = worker.transcript.all.filter((entry) => entry.action === "declineMission");
  check(declined.length === 1, `expected the worker to decline the one under-priced mission, it declined ${declined.length}`);
  check(
    declined[0]?.subject === cheapMissionId,
    `the worker declined ${declined[0]?.subject}, expected the under-priced ${cheapMissionId}`,
  );
  check(
    String(declined[0]?.observed?.budget_atomic) === CHEAP_BRIEF.budgetAtomic,
    "the decline does not record the budget it was refusing, so the reason is not auditable",
  );

  // ── joins the DAO the work lives in ───────────────────────────────────────
  await worker.joinDao(String(mission.dao_id));
  const membership = await client.memberships({ dao_id: daoId, agent_id: IDS.worker });
  check(membership.total === 1, `the worker has ${membership.total} membership rows in the DAO, expected 1`);

  // Joining twice would be refused on chain; the agent has to notice it is already in.
  await worker.joinDao(String(mission.dao_id));
  const skippedJoins = worker.transcript.all.filter((entry) => entry.action === "joinDao" && entry.status === "skipped");
  check(skippedJoins.length === 1, `expected one skipped join on the second call, found ${skippedJoins.length}`);

  // ── proposes, answering the criteria THIS mission published ───────────────
  const proposalId = await worker.propose(mission);
  const proposal = await client.one("proposals", proposalId);
  check(proposal !== null, `after propose the read model has no proposal ${proposalId}`);
  check(proposal?.agent_id === IDS.worker, `proposal ${proposalId} is attributed to ${proposal?.agent_id}`);
  check(
    String(proposal?.requested_budget_atomic) === BRIEF.budgetAtomic,
    `the worker bid ${proposal?.requested_budget_atomic} on a mission budgeted at ${BRIEF.budgetAtomic}`,
  );

  const proposalPayload = JSON.parse(String(proposal?.payload ?? "{}"));
  const criteria = criteriaOf(await client.one("missions", missionId));
  check(
    (proposalPayload.execution_plan ?? []).length === criteria.length,
    `the plan has ${(proposalPayload.execution_plan ?? []).length} step(s) for ${criteria.length} criteria; it is not answering the mission`,
  );
  for (const criterion of criteria) {
    check(
      (proposalPayload.execution_plan ?? []).some((planStep) => String(planStep).includes(criterion.id)),
      `no plan step names criterion ${criterion.id}, so the proposal does not answer it`,
    );
  }

  // ── accepts the mandate when one names it ─────────────────────────────────
  await hirerClient.closeProposals({ missionId, creatorAgentId: IDS.counterparty });
  await hirerClient.startSelection({ missionId, creatorAgentId: IDS.counterparty });
  await until(
    `mission ${missionId} selected`,
    () => hirerClient.one("missions", missionId),
    (found) => found?.state === "SELECTED",
  );
  const mandateId = await createMandateAs(hirerClient, { agentId: IDS.counterparty, missionId, daoId, brief: BRIEF });

  const accepted = await worker.awaitAndAcceptMandate(missionId);
  check(accepted === mandateId, `the worker accepted ${accepted}, the mandate created was ${mandateId}`);
  const afterAccept = await client.one("mandates", mandateId);
  check(
    ["ACCEPTED", "FUNDED", "IN_PROGRESS"].includes(String(afterAccept?.state)),
    `after the worker accepted, the mandate is ${afterAccept?.state}`,
  );

  // ── starts once the DAO has funded, never before ──────────────────────────
  const started = await worker.awaitFundingAndStart(mandateId);
  check(started, "the worker never started work");
  const inProgress = await client.one("mandates", mandateId);
  check(inProgress?.state === "IN_PROGRESS", `the mandate is ${inProgress?.state}, not IN_PROGRESS`);
  check(Boolean(inProgress?.funding_tx), "work started on a mandate with no relayed funding transaction");

  // ── performs the work and submits evidence per criterion ──────────────────
  const deliverableId = await worker.deliver(mandateId);
  const deliverable = await client.one("deliverables", deliverableId);
  check(deliverable !== null, `after deliver the read model has no deliverable ${deliverableId}`);
  check(
    Number(deliverable?.evidence_count) === criteria.length,
    `the deliverable carries ${deliverable?.evidence_count} evidence item(s) for ${criteria.length} criteria`,
  );

  const evidence = await client.evidence({ deliverable_id: deliverableId });
  check(evidence.total === criteria.length, `the read model has ${evidence.total} evidence row(s), expected ${criteria.length}`);
  for (const criterion of criteria) {
    const item = evidence.items.find((row) => String(row.uri).endsWith(`/${criterion.id}`));
    check(Boolean(item), `no evidence addresses criterion ${criterion.id}`);
    check(
      /^0x[0-9a-f]{64}$/.test(String(item?.content_hash ?? "")),
      `the evidence for ${criterion.id} carries no 32-byte digest, so the adjudicator is asked to trust a URL`,
    );
  }

  // Stated as "it has left the pre-submission states" rather than as a list of the states
  // it may have reached. The keeper adjudicates and settles as soon as it sees SUBMITTED,
  // so by the time this read lands the mandate may legitimately be anywhere from SUBMITTED
  // to SETTLED — enumerating the acceptable ones means a gate that fails when the keeper
  // happens to be quick, which is the opposite of what it is checking.
  const BEFORE_SUBMISSION = ["CREATED", "ACCEPTED", "FUNDED", "IN_PROGRESS"];
  const AFTER_SUBMISSION = ["SUBMITTED", "ADJUDICATING", "ADJUDICATED", "SETTLED"];
  const submitted = await client.one("mandates", mandateId);
  const finalState = String(submitted?.state);
  check(
    !BEFORE_SUBMISSION.includes(finalState),
    `after deliver the mandate is still ${finalState}; the work was never submitted for adjudication`,
  );
  check(
    AFTER_SUBMISSION.includes(finalState),
    `after deliver the mandate is ${finalState}, which is neither a pre-submission state nor on the route to settlement`,
  );

  const failures = worker.transcript.failures;
  check(
    failures.length === 0,
    `${failures.length} worker step(s) failed: ${failures.map((entry) => `${entry.action} (${entry.detail})`).join("; ")}`,
  );

  if (problems.length === 0) {
    console.log(
      `AGENT-WORKER OK ${worker.transcript.all.length} step(s) — registered, declined ${cheapMissionId} as under-priced, ` +
        `discovered ${missionId} unaided, joined ${daoId}, proposed ${proposalId} against ${criteria.length} criteria, ` +
        `accepted ${mandateId}, delivered ${deliverableId} with ${evidence.total} evidence item(s)`,
    );
  }
} catch (error) {
  problems.push(`the worker did not complete its side: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await keep.stop();
  await w.stop();
  await stopAll();
}

if (problems.length > 0) fail("AGENT-WORKER", problems);
