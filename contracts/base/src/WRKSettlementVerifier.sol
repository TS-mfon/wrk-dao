// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IWRKSettlementVerifier, Settlement} from "./interfaces/IWRKSettlementVerifier.sol";

/**
 * @title WRKSettlementVerifier
 * @notice Checks that a settlement carries M-of-N attestor signatures over exactly these
 *         parameters, for this chain, for this contract.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * What this contract is and is not
 * ──────────────────────────────────────────────────────────────────────────────
 * It holds **no funds and no judgment** (`docs/ARCHITECTURE.md` §1). It answers one
 * question and reverts if the answer is no. It cannot change a decision's numbers, and
 * there is deliberately no function through which to try — invariant I4.
 *
 * Like the escrow, it has **no owner and no admin**. The attestor set and the threshold
 * are written once in the constructor and have no setter. A settable attestor set would
 * make every past attestation re-interpretable: rotate the set and signatures that were
 * invalid become valid. Rotation here means a new deployment, which is a visible event
 * rather than a silent one.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Why signatures must arrive in ascending signer order
 * ──────────────────────────────────────────────────────────────────────────────
 * The attack this closes is one attestor signing M times to fake a quorum. Requiring
 * strictly ascending recovered addresses turns duplicate detection into a single O(n)
 * comparison against the previous signer, with no nested loop and no set in storage.
 * Strictly ascending also rejects equality, which is the duplicate case itself.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Where "bounded by the on-chain record" is enforced
 * ──────────────────────────────────────────────────────────────────────────────
 * The owner's requirement is that attestors cannot introduce facts, only co-sign facts
 * the chain already holds. That binding lives in **WRKEscrow**, which re-derives
 * `settlementId` from `(mandateId, decisionHash, nonce)`, requires every payee to be an
 * accepted worker of that mandate, and requires the basis points to sum — all before it
 * calls this contract. Putting it here instead would require this contract to read the
 * escrow while the escrow holds an immutable reference to this one, which is a
 * construction-order cycle with no clean resolution.
 *
 * So the division is: the escrow decides whether the parameters are *admissible*, this
 * contract decides whether the attestors *vouched for them*. Neither is sufficient
 * alone, and `leaf-1.3.2:G6` tests the pair rather than this contract in isolation,
 * because the pair is what protects the money.
 */
