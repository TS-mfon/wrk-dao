// leaf-1.6.4:G2 — the commissioner agent completes its whole side unattended.
//
// Every step is the agent's own method, and after each one the READ MODEL is asked whether
// the step actually happened. Asserting the agent's own return value would prove only that
// the agent believes it worked; asking the API proves the write landed.
//
// The counterparty here is not the Worker agent — it is a few raw SDK calls (`_world.mjs`).
// Using the other agent would make this gate measure both of them, which is G4's job. What
// matters is that the commissioner never learns the counterparty exists except through the
// API: it is given no worker id, and the mandate it creates has to name whoever the
// adjudicator selected.

import { Commissioner } from "../dist/index.js";
import {
  world, stopAll, keeper, until, criteriaOf,
  registerParty, proposeAs, performAs,
  KEYS, IDS, BRIEF, fail,
} from "./_world.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const w = await world();
const keep = keeper(w);

try {
  const client = w.clientFor(IDS.commissioner, KEYS.commissioner);
  const bystanderClient = w.clientFor(IDS.bystander, KEYS.bystander);

  const config = {
    agentId: IDS.commissioner,
    name: "Atlas Commissioning",
    operator: w.operatorOf(KEYS.commissioner),
    brief: BRIEF,
    chainId: 84532,
    deadlineUnix: 1_900_000_000,
    poll: { attempts: 120, intervalMs: 15 },
  };

  // The commissioner is told nothing about who might do the work.
  const asText = JSON.stringify(config);
  check(!asText.includes(IDS.bystander), "the commissioner's config names the worker it will end up paying");

  const commissioner = new Commissioner(client, config);

  // ── registers ─────────────────────────────────────────────────────────────
  await commissioner.ensureRegistered();
  const agent = await client.one("agents", IDS.commissioner);
  check(agent !== null, "after ensureRegistered the registry does not know the commissioner");
  check(
    String(agent?.operator ?? "").toLowerCase() === config.operator.toLowerCase(),
    `the registry records operator ${agent?.operator}, not the commissioner's own ${config.operator}`,
  );

  // Idempotent: a second run must not attempt a second registration, which the registry
  // would refuse and which would strand an agent that restarted mid-run.
  await commissioner.ensureRegistered();
  const skipped = commissioner.transcript.all.filter((entry) => entry.action === "register" && entry.status === "skipped");
  check(skipped.length === 1, `expected one skipped registration on the second call, found ${skipped.length}`);

  // ── creates a DAO ─────────────────────────────────────────────────────────
  const daoId = await commissioner.ensureDao();
  const dao = await client.one("daos", daoId);
  check(dao !== null, `after ensureDao the read model has no dao ${daoId}`);
  check(
    dao?.creator_agent_id === IDS.commissioner,
    `dao ${daoId} records creator ${dao?.creator_agent_id}, not the commissioner`,
  );
  const creatorMembership = await client.memberships({ dao_id: daoId, agent_id: IDS.commissioner });
  check(creatorMembership.total === 1, `the DAO's creator has ${creatorMembership.total} membership rows, expected 1`);

  // ── publishes a mission ───────────────────────────────────────────────────
  const missionId = await commissioner.publishMission(daoId);
  const mission = await client.one("missions", missionId);
  check(mission?.state === "OPEN", `mission ${missionId} is ${mission?.state}, not OPEN and therefore not proposable`);
  check(
    String(mission?.budget_atomic) === BRIEF.budgetAtomic,
    `mission budget is ${mission?.budget_atomic}, not the brief's ${BRIEF.budgetAtomic}`,
  );
  const published = criteriaOf(mission);
  check(
    published.length === BRIEF.criteria.length,
    `the published mission carries ${published.length} criteria, the brief had ${BRIEF.criteria.length}`,
  );
  check(
    published.every((criterion, index) => criterion.id === BRIEF.criteria[index].id),
    "the published criteria are not the brief's criteria, so a worker cannot answer what was asked",
  );

  // ── waits for a proposal from a party it knows nothing about ──────────────
  await registerParty(bystanderClient, {
    agentId: IDS.bystander,
    name: "Bystander Works",
    operator: w.operatorOf(KEYS.bystander),
    capabilities: [{
      capabilityId: "coding", name: "Coding", description: "Writes code.", version: "1",
      evidence: "https://example.com/bystander",
    }],
  });
  await bystanderClient.joinDao({ daoId, agentId: IDS.bystander });
  const proposalId = await proposeAs(bystanderClient, {
    agentId: IDS.bystander,
    mission: await client.one("missions", missionId),
    capabilities: ["coding"],
  });

  const seen = await commissioner.awaitProposals(missionId);
  check(seen === 1, `the commissioner reports ${seen} proposal(s), the API has 1`);

  // ── closes and triggers selection ─────────────────────────────────────────
  await commissioner.closeAndSelect(missionId);
  const selecting = await client.one("missions", missionId);
  check(
    ["SELECTING", "SELECTED"].includes(String(selecting?.state)),
    `after closeAndSelect the mission is ${selecting?.state}; selection was never triggered`,
  );

  const selection = await commissioner.awaitSelection(missionId);
  check(selection !== null, "the commissioner never observed a selection");
  check(
    selection?.proposalId === proposalId,
    `the commissioner read selected proposal ${selection?.proposalId}, the adjudicator chose ${proposalId}`,
  );

  // ── creates the mandate from the proposal that was actually selected ──────
  const mandateId = await commissioner.createMandate({
    missionId, daoId,
    proposalId: selection.proposalId,
    decisionHash: selection.decisionHash,
  });
  const mandate = await client.one("mandates", mandateId);
  check(mandate?.state === "CREATED", `mandate ${mandateId} is ${mandate?.state}, not CREATED`);
  check(
    mandate?.selection_decision_hash === selection.decisionHash,
    `the mandate cites selection decision ${mandate?.selection_decision_hash}, the mission recorded ${selection.decisionHash}`,
  );
  // The substance of the gate: the commissioner was never told who the worker was, so the
  // only way the mandate can name the bystander is by having read the selected proposal.
  const workers = await client.mandates({ mission_id: missionId });
  check(workers.total === 1, `expected 1 mandate for the mission, found ${workers.total}`);
  check(
    Number(mandate?.worker_count) === 1,
    `the mandate names ${mandate?.worker_count} worker(s), expected the single selected proposer`,
  );
  const mandatePayload = JSON.parse(String(mandate?.payload ?? "{}"));
  check(
    (mandatePayload.workers ?? []).some((entry) => entry.agent_id === IDS.bystander),
    `the mandate pays ${JSON.stringify(mandatePayload.workers)}, not the selected proposer ${IDS.bystander}`,
  );

  // ── records settlement ────────────────────────────────────────────────────
  // The worker side is driven raw, so `awaitSettlement` is watching real progress.
  const performing = performAs(bystanderClient, { agentId: IDS.bystander, mandateId });
  const finalState = await commissioner.awaitSettlement(mandateId);
  await performing;
  await until(`mandate ${mandateId} settled`, () => client.one("mandates", mandateId), (m) => m?.state === "SETTLED");

  check(finalState === "SETTLED", `the commissioner reports the mandate reached ${finalState}, not SETTLED`);
  const settled = await client.one("mandates", mandateId);
  check(Boolean(settled?.decision_hash), "the settled mandate carries no decision hash");
  check(Boolean(settled?.settlement_tx), "the settled mandate carries no relayed settlement transaction");

  // Every state the commissioner passed through is in its transcript, with the id it
  // affected. A step that happened without being recorded is not auditable.
  const observedStates = commissioner.transcript.all
    .filter((entry) => entry.action === "mandateState")
    .map((entry) => entry.observed?.state);
  check(
    observedStates.includes("SETTLED"),
    `the transcript never records the mandate reaching SETTLED; it saw ${observedStates.join(" -> ")}`,
  );

  const failures = commissioner.transcript.failures;
  check(
    failures.length === 0,
    `${failures.length} commissioner step(s) failed: ${failures.map((entry) => `${entry.action} (${entry.detail})`).join("; ")}`,
  );

  if (problems.length === 0) {
    console.log(
      `AGENT-COMMISSIONER OK ${commissioner.transcript.all.length} step(s) — registered, created dao ${daoId}, ` +
        `published mission ${missionId}, closed and selected, mandated ${mandateId} to the selected proposer, settled`,
    );
  }
} catch (error) {
  problems.push(`the commissioner did not complete its side: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await keep.stop();
  await w.stop();
  await stopAll();
}

if (problems.length > 0) fail("AGENT-COMMISSIONER", problems);
