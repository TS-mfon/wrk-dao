// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice The settlement parameters an attestor co-signs.
 *
 * Field order is load-bearing. It is part of the EIP-712 type hash
 * (`docs/ARCHITECTURE.md` §8), so this struct, the `Settlement(...)` type string in
 * the verifier, and `SETTLEMENT_TYPES` in `packages/types` must list the fields in
 * exactly this order. `packages/types`' own gate derives the type string from its
 * field table and compares, so a field added to one and not the other is caught
 * rather than discovered when no attestation can be recovered.
 *
 * `settlementId` is redundant — it is derivable from the three fields that follow —
 * and that is deliberate. It is carried in the signed payload so an attestation can
 * never be replayed against a different `(mandateId, decisionHash, nonce)` triple,
 * and the escrow re-derives it and refuses a mismatch rather than trusting it.
 */
struct Settlement {
    bytes32 settlementId;
    bytes32 mandateId;
    bytes32 decisionHash;
    uint256 nonce;
    uint16 releaseBp;
    uint16 refundBp;
    address[] payees;
    uint16[] shareBp;
    uint64 genlayerFinalizedAt;
}

/**
 * @title IWRKSettlementVerifier
 * @notice Checks that a settlement carries M-of-N attestor signatures.
 *
 * The verifier holds **no funds and no judgment**. It answers one question — did M
 * of the N on-chain attestors sign exactly these parameters for this chain and this
 * verifying contract — and the escrow acts on the answer.
 *
 * `verifySettlement` reverts rather than returning a bool. A boolean return invites
 * a call site that ignores it, and on a custody path an ignored return value is a
 * drain. There is deliberately no way to ask this interface whether the work was
 * good; that authority belongs to GenLayer (`docs/ARCHITECTURE.md` §1).
 */
interface IWRKSettlementVerifier {
    /**
     * @notice Reverts unless `signatures` are at least `threshold()` valid attestor
     *         signatures over `settlement`, with strictly ascending signer addresses.
     * @dev Ascending order makes duplicate-signer detection a single O(n) scan, which
     *      closes "the same attestor signs M times to fake a quorum" without a nested
     *      loop. See `docs/ARCHITECTURE.md` §8.
     */
    function verifySettlement(Settlement calldata settlement, bytes[] calldata signatures)
        external
        view;

    /// @notice M — the number of distinct attestor signatures a settlement requires.
    function threshold() external view returns (uint256);

    /// @notice N — the size of the attestor set.
    function attestorCount() external view returns (uint256);

    /// @notice Whether `account` is in the attestor set.
    function isAttestor(address account) external view returns (bool);

    /// @notice The EIP-712 digest an attestor signs for `settlement`.
    function settlementDigest(Settlement calldata settlement) external view returns (bytes32);
}
