/**
 * The read path. Reads serve the MongoDB read model and never touch chain RPC (G5).
 *
 * This module deliberately imports no chain client. That is the enforcement: a read
 * handler cannot block on a slow chain because it has nothing to block on. The UI stays
 * responsive while a network is degraded, and the cost is that a read is as fresh as the
 * indexer's checkpoint — which every response states, so a caller is never guessing.
 */

import { CHAINS, Store, objectQuery, validateDocument, type ChainName, type CollectionName } from "@wrk/indexer";

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface Freshness {
  readonly network: ChainName;
  readonly chain: number;
  /** The highest block whose events are fully indexed, or null if never indexed. */
  readonly indexed_block: number | null;
  /**
   * Blocks between the indexed block and what the indexer last saw as the tip.
   *
   * Reported on every response rather than only on a monitoring endpoint: a caller acting
   * on a read needs to know how old it is, and burying that in a separate call means most
   * callers will not make it.
   */
  readonly stale: boolean;
}

export class ReadModel {
  constructor(private readonly store: Store) {}

  private scope(chain: number): Record<string, unknown> {
    // Every query is scoped by chain. Without this, one API serving two networks returns
    // whichever rows happen to match, and G6's "a Studionet request never returns
    // Bradbury data" would hold only by accident.
    return { "chain_ref.chain": chain };
  }

  async freshness(network: ChainName, nowUnix = Math.floor(Date.now() / 1000)): Promise<Freshness> {
    const chain = CHAINS[network].chainId;
    const checkpoint = await this.store
      .collection("indexer_checkpoints")
      .findOne({ _id: `chain:${chain}` as never });
    const block = checkpoint ? Number(checkpoint.block) : null;
    const observation = await this.store.db.collection("indexer_observations").findOne({ chain });
    const observed = Number(observation?.observed_at_unix ?? 0);
    const head = Number(observation?.observed_head ?? NaN);
    const stale = block === null || !Number.isSafeInteger(head) || observed <= 0 ||
      observed > nowUnix + 30 || nowUnix - observed > 120 ||
      (block !== null && head - block > CHAINS[network].finalityDepth);
    return { network, chain, indexed_block: block, stale };
  }

  async list(
    network: ChainName,
    collection: CollectionName,
    filter: Record<string, unknown> = {},
    limit = 50,
    offset = 0,
  ): Promise<Page<Record<string, unknown>>> {
    const chain = CHAINS[network].chainId;
    const query = { ...filter, ...this.scope(chain) };
    const effectiveLimit = Math.min(Math.max(limit, 1), 200);
    const total = await this.store.collection(collection).countDocuments(query);
    const items = await this.store
      .collection(collection)
      .find(query)
      .sort({ seq: 1, _id: 1 })
      .skip(offset)
      .limit(effectiveLimit)
      .toArray();
    return { items: items.map((item) => validateDocument(collection, item)), total, limit: effectiveLimit, offset };
  }

  async get(
    network: ChainName,
    collection: CollectionName,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const chain = CHAINS[network].chainId;
    const fields: Partial<Record<CollectionName, string>> = {
      agents: "agent_id", daos: "dao_id", missions: "mission_id", proposals: "proposal_id",
      mandates: "mandate_id", deliverables: "deliverable_id", evidence: "evidence_id",
      decisions: "decision_id", settlements: "settlement_id",
    };
    const field = fields[collection];
    const query = objectQuery(id, chain);
    const found = await this.store.collection(collection).findOne(field
      ? { ...this.scope(chain), $or: [query, { [field]: id }] }
      : query);
    return found ? validateDocument(collection, found) : null;
  }

  async count(
    network: ChainName,
    collection: CollectionName,
    filter: Record<string, unknown> = {},
  ): Promise<number> {
    return this.store
      .collection(collection)
      .countDocuments({ ...filter, ...this.scope(CHAINS[network].chainId) });
  }

