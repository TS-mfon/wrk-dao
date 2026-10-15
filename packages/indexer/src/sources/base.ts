/**
 * Base (EVM) log source.
 *
 * Reads `WRKEscrow` and `WRKSettlementVerifier` logs with viem and decodes them into the
 * catalogue's shape. Topic 0 is the keccak of the Solidity event signature, so decoding is
 * a lookup against the ABI rather than guesswork.
 */

import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type Abi,
  type Log,
} from "viem";
import type { DecodedEvent } from "../events.js";
import { byChainOrder, type ChainSource } from "./source.js";

/**
 * The events this read model consumes from Base, as a minimal ABI.
 *
 * Deliberately not the full contract ABI: the indexer should break loudly if an event it
 * depends on changes shape, and a narrow ABI is what makes that happen at decode time
 * rather than silently producing a document with missing fields.
 */
export const BASE_EVENT_ABI = parseAbi([
  "event MandateFunded(bytes32 indexed mandateId, address indexed funder, uint256 amount)",
  "event SettlementPosted(bytes32 indexed settlementId, bytes32 indexed mandateId, bytes32 decisionHash, uint16 releaseBp, uint16 refundBp, uint64 postedAt, uint64 executableAt)",
  "event SettlementChallenged(bytes32 indexed settlementId, bytes32 indexed mandateId, address indexed challenger, string reason)",
  "event SettlementExecuted(bytes32 indexed settlementId, bytes32 indexed mandateId, uint256 released, uint256 refunded, uint64 executedAt)",
  "event PayeePaid(bytes32 indexed settlementId, address indexed payee, uint16 shareBp, uint256 amount)",
  "event ExpiredRefund(bytes32 indexed mandateId, address indexed funder, uint256 amount)",
]) satisfies Abi;

export interface BaseSourceOptions {
  readonly chainId: number;
  readonly rpcUrl: string;
  /** Addresses to read logs from: the escrow and the verifier. */
  readonly addresses: readonly `0x${string}`[];
}

export class BaseSource implements ChainSource {
  readonly kind = "evm" as const;
  readonly chainId: number;
  private readonly client: ReturnType<typeof createPublicClient>;
  private readonly addresses: readonly `0x${string}`[];

  constructor(options: BaseSourceOptions) {
    this.chainId = options.chainId;
    this.addresses = options.addresses;
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  async tip(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  async blockHash(block: number): Promise<string | null> {
    try {
      const found = await this.client.getBlock({ blockNumber: BigInt(block) });
      return found.hash.toLowerCase();
    } catch {
      return null;
    }
  }

  async logs(from: number, to: number): Promise<DecodedEvent[]> {
    const raw = await this.client.getLogs({
      address: this.addresses as `0x${string}`[],
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    const out: DecodedEvent[] = [];
    for (const log of raw) out.push(...decodeBaseLog(log, this.chainId));
    return out.sort(byChainOrder);
  }
}

/** Decodes one EVM log, or nothing if it is an event the read model does not consume. */
export function decodeBaseLog(log: Log, chainId: number): DecodedEvent[] {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: BASE_EVENT_ABI,
      data: log.data,
      topics: log.topics,
    }) as { eventName: string; args: Record<string, unknown> };
  } catch {
    // Not one of ours. Returning nothing rather than throwing is right here, and only
    // here: the escrow may emit ERC-20 or ownership events this model has no interest in.
    // An event from our own catalogue that fails to decode still throws, below.
    return [];
  }

  if (
    log.blockNumber === null ||
    log.transactionHash === null ||
    log.logIndex === null ||
    log.blockHash === null
  ) {
    throw new Error(`log for ${decoded.eventName} is pending: it has no block or index yet`);
  }

  const indexedNames = indexedFieldsOf(decoded.eventName);
  const indexed: Record<string, string> = {};
  const blob: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(decoded.args)) {
    const text = typeof value === "bigint" ? value.toString(10) : String(value);
    if (indexedNames.includes(name)) indexed[name] = text.toLowerCase();
    else blob[name] = text;
  }

  return [
    {
      name: decoded.eventName,
      source: "base",
      indexed,
      blob,
      ref: {
        chain: chainId,
        tx_hash: log.transactionHash.toLowerCase(),
        block: Number(log.blockNumber),
        log_index: Number(log.logIndex),
        block_hash: log.blockHash.toLowerCase(),
      },
    },
  ];
}

function indexedFieldsOf(eventName: string): string[] {
  for (const entry of BASE_EVENT_ABI) {
    if (entry.type === "event" && entry.name === eventName) {
      // `indexed` is absent from non-indexed inputs in the narrowed ABI type, so it is
      // read structurally rather than as a declared property.
      return entry.inputs
        .filter((input) => (input as { indexed?: boolean }).indexed === true)
        .map((input) => input.name ?? "");
    }
  }
  throw new Error(`no ABI entry for event ${eventName}`);
}
