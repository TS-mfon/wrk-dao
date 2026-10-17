import { parseAbi } from "viem";

// Signatures mirror contracts/base/src; verify/build.mjs compares to its compiler ABI.
const settlement = "struct Settlement { bytes32 settlementId; bytes32 mandateId; bytes32 decisionHash; uint256 nonce; uint16 releaseBp; uint16 refundBp; address[] payees; uint16[] shareBp; uint64 genlayerFinalizedAt; }";

export const WRK_ESCROW_ABI = parseAbi([
  settlement,
  "function CHALLENGE_WINDOW() view returns (uint64)",
  "function verifier() view returns (address)",
  "function usdc() view returns (address)",
  "function heldFor(bytes32 mandateId) view returns (uint256)",
  "function activePosting(bytes32 mandateId) view returns (bytes32)",
  "function settlementConsumed(bytes32 settlementId) view returns (bool)",
  "function isAcceptedWorker(bytes32 mandateId, address account) view returns (bool)",
  "function executableAt(bytes32 settlementId) view returns (uint64)",
  "function mandateOf(bytes32 mandateId) view returns (address funder, uint256 deposited, uint256 released, uint256 refunded, uint64 fundedAt, uint64 refundDeadline, uint32 workerCount, bool exists)",
  "function postingOf(bytes32 settlementId) view returns (bytes32 mandateId, bytes32 decisionHash, bytes32 paramHash, uint256 nonce, uint64 postedAt, uint64 genlayerFinalizedAt, uint16 releaseBp, uint16 refundBp, bool exists)",
  "function payeesOf(bytes32 settlementId) view returns (address[] payees, uint16[] shareBp)",
  "function postSettlement(Settlement settlement, bytes[] signatures)",
  "function execute(bytes32 settlementId)",
  "function challenge(Settlement competing, bytes[] signatures)",
  "function fund(bytes32 mandateId, address[] workers, uint256 amount, uint64 refundDeadline)",
  "event SettlementPosted(bytes32 indexed mandateId, bytes32 indexed settlementId, bytes32 decisionHash, uint16 releaseBp, uint64 executableAt)",
  "event SettlementExecuted(bytes32 indexed mandateId, bytes32 indexed settlementId, uint256 released, uint256 refunded)",
  "event SettlementChallenged(bytes32 indexed mandateId, bytes32 indexed settlementId, bytes32 postedParamHash, bytes32 competingParamHash, address challenger)",
]);

export const WRK_VERIFIER_ABI = parseAbi([
  settlement,
  "function threshold() view returns (uint256)",
  "function attestorCount() view returns (uint256)",
  "function attestors() view returns (address[])",
  "function isAttestor(address account) view returns (bool)",
  "function settlementDigest(Settlement settlement) view returns (bytes32)",
  "function verifySettlement(Settlement settlement, bytes[] signatures) view",
]);
