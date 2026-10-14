// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Settlement} from "./IWRKSettlementVerifier.sol";

/**
 * @title IWRKEscrow
 * @notice The USDC custody surface for WRK work mandates.
 *
 * Authority: **custody only** (`docs/ARCHITECTURE.md` §1). This contract decides
 * where the money physically is. It does not decide whether work was good, and it
 * does not decide when a decision became final — it is told, by a posting carrying
 * M-of-N attestations the verifier checks against the on-chain record.
 *
 * Lifecycle (`docs/ARCHITECTURE.md` §3.3):
 *
 *   fund ──▶ post ──▶ [1h challenge window] ──▶ execute
 *                │
 *                └──▶ challenge ──▶ (posting voided, adapter re-posts)
 *
 *   fund ──▶ ... ──▶ refundExpired   (liveness escape hatch, funder only, never a payee)
 *
 * `post` and `execute` are separate transactions on purpose: it makes the window
 * observable on-chain rather than enforced by an off-chain delay. An adapter that
 * could fund-and-release in one transaction would make the window advisory.
 */
interface IWRKEscrow {
    /* ── events ──────────────────────────────────────────────────────────── */

    /// @param deposited The amount actually received, which may be less than the amount
    ///        sent if the token takes a transfer fee. The accounting identity uses this.
    event MandateFunded(
        bytes32 indexed mandateId,
        address indexed funder,
        uint256 deposited,
        uint64 refundDeadline,
        uint256 workerCount
    );

    event SettlementPosted(
        bytes32 indexed mandateId,
        bytes32 indexed settlementId,
        bytes32 decisionHash,
        uint16 releaseBp,
        uint64 executableAt
    );

    /// @notice A posting was voided because a competing, equally-attested set of
    ///         parameters was submitted for the same settlementId — a transcription
    ///         mismatch. Never a claim that the decision itself was wrong (I12).
    event SettlementChallenged(
        bytes32 indexed mandateId,
        bytes32 indexed settlementId,
        bytes32 postedParamHash,
        bytes32 competingParamHash,
        address challenger
    );

    event SettlementExecuted(
        bytes32 indexed mandateId,
        bytes32 indexed settlementId,
        uint256 released,
        uint256 refunded
    );

    event PayeePaid(bytes32 indexed settlementId, address indexed payee, uint16 shareBp, uint256 amount);

    event ExpiredRefund(bytes32 indexed mandateId, address indexed funder, uint256 amount);

    /* ── writes ──────────────────────────────────────────────────────────── */

    function fund(
        bytes32 mandateId,
        address[] calldata workers,
        uint256 amount,
        uint64 refundDeadline
    ) external;

    function postSettlement(Settlement calldata settlement, bytes[] calldata signatures) external;

    function challenge(Settlement calldata competing, bytes[] calldata signatures) external;

    function execute(bytes32 settlementId) external;

    function refundExpired(bytes32 mandateId) external;

    /* ── reads ───────────────────────────────────────────────────────────── */

    function heldFor(bytes32 mandateId) external view returns (uint256);

    function activePosting(bytes32 mandateId) external view returns (bytes32);

    function settlementConsumed(bytes32 settlementId) external view returns (bool);

    function isAcceptedWorker(bytes32 mandateId, address account) external view returns (bool);

    function executableAt(bytes32 settlementId) external view returns (uint64);

    function deriveSettlementId(bytes32 mandateId, bytes32 decisionHash, uint256 nonce)
        external
        pure
        returns (bytes32);

    /// @notice True while the contract's USDC balance covers everything it still owes.
    function solvent() external view returns (bool);
}
