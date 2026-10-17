/**
 * The commissioner: an agent that publishes work and takes it to settlement.
 *
 * It uses `@wrk/sdk` and nothing else. No database client, no chain client, no key beyond
 * its own signer — `scripts/verify-agents-api-only.mjs` enforces that from the dependency
 * graph, because an agent that reached past the API would prove a privileged script can
 * drive the contracts rather than that the API is sufficient.
 *
 * It reacts to what the API returns. Where it must wait for something another party does —
 * a proposal arriving, a worker accepting — it polls and decides from the response, which
 * is why two runs against different missions produce different transcripts.
 */

import { payloads, newId, type WrkClient } from "@wrk/sdk";
import { Transcript, step } from "../transcript.js";

export interface CommissionerConfig {
  readonly agentId: string;
  readonly name: string;
  readonly operator: string;
  readonly daoId?: string;
  /** What the commissioner wants done, and what it will accept as done. */
  readonly brief: {
    readonly title: string;
    readonly outcome: string;
    readonly criteria: readonly { id: string; statement: string; weightBp: number }[];
    readonly budgetAtomic: string;
    readonly evidenceRequirements: readonly string[];
  };
  readonly chainId: number;
  readonly deadlineUnix: number;
  /** How long to wait for the other side, and how often to look. */
  readonly poll?: { readonly attempts: number; readonly intervalMs: number };
}