  /**
   * Protocol health, for the monitoring page.
   *
   * Everything here is a read-model query, so the page renders while a chain is
   * unreachable — and `freshness` is what tells the viewer the numbers may be behind
   * rather than letting a stalled indexer look like a quiet protocol.
   */
  async health(network: ChainName, nowUnix = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
    const freshness = await this.freshness(network, nowUnix);
    const [missionsOpen, mandatesLive, awaitingSettlement, settlementsPosted, agents, daos] =
      await Promise.all([
        this.count(network, "missions", { state: "OPEN" }),
        this.count(network, "mandates", { state: { $in: ["FUNDED", "IN_PROGRESS", "SUBMITTED"] } }),
        this.count(network, "mandates", { state: "ADJUDICATED" }),
        this.count(network, "settlements", { state: "POSTED" }),
        this.count(network, "agents"),
        this.count(network, "daos"),
      ]);
    const chain = CHAINS[network].chainId;
    const [checkpoint, observation, lastExecution, inWindow, overdue, delayed] = await Promise.all([
      this.store.collection("indexer_checkpoints").findOne({ chain }),
      this.store.db.collection("indexer_observations").findOne({ chain }),
      this.store.collection("settlements").findOne({ ...this.scope(chain), state: "EXECUTED" }, { sort: { executed_at_unix: -1 } }),
      this.count(network, "settlements", { state: "POSTED", executable_at_unix: { $gt: nowUnix } }),
      this.count(network, "settlements", { state: "POSTED", executable_at_unix: { $gt: 0, $lte: nowUnix } }),
      this.count(network, "settlements", { state: "POSTED", executable_at_unix: { $gt: 0, $lte: nowUnix - 1200 } }),
    ]);
    const head = Number(observation?.observed_head);
    const observedAt = Number(observation?.observed_at_unix);
    const lastSuccess = Number(lastExecution?.executed_at_unix);
    return {
      network, now_unix: nowUnix,
      checkpoint: {
        chain, indexed_block: freshness.indexed_block,
        observed_head: Number.isSafeInteger(head) ? head : null,
        lag_blocks: Number.isSafeInteger(head) && freshness.indexed_block !== null ? Math.max(0, head - freshness.indexed_block) : null,
        observed_at_unix: Number.isSafeInteger(observedAt) && observedAt > 0 ? observedAt : null,
        block_hash: checkpoint?.block_hash ?? null,
      },
      keeper: {
        last_success_unix: Number.isSafeInteger(lastSuccess) && lastSuccess > 0 ? lastSuccess : null,
        stale_after_seconds: 1200,
        stale: delayed > 0 ? true : Number.isSafeInteger(lastSuccess) && nowUnix - lastSuccess <= 1200 ? false : null,
        source: lastSuccess > 0 ? "indexed_settlement_execution" : null,
      },
      settlements_in_window: inWindow,
      settlements_overdue: overdue,
      freshness,
      agents,
      daos,
      missions_open: missionsOpen,
      mandates_in_flight: mandatesLive,
      mandates_awaiting_settlement: awaitingSettlement,
      settlements_posted: settlementsPosted,
    };
  }

  /**
   * Settlements with their challenge window resolved against a supplied clock.
   *
   * The clock is a parameter so the caller decides what "now" means; a server that used
   * its own would make an overdue settlement look fine to a client whose clock differs.
   */
  async settlementWindows(
    network: ChainName,
    nowUnix: number,
  ): Promise<Array<Record<string, unknown>>> {
    const page = await this.list(network, "settlements", { state: "POSTED" }, 200, 0);
    return page.items.map((settlement) => {
      const executableAt = Number(settlement.executable_at_unix ?? 0);
      return {
        ...settlement,
        seconds_until_executable: executableAt === 0 ? null : executableAt - nowUnix,
        // A keeper is best-effort and GitHub cron can be delayed, so an overdue
        // settlement must be visible rather than silent.
        overdue: executableAt !== 0 && executableAt <= nowUnix,
      };
    });
  }
}
