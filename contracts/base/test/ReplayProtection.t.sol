// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "./helpers/BaseFixture.sol";
import {WRKEscrow} from "../src/WRKEscrow.sol";
import {Settlement} from "../src/interfaces/IWRKSettlementVerifier.sol";

/**
 * Replay protection across call orderings, not just the obvious double-execute.
 *
 * Invariant I2 says a `settlementId` can be executed at most once. The interesting
 * question is not "does execute() twice revert" — any implementation gets that right —
 * but whether the *challenge* path reopens the hole. A challenge voids a posting so the
 * adapter can re-post correctly, and the natural implementation of "void" is to delete
 * the posting and let the id be used again. That is correct for a *challenged* posting
 * and catastrophic for an *executed* one, so the two must be distinguished, and
 * `settlementConsumed` is deliberately never cleared.
 */
contract ReplayProtectionTest is BaseFixture {
    bytes32 constant MANDATE = keccak256("mnd_replay");
    bytes32 constant DECISION = keccak256("dec_replay");

    function test_executeTwiceIsRefused() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, s.settlementId)
        );
        escrow.execute(s.settlementId);
    }

    /// @dev post → challenge → re-post → execute, then every replay attempt. This is the
    ///      ordering that most plausibly reopens the hole.
    function test_postChallengeRepostExecuteThenNoReplay() public {
        _fund(MANDATE, 100e6);

        Settlement memory wrong = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(wrong, _sign(wrong, 2));
        assertEq(escrow.activePosting(MANDATE), wrong.settlementId);

        // A competing attested set for the same id with different numbers: the
        // transcription claim. Same mandate, decision and nonce by construction.
        Settlement memory right = _settlement(MANDATE, DECISION, 5000, 1);
        assertEq(right.settlementId, wrong.settlementId, "same id, different numbers");
        escrow.challenge(right, _sign(right, 2));

        assertEq(escrow.activePosting(MANDATE), bytes32(0), "posting voided");
        assertFalse(escrow.settlementConsumed(right.settlementId), "the adapter may re-post");
        assertEq(escrow.heldFor(MANDATE), 100e6, "a challenge moves no money");

        escrow.postSettlement(right, _sign(right, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(right.settlementId);

        assertTrue(escrow.settlementConsumed(right.settlementId));
        assertEq(usdc.balanceOf(workerA), 30e6); // 100 × 50% × 60%
        assertEq(usdc.balanceOf(workerB), 20e6);

        // Now every route back in must be shut.
        bytes[] memory sigs = _sign(right, 2);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.postSettlement(right, sigs);

        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, right.settlementId)
        );
        escrow.execute(right.settlementId);

        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, right.settlementId)
        );
        escrow.challenge(wrong, sigs);
    }

    /// @dev A challenge after the window has elapsed but before execution must still
    ///      work. Refusing it would mean a wrong posting becomes executable simply by
    ///      nobody calling execute() for an hour.
    function test_challengeAfterWindowButBeforeExecutionStillVoids() public {
        _fund(MANDATE, 100e6);
        Settlement memory wrong = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(wrong, _sign(wrong, 2));

        vm.warp(block.timestamp + WINDOW + 3 days);
        Settlement memory right = _settlement(MANDATE, DECISION, 5000, 1);
        escrow.challenge(right, _sign(right, 2));

        assertEq(escrow.activePosting(MANDATE), bytes32(0));
        assertEq(escrow.heldFor(MANDATE), 100e6);
    }

    /// @dev A different nonce is a different settlement, so a second posting for the same
    ///      decision is legal — but only one can ever execute, because the first drains
    ///      the mandate.
    function test_secondNonceCannotPayTwice() public {
        _fund(MANDATE, 100e6);
        Settlement memory first = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(first, _sign(first, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(first.settlementId);
        assertEq(usdc.balanceOf(workerA), 60e6);

        Settlement memory second = _settlement(MANDATE, DECISION, BP16, 2);
        assertTrue(second.settlementId != first.settlementId, "a new nonce is a new id");
        bytes[] memory sigs = _sign(second, 2);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.postSettlement(second, sigs);
        assertEq(usdc.balanceOf(workerA), 60e6, "no second payment");
    }

    /// @dev An expired refund closes the mandate as firmly as a settlement does.
    function test_refundThenSettleIsRefused() public {
        _fund(MANDATE, 100e6);
        vm.warp(_deadline());
        escrow.refundExpired(MANDATE);
        assertEq(usdc.balanceOf(dao), 10_000_000e6);

        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.postSettlement(s, sigs);
    }

    function test_refundTwiceIsRefused() public {
        _fund(MANDATE, 100e6);
        vm.warp(_deadline());
        escrow.refundExpired(MANDATE);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.refundExpired(MANDATE);
    }

    /// @dev Two mandates sharing a decision hash must not share a settlement. If they
    ///      did, settling one would consume the other's id.
    function testFuzz_differentMandatesNeverShareASettlementId(bytes32 a, bytes32 b, uint256 nonce)
        public
        view
    {
        vm.assume(a != b);
        assertTrue(
            escrow.deriveSettlementId(a, DECISION, nonce) != escrow.deriveSettlementId(b, DECISION, nonce)
        );
    }
}

/**
 * The escrow derives `settlementId`; the verifier signs over it. This suite proves the
 * two cannot drift apart.
 *
 * The integration failure it guards against is subtle and total: if the escrow derived
 * the id from one field order while the attestors signed a payload carrying another,
 * every unit test on each side would still pass and no attestation would ever be
 * recoverable in production. The symptom is "settlement silently never works", which is
 * the worst kind of bug to diagnose on a live chain — nothing reverts in testing, and
 * the money simply never moves.
 */
contract SettlementIdAgreementTest is BaseFixture {
    bytes32 constant AGREE_MANDATE = keccak256("mnd_agree");
    bytes32 constant AGREE_DECISION = keccak256("dec_agree");

    /// @dev The escrow's derivation is exactly `keccak256(abi.encode(...))`, and the id is
    ///      bound into what the attestors sign — change it and the struct hash changes, so
    ///      the signatures no longer cover the posting.
    function testFuzz_settlementIdAgreesAcrossContracts(
        bytes32 mandateId,
        bytes32 decisionHash,
        uint256 nonce
    ) public view {
        bytes32 derived = escrow.deriveSettlementId(mandateId, decisionHash, nonce);
        assertEq(
            derived,
            keccak256(abi.encode(mandateId, decisionHash, nonce)),
            "escrow derivation must be keccak256(abi.encode(mandateId, decisionHash, nonce))"
        );

        Settlement memory honest = _settlement(AGREE_MANDATE, AGREE_DECISION, BP16, 1);
        honest.mandateId = mandateId;
        honest.decisionHash = decisionHash;
        honest.nonce = nonce;
        honest.settlementId = derived;

        // Hash before mutating, then mutate and hash again. `Settlement memory forged =
        // honest` would copy the *pointer*, not the struct — memory structs are reference
        // types in Solidity — so assigning to forged.settlementId also changed honest's,
        // both hashes came out identical, and this assertion failed while the contract was
        // perfectly correct. A copy-then-mutate here would have been a false alarm; the
        // version below measures what it claims to.
        bytes32 honestHash = verifier.hashStruct(honest);
        honest.settlementId = derived ^ bytes32(uint256(1));
        bytes32 forgedHash = verifier.hashStruct(honest);

        assertTrue(
            honestHash != forgedHash,
            "the settlement id must be bound into what attestors sign"
        );
    }

    /// @dev And end to end: a settlement whose signed id disagrees with the escrow's own
    ///      derivation is refused even when the attestors genuinely signed it.
    function test_escrowRefusesASignedIdItWouldNotDerive() public {
        _fund(AGREE_MANDATE, 100e6);
        Settlement memory s = _settlement(AGREE_MANDATE, AGREE_DECISION, BP16, 1);
        bytes32 derived = s.settlementId;
        s.settlementId = keccak256("an id the escrow would never derive");

        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementIdMismatch.selector, s.settlementId, derived)
        );
        escrow.postSettlement(s, sigs);
    }
}
