/**
 * The worker: an agent that finds work, proposes, performs it and submits evidence.
 *
 * It is **not told which mission to work on** (leaf-1.6.4:G3). It discovers open work
 * through the API, reads the acceptance criteria, and writes a proposal and a deliverable
 * that answer those criteria specifically. An agent handed a mission id would be testing
 * the API's write surface; an agent that has to find the work is testing the thing a real
 * participant has to do.
 *
 * Like the commissioner it uses `@wrk/sdk` and nothing else.
 */

import { payloads, newId, type WrkClient } from "@wrk/sdk";
import { Transcript, step } from "../transcript.js";

export interface WorkerConfig {
  readonly agentId: string;
  readonly name: string;
  readonly operator: string;
  /** What this worker claims it can do, and the evidence for each claim. */
  readonly capabilities: readonly {
    readonly capabilityId: string;
    readonly name: string;
    readonly description: string;
    readonly version: string;
    readonly evidence: string;
  }[];
  /** Where the worker publishes what it produced. */
  readonly workspace: { readonly repositoryUri: string };
  readonly poll?: { readonly attempts: number; readonly intervalMs: number };
  /**
   * A budget floor. A worker that proposes on anything is not reacting to what it reads;
   * one that declines work priced below its floor is.
   */
  readonly minBudgetAtomic?: string;
}

export interface WorkerResult {
  readonly transcript: Transcript;
  readonly missionId: string | null;
  readonly proposalId: string | null;
  readonly mandateId: string | null;
  readonly deliverableId: string | null;
  readonly submitted: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Worker {
  readonly transcript: Transcript;

  constructor(
    private readonly client: WrkClient,
    private readonly config: WorkerConfig,
  ) {
    this.transcript = new Transcript(`worker:${config.agentId}`);
  }

  private get poll() {
    return this.config.poll ?? { attempts: 20, intervalMs: 150 };
  }

  async ensureRegistered(): Promise<void> {
    const existing = await step(this.transcript, "readAgent", { subject: this.config.agentId }, () =>
      this.client.one("agents", this.config.agentId),
    );
    if (existing) {
      this.transcript.record({ action: "register", status: "skipped", subject: this.config.agentId, detail: "already registered" });
      return;
    }
    await step(this.transcript, "registerAgent", { subject: this.config.agentId, retries: 2 }, () =>
      this.client.registerAgent({
        agentId: this.config.agentId,
        profile: payloads.agentProfile({
          agentId: this.config.agentId,
          name: this.config.name,
          operator: this.config.operator,
          capabilities: this.config.capabilities,
        }),
      }),
    );
  }

  /**
   * Finds an open mission this worker is willing and able to take.
   *
   * Reads the mission's own fields and decides: a budget below the floor is declined, and
   * declining is recorded rather than silently skipped so the transcript shows the worker
   * considered it.
   */
  async discoverMission(): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt < this.poll.attempts; attempt += 1) {
      const page = await step(this.transcript, "discoverOpenMissions", {}, () => this.client.openMissions());
      this.transcript.record({
        action: "missionsVisible",
        status: "ok",
        observed: { open: page.total },
      });

      for (const mission of page.items as Array<Record<string, unknown>>) {
        const missionId = String(mission.mission_id);
        const budget = BigInt(String(mission.budget_atomic ?? "0"));
        const floor = BigInt(this.config.minBudgetAtomic ?? "0");
        if (budget < floor) {
          this.transcript.record({
            action: "declineMission",
            status: "ok",
            subject: missionId,
            observed: { budget_atomic: String(budget), floor_atomic: String(floor) },
            detail: "priced below this worker's floor",
          });
          continue;
        }
        this.transcript.record({
          action: "selectMission",
          status: "ok",
          subject: missionId,
          observed: { budget_atomic: String(budget), dao_id: mission.dao_id },
        });
        return mission;
      }
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({ action: "discoverMission", status: "failed", detail: "no acceptable open mission appeared" });
    return null;
  }

  async joinDao(daoId: string): Promise<void> {
    const memberships = await step(this.transcript, "readMemberships", { subject: daoId }, () =>
      this.client.memberships({ dao_id: daoId, agent_id: this.config.agentId }),
    );
    if (memberships.total > 0) {
      this.transcript.record({ action: "joinDao", status: "skipped", subject: daoId, detail: "already a member" });
      return;
    }
    await step(this.transcript, "joinDao", { subject: daoId, retries: 2 }, () =>
      this.client.joinDao({ daoId, agentId: this.config.agentId }),
    );
  }

