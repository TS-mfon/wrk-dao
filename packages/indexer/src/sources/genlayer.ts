/**
 * GenLayer log source.
 *
 * GenLayer events are emitted through `emit_raw_event(topics, blob)`: topic 0 is
 * `keccak256(signature)` where the signature is `Name(indexed,names,sorted)`, later topics
 * are the indexed values, and the blob carries the rest. Decoding is therefore a lookup
 * from topic 0 to a known signature — which means the signature table below has to match
 * the contracts, and `verify/events.mjs` checks that it does rather than trusting it.
 *
 * Note on the signature: the indexed field names in it are **alphabetically sorted**,
 * because the SDK sorts them (see BUGS.md BUG-014). A table built in declaration order
 * would compute the wrong topic 0 and silently match nothing.
 */

import { keccak256, toHex } from "viem";
import type { DecodedEvent } from "../events.js";
import { byChainOrder, type ChainSource } from "./source.js";

/** Event name to its indexed field names, in the sorted order the SDK uses. */
export const GENLAYER_EVENT_INDEXED: Record<string, readonly string[]> = {
  AgentRegistered: ["agent_id"],
  AgentProfileUpdated: ["agent_id"],
  DaoCreated: ["dao_id"],
  DaoRulesUpdated: ["dao_id"],
  MemberJoined: ["agent_id", "dao_id"],
  MissionCreated: ["mission_id"],
  MissionUpdated: ["mission_id"],
  MissionStateChanged: ["mission_id"],
  ProposalSubmitted: ["proposal_id"],
  SelectionRecorded: ["mission_id"],
  MandateCreated: ["mandate_id"],
  MandateAccepted: ["agent_id", "mandate_id"],
  MandateStateChanged: ["mandate_id"],
  DeliverableSubmitted: ["deliverable_id"],
  EvidenceRecorded: ["evidence_id"],
  AdjudicationRecorded: ["mandate_id"],
  CustodyRelayed: ["mandate_id"],
  SelectionDecided: ["mission_id"],
  DecisionRecorded: ["mandate_id"],
  DecisionFinalized: ["mandate_id"],
  ReputationRecorded: ["agent_id", "dao_id"],
};

/** `Name(a,b)` with the indexed names sorted, exactly as the SDK builds it. */
export function signatureOf(name: string): string {
  const indexed = GENLAYER_EVENT_INDEXED[name];
  if (!indexed) throw new Error(`no indexed-field table entry for GenLayer event ${name}`);
  return `${name}(${[...indexed].sort().join(",")})`;
}

export function topic0Of(name: string): string {
  return keccak256(toHex(signatureOf(name))).toLowerCase();
}

/** topic 0 to event name, built once. */
const BY_TOPIC = new Map(
  Object.keys(GENLAYER_EVENT_INDEXED).map((name) => [topic0Of(name), name] as const),
);

export interface GenLayerRawLog {
  readonly topics: readonly string[];
  /** The event blob, already decoded from calldata into named fields by the node. */
  readonly blob: Readonly<Record<string, string | number | boolean>>;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
}

/**
 * Decodes one GenLayer log.
 *
 * Indexed values arrive as topics, and a topic is 32 bytes: a value longer than that was
 * hashed by the SDK before being placed there, so it cannot be recovered. Every indexed
 * field in this protocol is an id of at most 30 characters, which fits — and if one ever
 * does not, this throws rather than storing a hash where an id belongs.
 */
export function decodeGenLayerLog(log: GenLayerRawLog, chainId: number): DecodedEvent[] {
  const topic0 = (log.topics[0] ?? "").toLowerCase();
  const name = BY_TOPIC.get(topic0);
  if (!name) return [];

  const names = [...(GENLAYER_EVENT_INDEXED[name] ?? [])].sort();
  const indexed: Record<string, string> = {};
  names.forEach((field, position) => {
    const topic = log.topics[position + 1];
    if (topic === undefined) {
      throw new Error(`${name} is missing topic ${position + 1} for indexed field ${field}`);
    }
    // The SDK right-pads a short calldata value with zero bytes, so the id is the
    // printable prefix. A value that was hashed instead would not be printable, which is
    // what the check below catches.
    const text = fromTopic(topic);
    if (!/^[\x20-\x7e]+$/.test(text)) {
      throw new Error(
        `${name}.${field} does not round-trip from its topic — the value was longer than 32 bytes and was hashed`,
      );
    }
    indexed[field] = text;
  });

  const blob: Record<string, string | number | boolean> = {};
  for (const [field, value] of Object.entries(log.blob)) {
    if (!names.includes(field)) blob[field] = value;
  }
  // The SDK puts indexed fields in the blob too; the topic is authoritative for them.
  for (const [field, value] of Object.entries(indexed)) blob[field] = value;

  return [
    {
      name,
      source: "genlayer",
      indexed,
      blob,
      ref: {
        chain: chainId,
        tx_hash: log.transactionHash.toLowerCase(),
        block: log.blockNumber,
        log_index: log.logIndex,
        block_hash: log.blockHash.toLowerCase(),
      },
    },
  ];
}

/** Strips calldata framing and trailing zero padding from a 32-byte topic. */
function fromTopic(topic: string): string {
  const bytes = Buffer.from(topic.replace(/^0x/, ""), "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const trimmed = bytes.subarray(0, end);
  // Calldata encodes a string with a leading length/marker byte sequence; the id itself is
  // the printable tail, so take the longest printable suffix run.
  const text = trimmed.toString("latin1");
  const match = /[\x20-\x7e]+$/.exec(text);
  return match ? match[0] : text;
}

export interface GenLayerSourceOptions {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly addresses: readonly string[];
  /** Injected so the transport can be replaced in tests without a live network. */
  readonly fetchLogs?: (from: number, to: number) => Promise<GenLayerRawLog[]>;
  readonly fetchTip?: () => Promise<number>;
  readonly fetchBlockHash?: (block: number) => Promise<string | null>;
}

export class GenLayerSource implements ChainSource {
  readonly kind = "genlayer" as const;
  readonly chainId: number;

  constructor(private readonly options: GenLayerSourceOptions) {
    this.chainId = options.chainId;
  }

  async tip(): Promise<number> {
    if (this.options.fetchTip) return this.options.fetchTip();
    return Number(await this.rpc("eth_blockNumber", []));
  }

  async blockHash(block: number): Promise<string | null> {
    if (this.options.fetchBlockHash) return this.options.fetchBlockHash(block);
    const found = (await this.rpc("eth_getBlockByNumber", [
      `0x${block.toString(16)}`,
      false,
    ])) as { hash?: string } | null;
    return found?.hash ? found.hash.toLowerCase() : null;
  }

  async logs(from: number, to: number): Promise<DecodedEvent[]> {
    const raw = this.options.fetchLogs
      ? await this.options.fetchLogs(from, to)
      : ((await this.rpc("eth_getLogs", [
          {
            address: this.options.addresses,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ])) as GenLayerRawLog[]);

    const out: DecodedEvent[] = [];
    for (const log of raw) out.push(...decodeGenLayerLog(log, this.chainId));
    return out.sort(byChainOrder);
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) {
      throw new Error(`${method} on ${this.options.rpcUrl} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
    return body.result;
  }
}