export interface CommissionerResult {
  readonly transcript: Transcript;
  readonly daoId: string;
  readonly missionId: string;
  readonly selectedProposalId: string | null;
  readonly mandateId: string | null;
  readonly settled: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Commissioner {
  readonly transcript: Transcript;

  constructor(
    private readonly client: WrkClient,
    private readonly config: CommissionerConfig,
  ) {
    this.transcript = new Transcript(`commissioner:${config.agentId}`);
  }

  private get poll() {
    return this.config.poll ?? { attempts: 20, intervalMs: 150 };
  }

  /** Registers, if the registry does not already know this agent. */
  async ensureRegistered(): Promise<void> {
    const existing = await step(this.transcript, "readAgent", { subject: this.config.agentId }, () =>
      this.client.one("agents", this.config.agentId),
    );
    if (existing) {
      this.transcript.record({
        action: "register",
        status: "skipped",
        subject: this.config.agentId,
        detail: "already registered",
      });
      return;
    }
    await step(this.transcript, "registerAgent", { subject: this.config.agentId, retries: 2 }, () =>
      this.client.registerAgent({
        agentId: this.config.agentId,
        profile: payloads.agentProfile({
          agentId: this.config.agentId,
          name: this.config.name,
          operator: this.config.operator,
          capabilities: [
            {
              capabilityId: "work-commissioning",
              name: "Work commissioning",
              description: "Publishes missions and takes them through to settlement.",
              version: "1",
              evidence: "https://example.com/wrk/commissioner",
            },
          ],
        }),
      }),
    );
  }

  /** Creates the DAO this work will live in, unless one was supplied. */
  async ensureDao(): Promise<string> {
    if (this.config.daoId) {
      const found = await step(this.transcript, "readDao", { subject: this.config.daoId }, () =>
        this.client.one("daos", this.config.daoId!),
      );
      if (found) return this.config.daoId;
    }
    const daoId = this.config.daoId ?? newId("dao");
    await step(this.transcript, "createDao", { subject: daoId, retries: 2 }, () =>
      this.client.createDao({
        daoId,
        creatorAgentId: this.config.agentId,
        metadata: payloads.daoMetadata({
          daoId,
          name: `${this.config.name} DAO`,
          purpose: this.config.brief.outcome,
          creatorAgentId: this.config.agentId,
        }),
        rules: payloads.daoRules({
          daoId,
          // The cap is derived from the brief rather than fixed: a DAO whose cap is below
          // its own mission's budget would refuse the mission it was created for.
          maxMissionBudgetAtomic: this.config.brief.budgetAtomic,
          minAcceptanceCriteria: Math.min(this.config.brief.criteria.length, 2),
          membership: "open",
        }),
      }),
    );
    return daoId;
  }

  async publishMission(daoId: string): Promise<string> {
    const missionId = newId("msn");
    await step(this.transcript, "createMission", { subject: missionId, retries: 2 }, () =>
      this.client.createMission({
        missionId,
        daoId,
        creatorAgentId: this.config.agentId,
        payload: payloads.mission({
          missionId,
          daoId,
          creatorAgentId: this.config.agentId,
          title: this.config.brief.title,
          outcomeStatement: this.config.brief.outcome,
          criteria: this.config.brief.criteria,
          budgetAtomic: this.config.brief.budgetAtomic,
          chainId: this.config.chainId,
          deadlineUnix: this.config.deadlineUnix,
          evidenceRequirements: this.config.brief.evidenceRequirements,
        }),
      }),
    );
    await step(this.transcript, "openMission", { subject: missionId, retries: 2 }, () =>
      this.client.openMission({ missionId, creatorAgentId: this.config.agentId }),
    );
    return missionId;
  }

  /**
   * Waits for proposals, then closes.
   *
   * Decides from what the API reports rather than from a fixed sleep: the number of
   * proposals it saw is recorded, and it is why a run against a mission with two
   * proposals differs from one with a single proposal.
   */
  async awaitProposals(missionId: string, atLeast = 1): Promise<number> {
    for (let attempt = 0; attempt < this.poll.attempts; attempt += 1) {
      const page = await step(
        this.transcript,
        "pollProposals",
        { subject: missionId },
        () => this.client.proposals({ mission_id: missionId }),
      );
      if (page.total >= atLeast) {
        this.transcript.record({
          action: "proposalsReady",
          status: "ok",
          subject: missionId,
          observed: { proposals: page.total },
        });
        return page.total;
      }
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({
      action: "awaitProposals",
      status: "failed",
      subject: missionId,
      detail: `no proposal arrived within ${this.poll.attempts} polls`,
    });
    throw new Error(`mission ${missionId} received no proposal`);
  }

  async closeAndSelect(missionId: string): Promise<void> {
    await step(this.transcript, "closeProposals", { subject: missionId, retries: 2 }, () =>
      this.client.closeProposals({ missionId, creatorAgentId: this.config.agentId }),
    );
    await step(this.transcript, "startSelection", { subject: missionId, retries: 2 }, () =>
      this.client.startSelection({ missionId, creatorAgentId: this.config.agentId }),
    );
  }

  /** Waits for the adjudicator's selection to reach the mission. */
  async awaitSelection(missionId: string): Promise<{ proposalId: string; decisionHash: string } | null> {
    for (let attempt = 0; attempt < this.poll.attempts; attempt += 1) {
      const mission = await step(this.transcript, "pollMission", { subject: missionId }, () =>
        this.client.one<Record<string, unknown>>("missions", missionId),
      );
      const proposalId = mission?.selected_proposal_id as string | null;
      const decisionHash = mission?.selection_decision_hash as string | null;
      if (proposalId && decisionHash) {
        this.transcript.record({
          action: "selectionObserved",
          status: "ok",
          subject: missionId,
          observed: { selected_proposal_id: proposalId, state: mission?.state },
        });
        return { proposalId, decisionHash };
      }
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({
      action: "awaitSelection",
      status: "failed",
      subject: missionId,
      detail: "no selection was recorded; the adjudicator may not have run",
    });
    return null;
  }

  /**
   * Creates the mandate from the proposal that was actually selected.
   *
   * The workers and shares come from the selected proposal, not from the commissioner's
   * preference: the contract refuses a mandate that pays anyone else, which is what stops
   * selection from being decorative.
   */
  async createMandate(input: {
    missionId: string;
    daoId: string;
    proposalId: string;
    decisionHash: string;
  }): Promise<string> {
    const proposal = await step(this.transcript, "readSelectedProposal", { subject: input.proposalId }, () =>
      this.client.one<Record<string, unknown>>("proposals", input.proposalId),
    );
    if (!proposal) throw new Error(`selected proposal ${input.proposalId} is not readable`);

    const workerAgentId = proposal.agent_id as string;
    const mandateId = newId("mnd");
    await step(this.transcript, "createMandate", { subject: mandateId, retries: 2 }, () =>
      this.client.createMandate({
        mandateId,
        missionId: input.missionId,
        creatorAgentId: this.config.agentId,
        payload: payloads.mandate({
          mandateId,
          daoId: input.daoId,
          missionId: input.missionId,
          creatorAgentId: this.config.agentId,
          workers: [{ agentId: workerAgentId, shareBp: 10_000 }],
          objective: this.config.brief.outcome,
          deliverables: this.config.brief.criteria.map((criterion) => criterion.statement),
          budgetAtomic: proposal.requested_budget_atomic as string,
          chainId: this.config.chainId,
          deadlineUnix: this.config.deadlineUnix,
          criteria: this.config.brief.criteria,
          evidenceRequirements: this.config.brief.evidenceRequirements,
          proposalHash: proposal.proposal_hash as string,
          selectionDecisionHash: input.decisionHash,
        }),
      }),
    );
    return mandateId;
  }

  /** Watches a mandate to a terminal state, reporting what it reached. */
  async awaitSettlement(mandateId: string): Promise<string> {
    const terminal = new Set(["SETTLED", "REFUNDED", "EXPIRED", "CANCELLED"]);
    let last = "";
    for (let attempt = 0; attempt < this.poll.attempts * 2; attempt += 1) {
      const mandate = await step(this.transcript, "pollMandate", { subject: mandateId }, () =>
        this.client.one<Record<string, unknown>>("mandates", mandateId),
      );
      const state = String(mandate?.state ?? "");
      if (state !== last) {
        this.transcript.record({
          action: "mandateState",
          status: "ok",
          subject: mandateId,
          observed: { state, decision_hash: mandate?.decision_hash ?? null },
        });
        last = state;
      }
      if (terminal.has(state)) return state;
      await sleep(this.poll.intervalMs);
    }
    this.transcript.record({
      action: "awaitSettlement",
      status: "failed",
      subject: mandateId,
      detail: `mandate stopped at ${last || "unknown"}`,
    });
    return last;
  }

  /** The whole commissioner side, unattended. */
  async run(): Promise<CommissionerResult> {
    await this.ensureRegistered();
    const daoId = await this.ensureDao();
    const missionId = await this.publishMission(daoId);
    await this.awaitProposals(missionId);
    await this.closeAndSelect(missionId);

    const selection = await this.awaitSelection(missionId);
    if (!selection) {
      return { transcript: this.transcript, daoId, missionId, selectedProposalId: null, mandateId: null, settled: false };
    }

    const mandateId = await this.createMandate({
      missionId,
      daoId,
      proposalId: selection.proposalId,
      decisionHash: selection.decisionHash,
    });
    const finalState = await this.awaitSettlement(mandateId);

    return {
      transcript: this.transcript,
      daoId,
      missionId,
      selectedProposalId: selection.proposalId,
      mandateId,
      settled: finalState === "SETTLED",
    };
  }
}
