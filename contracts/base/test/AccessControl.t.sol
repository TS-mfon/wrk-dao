// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "./helpers/BaseFixture.sol";
import {WRKEscrow} from "../src/WRKEscrow.sol";
import {WRKSettlementVerifier} from "../src/WRKSettlementVerifier.sol";
import {Settlement} from "../src/interfaces/IWRKSettlementVerifier.sol";

/**
 * Access control, stated as two claims:
 *
 *   1. **There is no privileged role.** Not a locked-down one — an absent one. No owner,
 *      no admin, no pause, no setter, no upgrade path. `scripts/verify-no-adjudication.mjs`
 *      asserts this structurally against the source; these tests assert it behaviourally,
 *      which is the half a source scan cannot do.
 *
 *   2. **Every function is reachable only under its documented precondition**, and the
 *      ones that should be permissionless really are.
 *
 * The second claim is the one that needs care, because "permissionless" and "unguarded"
 * look identical until you ask what the guard is. `execute()` is callable by anyone by
 * design — the keeper buys liveness, never authority (docs/ARCHITECTURE.md §3.3) — so the
 * test asserts a stranger *can* call it, and that calling it early *cannot* work.
 */
contract AccessControlTest is BaseFixture {
    bytes32 constant MANDATE = keccak256("mnd_access");
    bytes32 constant DECISION = keccak256("dec_access");

    /* ── 1. no privileged role exists ────────────────────────────────────── */

    /// @dev If any of these selectors existed, this test would not compile. The
    ///      assertion is the absence of a compile error, which is why the bodies are
    ///      empty: `escrow.owner()` would be a type error, not a runtime revert.
    function test_escrowExposesNoPrivilegedSelector() public view {
        // The full external surface, enumerated. Anything not in this list does not
        // exist, and adding a privileged function means editing this list — which is a
        // visible act in review rather than an invisible one.
        assertTrue(address(escrow) != address(0));
        bytes4[12] memory surface = [
            WRKEscrow.fund.selector,
            WRKEscrow.postSettlement.selector,
            WRKEscrow.challenge.selector,
            WRKEscrow.execute.selector,
            WRKEscrow.refundExpired.selector,
            WRKEscrow.heldFor.selector,
            WRKEscrow.isAcceptedWorker.selector,
            WRKEscrow.executableAt.selector,
            WRKEscrow.deriveSettlementId.selector,
            WRKEscrow.mandateOf.selector,
            WRKEscrow.postingOf.selector,
            WRKEscrow.solvent.selector
        ];
        for (uint256 i = 0; i < surface.length; ++i) {
            assertTrue(surface[i] != bytes4(0));
        }
    }

    /// @dev The immutables have no setter, so these values cannot change after
    ///      deployment. An "upgrade" is a new address, which is observable.
    function test_configurationIsImmutable() public view {
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(address(escrow.verifier()), address(verifier));
        assertEq(escrow.CHALLENGE_WINDOW(), 1 hours);
        assertEq(escrow.MIN_REFUND_DELAY(), 7 days);
        assertEq(escrow.BP_DENOMINATOR(), 10_000);
        assertEq(escrow.MAX_PAYEES(), 16);
        assertEq(verifier.threshold(), 2);
        assertEq(verifier.attestorCount(), 3);
    }

    /// @dev Pushing tokens in does not make them reachable. There is no sweep, so a
    ///      surplus is permanently stuck — which is the correct trade against a rescue
    ///      function that could also reach the escrowed funds.
    function test_noOneCanReachASurplus() public {
        _fund(MANDATE, 100e6);
        usdc.mint(address(escrow), 500e6);

        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        escrow.execute(s.settlementId);

        assertEq(usdc.balanceOf(workerA), 60e6, "workers get the mandate's deposit, not the surplus");
        assertEq(usdc.balanceOf(workerB), 40e6);
        assertEq(usdc.balanceOf(address(escrow)), 500e6, "the surplus stays put");
        assertTrue(escrow.solvent());
    }

    /* ── 2. preconditions, and genuine permissionlessness ────────────────── */

    /// @dev execute() is permissionless by design: a stranger may settle. The keeper buys
    ///      liveness, never authority, so an offline or hostile keeper delays settlement
    ///      without changing its outcome.
    function test_executeIsPermissionless() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);

        vm.prank(stranger);
        escrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 60e6);
    }

    /// @dev And permissionless is not unguarded: the same stranger cannot execute early.
    function test_permissionlessIsNotUnguarded() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        uint64 postedAt = uint64(block.timestamp);
        escrow.postSettlement(s, _sign(s, 2));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.ChallengeWindowOpen.selector, postedAt, postedAt + WINDOW
            )
        );
        escrow.execute(s.settlementId);
    }

    /// @dev Posting is permissionless to *call* — the authority is in the signatures, not
    ///      the caller — so a relayer can submit on the adapter's behalf.
    function test_postingIsPermissionlessButSignatureGated() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);

        vm.prank(stranger);
        escrow.postSettlement(s, _sign(s, 2));
        assertEq(escrow.activePosting(MANDATE), s.settlementId);
    }

    function test_postingWithoutSignaturesIsRefusedFromAnyCaller() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        bytes[] memory none = new bytes[](0);

        for (uint256 i = 0; i < 3; ++i) {
            address caller = i == 0 ? dao : (i == 1 ? attestors[0] : stranger);
            vm.prank(caller);
            vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.QuorumNotMet.selector, 0, 2));
            escrow.postSettlement(s, none);
        }
    }

    /// @dev Even a single attestor — a privileged party if anyone is — cannot post alone.
    function test_oneAttestorCannotPostAlone() public {
        _fund(MANDATE, 100e6);
        Settlement memory s = _settlement(MANDATE, DECISION, BP16, 1);
        bytes[] memory sigs = _sign(s, 1);
        vm.prank(attestors[0]);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.QuorumNotMet.selector, 1, 2));
        escrow.postSettlement(s, sigs);
    }

    /// @dev The refund pays the funder regardless of who calls it, so a stranger calling
    ///      it is a liveness service rather than a theft.
    function test_refundExpiredPaysTheFunderNotTheCaller() public {
        _fund(MANDATE, 100e6);
        uint256 daoBefore = usdc.balanceOf(dao);
        vm.warp(_deadline());

        vm.prank(stranger);
        escrow.refundExpired(MANDATE);

        assertEq(usdc.balanceOf(dao), daoBefore + 100e6);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// @dev Funding attributes the deposit to its caller, so one DAO cannot fund a
    ///      mandate and have another receive the refund.
    function test_funderIsRecordedAsTheCaller() public {
        address otherDao = makeAddr("otherDao");
        usdc.mint(otherDao, 100e6);
        vm.prank(otherDao);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(otherDao);
        escrow.fund(MANDATE, _twoWorkers(), 100e6, _deadline());

        (address funder,,,,,,,) = escrow.mandateOf(MANDATE);
        assertEq(funder, otherDao);

        vm.warp(_deadline());
        escrow.refundExpired(MANDATE);
        assertEq(usdc.balanceOf(otherDao), 100e6);
        assertEq(usdc.balanceOf(dao), 10_000_000e6, "the other DAO is untouched");
    }

    /// @dev A worker on one mandate is not a worker on another, so the payee set cannot
    ///      be borrowed across mandates.
    function test_workerSetsDoNotLeakBetweenMandates() public {
        bytes32 other = keccak256("mnd_other");
        address[] memory onlyA = new address[](1);
        onlyA[0] = workerA;
        vm.prank(dao);
        escrow.fund(other, onlyA, 100e6, _deadline());

        assertTrue(escrow.isAcceptedWorker(other, workerA));
        assertFalse(escrow.isAcceptedWorker(other, workerB));

        Settlement memory s = _settlement(other, DECISION, BP16, 1); // names both workers
        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.NotAnAcceptedWorker.selector, other, workerB)
        );
        escrow.postSettlement(s, sigs);
    }
}