contract WRKSettlementVerifier is IWRKSettlementVerifier, EIP712 {
    /* ── constants ───────────────────────────────────────────────────────── */

    /**
     * @dev Field order is part of this hash and therefore part of every signature.
     *      It must match `Settlement` in IWRKSettlementVerifier.sol and
     *      `SETTLEMENT_TYPES` in packages/types exactly. That package derives its type
     *      string from its own field table and compares against this literal, so a
     *      field added to one and not the other fails a gate instead of silently making
     *      every attestation unrecoverable.
     */
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes32 settlementId,bytes32 mandateId,bytes32 decisionHash,uint256 nonce,"
        "uint16 releaseBp,uint16 refundBp,address[] payees,uint16[] shareBp,uint64 genlayerFinalizedAt)"
    );

    uint256 public constant MAX_ATTESTORS = 32;

    /* ── immutable configuration ─────────────────────────────────────────── */

    /// @inheritdoc IWRKSettlementVerifier
    uint256 public immutable threshold;

    /// @inheritdoc IWRKSettlementVerifier
    uint256 public immutable attestorCount;

    /// @dev Written once in the constructor. No setter exists, by design.
    mapping(address => bool) private _attestors;

    /// @dev The set, in ascending order, for off-chain callers that need to enumerate it.
    address[] private _attestorList;

    /* ── errors ──────────────────────────────────────────────────────────── */

    error NoAttestors();
    error TooManyAttestors(uint256 given, uint256 maximum);
    error ZeroAttestor();
    error AttestorsMustBeAscending(uint256 index);
    error ThresholdOutOfRange(uint256 threshold, uint256 attestorCount);
    error QuorumNotMet(uint256 valid, uint256 required);
    error SignersMustBeAscending(uint256 index);
    error NotAnAttestor(address recovered);

    /* ── construction ────────────────────────────────────────────────────── */

    /**
     * @param attestors_ The attestor set, **in strictly ascending address order**. The
     *                   constructor requires the order rather than sorting, so the
     *                   deployment transaction itself shows the exact set; a sort would
     *                   let a duplicate pass as a typo.
     * @param threshold_ M. Must be at least 1 and at most the set size.
     */
    constructor(address[] memory attestors_, uint256 threshold_)
        EIP712("WRK Settlement", "1")
    {
        uint256 count = attestors_.length;
        if (count == 0) revert NoAttestors();
        if (count > MAX_ATTESTORS) revert TooManyAttestors(count, MAX_ATTESTORS);
        if (threshold_ == 0 || threshold_ > count) revert ThresholdOutOfRange(threshold_, count);

        address previous = address(0);
        for (uint256 i = 0; i < count; ++i) {
            address attestor = attestors_[i];
            if (attestor == address(0)) revert ZeroAttestor();
            // Strictly ascending, which also rejects a repeated address.
            if (uint160(attestor) <= uint160(previous)) revert AttestorsMustBeAscending(i);
            previous = attestor;
            _attestors[attestor] = true;
            _attestorList.push(attestor);
        }

        threshold = threshold_;
        attestorCount = count;
    }

    /* ── verification ────────────────────────────────────────────────────── */

    /**
     * @inheritdoc IWRKSettlementVerifier
     * @dev Reverts rather than returning a bool. A boolean return invites a call site
     *      that ignores it, and on a custody path an ignored return value is a drain.
     *
     *      `ECDSA.recover` is used rather than raw `ecrecover` on purpose: raw
     *      `ecrecover` returns `address(0)` for a malformed signature instead of
     *      reverting, and `address(0)` compared against an uninitialised attestor slot
     *      is how a no-signature quorum gets accepted. OZ's wrapper reverts on a bad
     *      length, on `s` in the upper half of the curve order — signature malleability,
     *      where one message has two valid signatures — and on a zero recovery.
     */
    function verifySettlement(Settlement calldata settlement, bytes[] calldata signatures)
        external
        view
    {
        bytes32 digest = _hashTypedDataV4(_hashStruct(settlement));

        uint256 count = signatures.length;
        if (count < threshold) revert QuorumNotMet(count, threshold);

        address previous = address(0);
        for (uint256 i = 0; i < count; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (uint160(signer) <= uint160(previous)) revert SignersMustBeAscending(i);
            if (!_attestors[signer]) revert NotAnAttestor(signer);
            previous = signer;
        }

        // Reached only when `count` distinct attestors all signed this exact digest, and
        // count >= threshold was checked above.
    }

    /* ── hashing ─────────────────────────────────────────────────────────── */

    /**
     * @dev EIP-712 `hashStruct`. Note the array encoding: a dynamic array hashes to
     *      `keccak256` of its members' concatenated `encodeData`, **each padded to 32
     *      bytes**. `abi.encodePacked(uint256[])` concatenates 32-byte words, which is
     *      exactly that; `abi.encodePacked(address[])` would concatenate 20-byte values
     *      and produce a different, wrong hash — so addresses are widened first.
     *
     *      This is the single easiest place in the protocol to be subtly wrong in a way
     *      no unit test catches, which is why packages/types derives the same digest
     *      from first principles and `leaf-1.3.2:G2` compares the two.
     */
    function _hashStruct(Settlement calldata settlement) private pure returns (bytes32) {
        uint256 payeeCount = settlement.payees.length;
        uint256[] memory payeeWords = new uint256[](payeeCount);
        for (uint256 i = 0; i < payeeCount; ++i) {
            payeeWords[i] = uint256(uint160(settlement.payees[i]));
        }

        uint256 shareCount = settlement.shareBp.length;
        uint256[] memory shareWords = new uint256[](shareCount);
        for (uint256 i = 0; i < shareCount; ++i) {
            shareWords[i] = uint256(settlement.shareBp[i]);
        }

        return keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                settlement.settlementId,
                settlement.mandateId,
                settlement.decisionHash,
                settlement.nonce,
                settlement.releaseBp,
                settlement.refundBp,
                keccak256(abi.encodePacked(payeeWords)),
                keccak256(abi.encodePacked(shareWords)),
                settlement.genlayerFinalizedAt
            )
        );
    }

    /* ── reads ───────────────────────────────────────────────────────────── */

    /// @inheritdoc IWRKSettlementVerifier
    function settlementDigest(Settlement calldata settlement) external view returns (bytes32) {
        return _hashTypedDataV4(_hashStruct(settlement));
    }

    /**
     * @notice The EIP-712 `hashStruct` of `settlement`, without the domain.
     * @dev Exposed deliberately. Unlike the full digest it does not depend on this
     *      contract's address, so it is a value packages/types can compute and pin as a
     *      literal — which makes the array-encoding rule above testable across languages
     *      rather than merely commented. This is the easiest hash in the protocol to get
     *      subtly wrong, so it gets the stronger check.
     */
    function hashStruct(Settlement calldata settlement) external pure returns (bytes32) {
        return _hashStruct(settlement);
    }

    /// @inheritdoc IWRKSettlementVerifier
    function isAttestor(address account) external view returns (bool) {
        return _attestors[account];
    }

    /// @notice The attestor set in ascending order.
    function attestors() external view returns (address[] memory) {
        return _attestorList;
    }

    /// @notice The EIP-712 domain separator, exposed so an off-chain signer can check it
    ///         matches what it computed before gathering signatures.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
