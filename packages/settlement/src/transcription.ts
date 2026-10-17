import {
  assertBytes32, assertSettlementMessage, canonicalize, contentHash, parseDecisionPayload,
  parseId, parseMandatePayload, settlementId, settlementDigest, toBytes32,
  type DecisionPayload, type MandatePayload, type SettlementMessage,
} from "@wrk/types";
import { isAddress, zeroAddress, type Address, type TypedDataDomain } from "viem";
import { SETTLEMENT_NONCE, type FinalizedDecisionSnapshot } from "./model.js";
import { SettlementError, requireSettlement } from "./errors.js";

function parseCanonical<T>(text: string, parse: (value: unknown) => T, label: string): T {
  try {
    const raw: unknown = JSON.parse(text);
    requireSettlement(canonicalize(raw) === text, "INVALID_DECISION", `${label} is not canonical JSON`);
    return parse(raw);
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    throw new SettlementError("INVALID_DECISION", `${label} fails the canonical payload schema`, { cause: error });
  }
}

export interface Transcription {
  readonly message: SettlementMessage;
  readonly decision: DecisionPayload;
  readonly mandate: MandatePayload;
  readonly workers: readonly Address[];
}

/** Copies decision numbers and allocation order verbatim. No economic arithmetic belongs here. */
export function transcribeFinalizedDecision(snapshot: FinalizedDecisionSnapshot): Transcription {
  const { reference, receipt } = snapshot;
  parseId(reference.mandateId, "mnd");
  assertBytes32(reference.transactionHash, "GenLayer transaction ID");
  requireSettlement(receipt.status === "FINALIZED", "NOT_FINALIZED", "GenLayer transaction is not finalized");
  requireSettlement(receipt.executionResult === "FINISHED_WITH_RETURN", "EXECUTION_FAILED", "Finalized transaction did not execute successfully");
  requireSettlement(
    receipt.transactionHash.toLowerCase() === reference.transactionHash.toLowerCase()
      && receipt.recipient.toLowerCase() === snapshot.adjudicatorAddress.toLowerCase()
      && receipt.mandateId === reference.mandateId
      && (receipt.functionName === "adjudicate" || receipt.functionName === "confirm_finality"),
    "TRANSACTION_MISMATCH", "Receipt does not belong to this adjudicator and mandate",
  );
  requireSettlement(snapshot.decisionState === "FINALIZED", "NOT_FINALIZED", "Adjudicator decision is not finalized");
  requireSettlement(snapshot.finalizedAt > 0n, "NOT_FINALIZED", "Finalized decision has no finality timestamp");

  const decision = parseCanonical(snapshot.decisionJson, parseDecisionPayload, "Decision");
  const mandate = parseCanonical(snapshot.mandateJson, parseMandatePayload, "Mandate");
  requireSettlement(
    mandate.mandate_id === reference.mandateId && decision.mandate_id === mandate.mandate_id
      && decision.decision_id === snapshot.decisionId,
    "MANDATE_MISMATCH", "Finalized decision identity does not match the mandate",
  );
  requireSettlement(
    contentHash(decision) === assertBytes32(snapshot.decisionHash)
      && contentHash(decision) === assertBytes32(snapshot.mandateDecisionHash),
    "TRANSCRIPTION_MISMATCH", "Decision content hash disagrees with the finalized chain record",
  );
  requireSettlement(contentHash(mandate) === assertBytes32(snapshot.mandateHash), "MANDATE_MISMATCH", "Mandate hash disagrees with its finalized chain record");
  requireSettlement(
    ["ADJUDICATED", "SETTLED", "REFUNDED"].includes(snapshot.mandateState),
    "NOT_FINALIZED", "Work contract has not recorded a final adjudication",
  );
  requireSettlement(BigInt(decision.adjudicated_at_unix) <= snapshot.finalizedAt, "NOT_FINALIZED", "Finality timestamp precedes adjudication");
  requireSettlement(snapshot.workers.length === mandate.workers.length, "PAYEE_MISMATCH", "Incomplete finalized worker set");

  const addresses = new Map<string, Address>();
  const unique = new Set<string>();
  for (const worker of snapshot.workers) {
    requireSettlement(
      worker.accepted === true && mandate.workers.some((item) => item.agent_id === worker.agentId)
        && !addresses.has(worker.agentId),
      "PAYEE_MISMATCH", "Worker is not an accepted member of this mandate",
    );
    requireSettlement(
      isAddress(worker.address, { strict: false }) && worker.address.toLowerCase() !== zeroAddress
        && !unique.has(worker.address.toLowerCase()),
      "PAYEE_MISMATCH", "Worker operator is missing, zero, or duplicated",
    );
    addresses.set(worker.agentId, worker.address);
    unique.add(worker.address.toLowerCase());
  }
  const payees = decision.allocations.map((allocation) => {
    const address = addresses.get(allocation.agent_id);
    requireSettlement(address, "PAYEE_MISMATCH", "Decision allocates to someone outside the accepted mandate");
    return address;
  });
  const mandateId = toBytes32(mandate.mandate_id);
  const decisionHash = contentHash(decision);
  const message: SettlementMessage = Object.freeze({
    settlementId: settlementId(mandateId, decisionHash, SETTLEMENT_NONCE),
    mandateId, decisionHash, nonce: SETTLEMENT_NONCE,
    releaseBp: decision.release_bp,
    refundBp: decision.refund_bp,
    payees: Object.freeze(payees),
    shareBp: Object.freeze(decision.allocations.map((allocation) => allocation.share_bp)),
    genlayerFinalizedAt: snapshot.finalizedAt,
  });
  assertSettlementMessage(message);
  return Object.freeze({ message, decision, mandate, workers: Object.freeze([...addresses.values()]) });
}

/** A discrepancy is a refusal, including a seemingly more generous or better-rounded payout. */
export function assertExactTranscription(expected: SettlementMessage, actual: SettlementMessage, domain: TypedDataDomain): void {
  requireSettlement(
    settlementDigest(domain, expected) === settlementDigest(domain, actual),
    "TRANSCRIPTION_MISMATCH", "Posted settlement differs from the finalized decision",
  );
}
