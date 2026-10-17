// One whole scenario: two agents, a keeper, a brief, and whatever the API tells them.
//
// Shared by `verify/reactive.mjs`, `verify/failure-handling.mjs` and `verify/transcript.mjs`
// so those three gates measure the same run rather than three subtly different ones. The
// world is created and torn down here, and everything a gate needs is read out of the read
// model before the teardown.

import { Commissioner, Worker } from "../dist/index.js";
import { world, keeper, KEYS, IDS } from "./_world.mjs";

/**
 * The chain method behind each SDK write, so an injection can name the call site.
 *
 * The map is checked against the agents' source below: every `this.client.<write>` either
 * appears here or the gate fails, which is what stops a newly added write from being
 * untested.
 */
export const WRITES = {
  registerAgent: "register_agent",
  createDao: "create_dao",
  createMission: "create_mission",
  openMission: "open_mission",
  closeProposals: "close_proposals",
  startSelection: "start_selection",
  createMandate: "create_mandate",
  joinDao: "join_dao",
  submitProposal: "submit_proposal",
  acceptMandate: "accept_mandate",
  startWork: "start_work",
  submitDeliverable: "submit_deliverable",
  submitWork: "submit_work",
};

/**
 * Runs both agents to completion against one brief.
 *
 * `failAt` injects a failure at a named chain write, which is how `verify/failure-handling`
 * exercises the retry policy rather than describing it. `metCriteria` lets a gate choose a
 * partial verdict. Nothing else about the run is parameterised: the agents decide
 * everything else from what the API returns, which is what makes the transcripts
 * comparable across briefs.
 */
export async function runScenario({
  brief,
  failAt,
  metCriteria,
  chainId = 84532,
  minBudgetAtomic = "100000",
  // Generous by default so a slow machine does not fail a gate. The failure scenarios
  // override it: 39 of them each wait out a poll budget, and the keeper's loop is 10ms, so
  // a smaller budget there is still orders of magnitude more than the protocol needs.
  poll = { attempts: 120, intervalMs: 15 },
}) {
  const w = await world(failAt ? { failAt } : {});
  const keep = keeper(w, { metCriteria });

  const commissionerClient = w.clientFor(IDS.commissioner, KEYS.commissioner);
  const workerClient = w.clientFor(IDS.worker, KEYS.worker);

  const commissioner = new Commissioner(commissionerClient, {
    agentId: IDS.commissioner,
    name: "Atlas Commissioning",
    operator: w.operatorOf(KEYS.commissioner),
    brief,
    chainId,
    deadlineUnix: 1_900_000_000,
    poll,
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
    minBudgetAtomic,
    poll,
  });

  const settled = await Promise.allSettled([commissioner.run(), worker.run()]);
  await keep.stop();

  const outcome = {
    commissioner: settled[0].status === "fulfilled" ? settled[0].value : null,
    worker: settled[1].status === "fulfilled" ? settled[1].value : null,
    commissionerError: settled[0].status === "rejected" ? settled[0].reason : null,
    workerError: settled[1].status === "rejected" ? settled[1].reason : null,
    commissionerTranscript: commissioner.transcript,
    workerTranscript: worker.transcript,
    injected: failAt ? w.requests.filter((request) => request.method === failAt.method).length : 0,
    requests: w.requests.map((request) => request.method),
  };

  // Read the evidence out before the world goes away.
  const mandateId = outcome.commissioner?.mandateId ?? outcome.worker?.mandateId ?? null;
  outcome.mandate = mandateId ? await commissionerClient.one("mandates", String(mandateId)) : null;
  outcome.mission = outcome.commissioner?.missionId
    ? await commissionerClient.one("missions", String(outcome.commissioner.missionId))
    : null;
  outcome.dao = outcome.commissioner?.daoId
    ? await commissionerClient.one("daos", String(outcome.commissioner.daoId))
    : null;
  outcome.proposal = outcome.worker?.proposalId
    ? await commissionerClient.one("proposals", String(outcome.worker.proposalId))
    : null;
  outcome.deliverable = outcome.worker?.deliverableId
    ? await commissionerClient.one("deliverables", String(outcome.worker.deliverableId))
    : null;
  outcome.evidence = mandateId ? await commissionerClient.evidence({ mandate_id: String(mandateId) }) : { total: 0, items: [] };
  outcome.reputation = await commissionerClient.reputation({ agent_id: IDS.worker });

  await w.stop();
  return outcome;
}

/** Every ULID replaced by its prefix, so two runs of the same scenario compare equal. */
export const withoutIds = (text) => text.replace(/\b(agt|dao|msn|prp|mnd|dlv|dec|stl|pay|evd)_[0-9A-HJKMNP-TV-Z]{26}\b/g, "<$1>");

/**
 * Steps whose repetition is scheduling noise rather than behaviour.
 *
 * How many times an agent polls before the keeper gets round to funding depends on how the
 * event loop happened to interleave, and it alternates (`discoverOpenMissions`,
 * `missionsVisible`, `discoverOpenMissions`, ...) so a plain consecutive-dedupe does not
 * remove it. A maximal run of these is reduced to the set of distinct steps it contained,
 * which keeps "the agent polled for a mandate" and drops "it polled four times".
 */
const POLL_ACTIONS = new Set([
  "discoverOpenMissions",
  "missionsVisible",
  "pollProposals",
  "pollMission",
  "pollMandate",
  "pollMandates",
  "mandateObserved",
  "mandateState",
]);

/**
 * A transcript reduced to its shape: ids removed and polling runs collapsed.
 *
 * Collapsing is what lets two runs be compared for the differences that mean something —
 * and it is why `verify/reactive.mjs` can use an identical-transcript control to prove a
 * difference came from the brief rather than from scheduling.
 */
export function skeleton(transcript) {
  const lines = [];
  const flushPolls = (run) => {
    if (run.length === 0) return;
    for (const line of [...new Set(run)].sort()) lines.push(line);
  };

  let polls = [];
  for (const entry of transcript.all) {
    const line = `${entry.agent} ${entry.action} ${entry.status}`;
    if (POLL_ACTIONS.has(entry.action)) {
      polls.push(line);
      continue;
    }
    flushPolls(polls);
    polls = [];
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  flushPolls(polls);

  return withoutIds(lines.join("\n"));
}

/**
 * Everything the agents actually WROTE in a run, normalised so two runs compare equal.
 *
 * The skeleton above answers "did they follow the same path?", which two runs of different
 * briefs should: the protocol does not change shape because a mission has a third
 * criterion. This answers the different question "did they write the same thing?", which
 * two runs of different briefs must not — the proposal's plan, the bid and the evidence all
 * come from what the mission published.
 *
 * Ids and wall-clock stamps are stripped because they differ between any two runs and say
 * nothing about whether the agent was reading.
 */
export function fingerprint(run) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        // A timestamp is wall-clock noise, and an id is minted per run.
        if (/_at_unix$/.test(key) || /_(id|hash)$/.test(key)) continue;
        out[key] = strip(value[key]);
      }
      return out;
    }
    return typeof value === "string" ? withoutIds(value) : value;
  };

  const payloadOf = (document) => (document?.payload ? strip(JSON.parse(String(document.payload))) : null);

  return JSON.stringify(
    {
      mission: payloadOf(run.mission),
      proposal: payloadOf(run.proposal),
      deliverable: payloadOf(run.deliverable),
      evidence_uris: (run.evidence?.items ?? []).map((item) => withoutIds(String(item.uri))).sort(),
    },
    null,
    1,
  );
}