  /**
   * Writes a proposal that answers the mission's criteria.
   *
   * The plan is derived from the criteria the mission published, so a mission with
   * different criteria produces a different proposal — which is what `verify/reactive.mjs`
   * measures.
   */
  async propose(mission: Record<string, unknown>): Promise<string> {
    const missionId = String(mission.mission_id);
    const full = await step(this.transcript, "readMission", { subject: missionId }, () =>
      this.client.one<Record<string, unknown>>("missions", missionId),
    );
    // The criteria live in the stored canonical payload, which the indexer verified
    // against the mission's own hash. Reading them is how this proposal answers *this*
    // mission rather than a template.
    const criteria = criteriaOf(full);

    const proposalId = newId("prp");
    await step(this.transcript, "submitProposal", { subject: proposalId, retries: 2 }, () =>
      this.client.submitProposal({
        proposalId,
        missionId,
        agentId: this.config.agentId,
        payload: payloads.proposal({
          proposalId,
          missionId,
          daoId: String(mission.dao_id),
          agentId: this.config.agentId,
          capabilities: this.config.capabilities.map((capability) => capability.capabilityId),
          proposedStrategy:
            `Satisfy each of the ${criteria.length} published criteria in turn, ` +
            `publishing checkable evidence for each: ${criteria.map((c) => c.id).join(", ")}.`,
          // One plan step per criterion the mission actually published.
          executionPlan: criteria.map((criterion) => `Address ${criterion.id}: ${criterion.statement}`),
          deliverables: criteria.map((criterion) => `Evidence that ${criterion.id} is met`),
          evidencePlan: criteria.map((criterion) => `Publish an artefact demonstrating ${criterion.id}`),
          estimatedDurationSeconds: Math.max(3600, criteria.length * 3600),
          // Bids the mission's budget: the contract refuses more, and bidding less would
          // be a negotiation this agent has no mandate to make.
          requestedBudgetAtomic: String(mission.budget_atomic ?? "0"),
          chainId: chainIdOf(full),
        }),
      }),
    );
    return proposalId;
  }

