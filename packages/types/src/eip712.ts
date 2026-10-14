/**
 * Settlement attestation — EIP-712 typed data (docs/ARCHITECTURE.md §8).
 *
 * The domain separator binds `chainId` and `verifyingContract`, so an attestation
 * gathered for Base Sepolia cannot be replayed on mainnet or against a different
 * escrow deployment. That is the whole reason attestations are typed data rather
 * than a bare `keccak256` over concatenated fields.
 *
 * Signatures must arrive with **strictly ascending signer addresses**. That turns
 * duplicate-signer detection into an O(n) scan and closes "the same attestor
 * signs M times to fake a quorum" without a nested loop on-chain. It is checked
 * here so the adapter never submits a set the verifier will reject.
 */

import { hashTypedData, isAddress } from "viem";
import type { Address, Hex, TypedDataDomain } from "viem";
import { fail, describe } from "./errors.js";
import { BP_DENOMINATOR, assertBpPair } from "./money.js";
import { assertBytes32 } from "./hashing.js";

export const SETTLEMENT_DOMAIN_NAME = "WRK Settlement" as const;
export const SETTLEMENT_DOMAIN_VERSION = "1" as const;

/**
 * Field order is load-bearing: it is part of the EIP-712 type hash, so Solidity's
 * `Settlement(...)` string must list the fields in exactly this order.
 */
export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "settlementId", type: "bytes32" },
    { name: "mandateId", type: "bytes32" },
    { name: "decisionHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "releaseBp", type: "uint16" },
    { name: "refundBp", type: "uint16" },
    { name: "payees", type: "address[]" },
    { name: "shareBp", type: "uint16[]" },
    { name: "genlayerFinalizedAt", type: "uint64" },
  ],
} as const;

/** The literal EIP-712 type string, for cross-checking against Solidity. */
export const SETTLEMENT_TYPE_STRING =
  "Settlement(bytes32 settlementId,bytes32 mandateId,bytes32 decisionHash,uint256 nonce," +
  "uint16 releaseBp,uint16 refundBp,address[] payees,uint16[] shareBp,uint64 genlayerFinalizedAt)";

export const EIP712_DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

export interface SettlementMessage {
  readonly settlementId: Hex;
  readonly mandateId: Hex;
  readonly decisionHash: Hex;
  readonly nonce: bigint;
  readonly releaseBp: number;
  readonly refundBp: number;
  readonly payees: readonly Address[];
  readonly shareBp: readonly number[];
  readonly genlayerFinalizedAt: bigint;
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export function settlementDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    fail("EIP712_FIELD", `chainId must be a positive integer, got ${describe(chainId)}`);
  }
  if (!isAddress(verifyingContract, { strict: false })) {
    fail("EIP712_FIELD", `verifyingContract is not an address: ${describe(verifyingContract)}`);
  }
  return {
    name: SETTLEMENT_DOMAIN_NAME,
    version: SETTLEMENT_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

/**
 * Rejects any signer list that is not strictly ascending, which also rejects
 * duplicates. Comparison is numeric on the 160-bit value, so checksum casing
 * cannot change the answer.
 */
export function assertAscendingSigners(signers: readonly Address[]): void {
  if (signers.length === 0) {
    fail("EIP712_SIGNER_ORDER", "at least one attestor signature is required");
  }
  let previous = -1n;
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    if (signer === undefined || !isAddress(signer, { strict: false })) {
      fail("EIP712_FIELD", `signer[${i}] is not an address: ${describe(signer)}`, { index: i });
    }
    const value = BigInt(signer.toLowerCase());
    if (value <= previous) {
      fail(
        "EIP712_SIGNER_ORDER",
        `signers must be strictly ascending; signer[${i}] ${signer} does not exceed its predecessor`,
        { index: i, signer },
      );
    }
    previous = value;
  }
}

/**
 * Validates a settlement message before it is signed or submitted.
 *
 * Every check here is also made on-chain. Doing it twice is deliberate: a
 * rejected transaction costs gas and leaves a confusing trail, and the adapter is
 * the component that must never post garbage.
 */
export function assertSettlementMessage(message: SettlementMessage): void {
  assertBytes32(message.settlementId, "settlementId");
  assertBytes32(message.mandateId, "mandateId");
  assertBytes32(message.decisionHash, "decisionHash");

  if (typeof message.nonce !== "bigint" || message.nonce < 0n || message.nonce > UINT256_MAX) {
    fail("EIP712_FIELD", `nonce must be a uint256 bigint, got ${describe(message.nonce)}`);
  }
  if (
    typeof message.genlayerFinalizedAt !== "bigint" ||
    message.genlayerFinalizedAt < 0n ||
    message.genlayerFinalizedAt > UINT64_MAX
  ) {
    fail(
      "EIP712_FIELD",
      `genlayerFinalizedAt must be a uint64 bigint, got ${describe(message.genlayerFinalizedAt)}`,
    );
  }
  if (message.genlayerFinalizedAt === 0n) {
    // Invariant I1's tripwire: an unfinalized decision has no finality timestamp,
    // and a zero here is the shape a "settle it anyway" bug takes.
    fail("EIP712_FIELD", "genlayerFinalizedAt must be non-zero: a finalized decision has a timestamp");
  }

  assertBpPair(message.releaseBp, message.refundBp);

  if (message.payees.length !== message.shareBp.length) {
    fail(
      "EIP712_FIELD",
      `payees and shareBp must be the same length, got ${message.payees.length} and ${message.shareBp.length}`,
    );
  }

  if (message.payees.length === 0) {
    if (message.releaseBp !== 0) {
      fail("EIP712_FIELD", `releaseBp is ${message.releaseBp} but there are no payees`);
    }
    return;
  }

  let total = 0;
  for (let i = 0; i < message.payees.length; i++) {
    const payee = message.payees[i];
    const share = message.shareBp[i];
    if (payee === undefined || !isAddress(payee, { strict: false })) {
      fail("EIP712_FIELD", `payees[${i}] is not an address: ${describe(payee)}`, { index: i });
    }
    if (payee.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      fail("EIP712_FIELD", `payees[${i}] is the zero address`, { index: i });
    }
    if (share === undefined || !Number.isInteger(share) || share < 0 || share > BP_DENOMINATOR) {
      fail("EIP712_FIELD", `shareBp[${i}] must be within 0..${BP_DENOMINATOR}, got ${describe(share)}`, {
        index: i,
      });
    }
    total += share;
  }
  if (total !== BP_DENOMINATOR) {
    fail("EIP712_FIELD", `shareBp must sum to ${BP_DENOMINATOR} exactly, got ${total}`, { total });
  }

  // Invariant I6 support: the same payee twice is the shape of a double payment.
  const seen = new Set<string>();
  for (const payee of message.payees) {
    const key = payee.toLowerCase();
    if (seen.has(key)) {
      fail("EIP712_FIELD", `payee ${payee} appears more than once`);
    }
    seen.add(key);
  }
}

/**
 * The EIP-712 digest an attestor signs: `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)`.
 *
 * `verify/eip712.mjs` derives the same value from keccak256 and abi encoding
 * alone and compares, so this and the Solidity verifier cannot quietly disagree.
 */
export function settlementDigest(
  domain: TypedDataDomain,
  message: SettlementMessage,
  options: { readonly validate?: boolean } = {},
): Hex {
  if (options.validate !== false) assertSettlementMessage(message);
  return hashTypedData({
    domain,
    types: SETTLEMENT_TYPES,
    primaryType: "Settlement",
    message: message as unknown as Record<string, unknown>,
  } as Parameters<typeof hashTypedData>[0]);
}
