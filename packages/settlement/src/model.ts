import type { Address, Hex, TypedDataDomain } from "viem";
import type { SettlementMessage } from "@wrk/types";

export const CHALLENGE_WINDOW_SECONDS = 3600n;
/** One immutable decision per mandate in the deployed protocol. Never increment on retry. */
export const SETTLEMENT_NONCE = 0n;

export interface DecisionReference {
  readonly mandateId: string;
  /** GenLayer protocol transaction ID, not the outer EVM submission hash. */
  readonly transactionHash: Hex;
}

export interface FinalityReceipt {
  readonly transactionHash: Hex;
  readonly recipient: Address;
  /** Exact materialized status, not a projected lifecycle action. */
  readonly status: "FINALIZED";
  readonly executionResult: "FINISHED_WITH_RETURN";
  readonly functionName: "adjudicate" | "confirm_finality";
  readonly mandateId: string;
}

export interface ChainWorker {
  readonly agentId: string;
  readonly address: Address;
  readonly accepted: boolean;
}

/** Every field is obtained from finalized GenLayer state by GenLayerDecisionSource. */
export interface FinalizedDecisionSnapshot {
  readonly reference: DecisionReference;
  readonly receipt: FinalityReceipt;
  readonly adjudicatorAddress: Address;
  readonly decisionId: string;
  readonly decisionState: string;
  readonly decisionJson: string;
  readonly decisionHash: Hex;
  readonly finalizedAt: bigint;
  readonly mandateJson: string;
  readonly mandateHash: Hex;
  readonly mandateState: string;
  readonly mandateDecisionHash: Hex;
  readonly workers: readonly ChainWorker[];
}

export interface GenLayerSettlementVerifier {
  /** Must not resolve for Accepted, timeout outcomes, projected Finalize, or failed execution. */
  waitForFinalization(reference: DecisionReference): Promise<FinalityReceipt>;
  readFinalizedDecision(reference: DecisionReference, receipt: FinalityReceipt): Promise<FinalizedDecisionSnapshot>;
}

export interface BaseConfiguration {
  readonly chainId: number;
  readonly escrow: Address;
  readonly verifier: Address;
  readonly challengeWindow: bigint;
  readonly threshold: number;
  readonly attestors: readonly Address[];
}

export interface BaseMandate {
  readonly exists: boolean;
  readonly deposited: bigint;
  readonly released: bigint;
  readonly refunded: bigint;
  readonly workerCount: number;
  readonly funder: Address;
  /** Queried for all finalized mandate workers, not only allocated workers. */
  readonly acceptedWorkers: readonly Address[];
}

export interface BasePosting {
  readonly message: SettlementMessage;
  readonly postedAt: bigint;
  readonly executableAt: bigint;
}

export interface BaseSettlementState {
  readonly mandateId: Hex;
  readonly settlementId: Hex;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly activePosting: Hex | null;
  readonly consumed: boolean;
  readonly posting: BasePosting | null;
}

export interface BaseReceipt {
  readonly transactionHash: Hex;
  readonly status: "success" | "reverted";
}

/** Chain-only custody port. The production implementation uses viem. */
export interface BaseSettlement {
  configuration(): Promise<BaseConfiguration>;
  readMandate(mandateId: Hex, workers: readonly Address[]): Promise<BaseMandate>;
  readSettlement(settlementId: Hex, mandateId?: Hex): Promise<BaseSettlementState>;
  postSettlement(message: SettlementMessage, signatures: readonly Hex[]): Promise<Hex>;
  execute(settlementId: Hex): Promise<Hex>;
  waitForReceipt(transactionHash: Hex): Promise<BaseReceipt>;
  findTransaction(settlementId: Hex, action: "post" | "execute"): Promise<Hex | undefined>;
  /** Scan canonical Base logs; replaying from deployment is deliberately safe. */
  postedSettlementIds(fromBlock?: bigint, toBlock?: bigint): AsyncIterable<Hex>;
}

export interface SettlementAttestor {
  readonly address: Address;
  sign(message: SettlementMessage, domain: TypedDataDomain): Promise<Hex>;
}

export interface SettlementResult {
  readonly state: "posted" | "already-posted" | "already-executed";
  readonly message: SettlementMessage;
  readonly transactionHash?: Hex;
  readonly executableAt: bigint;
}

export interface KeeperResult {
  readonly settlementId: Hex;
  readonly state: "executed" | "already-executed" | "waiting" | "inactive";
  readonly transactionHash?: Hex;
  readonly executableAt?: bigint;
}