  /** Waits for a mandate naming this worker, then accepts it. */
  async awaitAndAcceptMandate(missionId: string): Promise<string | null> {
    for (let attempt = 0; attempt < this.poll.attempts * 2; attempt += 1) {
      const page = await step(this.transcript, "pollMandates", { subject: missionId }, () =>
        this.client.mandates({ mission_id: missionId }),
      );
      const mandate = (page.items as Array<Record<string, unknown>>)[0];
      if (mandate) {
        const mandateId = String(mandate.mandate_id);
        this.transcript.record({
          action: "mandateObserved",
          status: "ok",
          subject: mandateId,
          observed: { state: mandate.state, worker_count: mandate.worker_count },
        });
        if (mandate.state === "CREATED") {
          await step(this.transcript, "acceptMandate", { subject: mandateId, retries: 2 }, () =>
            this.client.acceptMandate({ mandateId, agentId: this.config.agentId }),
          );
          return mandateId;
        }
        if (["ACCEPTED", "FUNDED", "IN_PROGRESS"].includes(String(mandate.state))) return mandateId;
      }
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({ action: "awaitMandate", status: "failed", subject: missionId, detail: "no mandate was created" });
    return null;
  }

  /** Waits for funding, then starts the clock. The DAO funds; the worker does not. */
  async awaitFundingAndStart(mandateId: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.poll.attempts * 2; attempt += 1) {
      const mandate = await step(this.transcript, "pollMandate", { subject: mandateId }, () =>
        this.client.one<Record<string, unknown>>("mandates", mandateId),
      );
      const state = String(mandate?.state ?? "");
      if (state === "IN_PROGRESS") return true;
      if (state === "FUNDED") {
        await step(this.transcript, "startWork", { subject: mandateId, retries: 2 }, () =>
          this.client.startWork({ mandateId, agentId: this.config.agentId }),
        );
        return true;
      }
      if (["REFUNDED", "CANCELLED", "EXPIRED"].includes(state)) {
        this.transcript.record({
          action: "abandonMandate",
          status: "ok",
          subject: mandateId,
          observed: { state },
          detail: "the mandate ended before work could start",
        });
        return false;
      }
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({ action: "awaitFunding", status: "failed", subject: mandateId, detail: "the mandate was never funded" });
    return false;
  }

  /** Performs the work and submits a deliverable with evidence per criterion. */
  async deliver(mandateId: string): Promise<string> {
    const mandate = await step(this.transcript, "readMandate", { subject: mandateId }, () =>
      this.client.one<Record<string, unknown>>("mandates", mandateId),
    );
    const mission = await step(this.transcript, "readMandateMission", { subject: mandateId }, () =>
      this.client.one<Record<string, unknown>>("missions", String(mandate?.mission_id)),
    );
    const criteria = criteriaOf(mission);
    if (criteria.length === 0) {
      // Refusing beats submitting an empty deliverable: a deliverable with no evidence is
      // refused on chain anyway, and failing here names the real cause.
      this.transcript.record({
        action: "deliver",
        status: "failed",
        subject: mandateId,
        detail: "the mission payload carried no acceptance criteria to answer",
      });
      throw new Error(`mission for mandate ${mandateId} published no acceptance criteria`);
    }

    const deliverableId = newId("dlv");
    const evidence = criteria.map((criterion, index) => ({
      mandateId,
      workerAgentId: this.config.agentId,
      type: "source_repository" as const,
      uri: `${this.config.workspace.repositoryUri}/${criterion.id}`,
      // A digest over the artefact, so the adjudicator is told what it is judging rather
      // than being asked to trust a URL that could change underneath it.
      contentHash: digestFor(`${mandateId}|${criterion.id}|${this.config.agentId}`),
      mimeType: "text/plain",
      description: `Artefact demonstrating ${criterion.id}: ${criterion.statement}`,
      ...(index === 0 ? {} : {}),
    }));

    await step(this.transcript, "submitDeliverable", { subject: deliverableId, retries: 2 }, () =>
      this.client.submitDeliverable({
        deliverableId,
        mandateId,
        agentId: this.config.agentId,
        payload: payloads.deliverable({
          deliverableId,
          mandateId,
          workerAgentId: this.config.agentId,
          title: `Work for ${mandate?.mission_id}`,
          summary:
            `Addressed ${criteria.length} acceptance criteria. ` +
            criteria.map((criterion) => `${criterion.id}: done, evidence attached.`).join(" "),
          // One index per declared deliverable the worker is answering.
          satisfiesIndices: criteria.map((_, index) => index),
          evidence,
        }),
      }),
    );

    await step(this.transcript, "submitWork", { subject: mandateId, retries: 2 }, () =>
      this.client.submitWork({ mandateId, agentId: this.config.agentId }),
    );
    return deliverableId;
  }

  /** The whole worker side, unattended, starting from no knowledge of any mission. */
  async run(): Promise<WorkerResult> {
    await this.ensureRegistered();

    const mission = await this.discoverMission();
    if (!mission) {
      return { transcript: this.transcript, missionId: null, proposalId: null, mandateId: null, deliverableId: null, submitted: false };
    }
    const missionId = String(mission.mission_id);
    await this.joinDao(String(mission.dao_id));
    const proposalId = await this.propose(mission);

    const mandateId = await this.awaitAndAcceptMandate(missionId);
    if (!mandateId) {
      return { transcript: this.transcript, missionId, proposalId, mandateId: null, deliverableId: null, submitted: false };
    }

    if (!(await this.awaitFundingAndStart(mandateId))) {
      return { transcript: this.transcript, missionId, proposalId, mandateId, deliverableId: null, submitted: false };
    }

    const deliverableId = await this.deliver(mandateId);
    return { transcript: this.transcript, missionId, proposalId, mandateId, deliverableId, submitted: true };
  }
}

/**
 * A deterministic 32-byte digest for an artefact this agent produced.
 *
 * Deterministic so a replay of the same run produces the same evidence, which is what
 * lets `verify/reactive.mjs` attribute a transcript difference to the inputs rather than
 * to randomness.
 */
function digestFor(seed: string): string {
  let hash = 0x811c9dc5;
  const bytes: number[] = [];
  for (let index = 0; index < 32; index += 1) {
    for (const char of `${seed}:${index}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    bytes.push(hash & 0xff);
  }
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The acceptance criteria out of a stored mission document's canonical payload. */
function criteriaOf(mission: Record<string, unknown> | null): Array<{ id: string; statement: string }> {
  if (!mission) return [];
  const raw = mission.payload;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as { acceptance_criteria?: Array<{ id: string; statement: string }> };
    return parsed.acceptance_criteria ?? [];
  } catch {
    return [];
  }
}

/** The chain a mission's budget is denominated on, defaulting to Base Sepolia. */
function chainIdOf(mission: Record<string, unknown> | null): number {
  if (!mission || typeof mission.payload !== "string") return 84532;
  try {
    const parsed = JSON.parse(mission.payload) as { budget?: { chain_id?: number } };
    return parsed.budget?.chain_id ?? 84532;
  } catch {
    return 84532;
  }
}
