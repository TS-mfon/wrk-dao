// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestUSDC} from "./helpers/BaseFixture.sol";
import {WRKEscrow} from "../src/WRKEscrow.sol";
import {WRKSettlementVerifier} from "../src/WRKSettlementVerifier.sol";
import {IWRKSettlementVerifier, Settlement} from "../src/interfaces/IWRKSettlementVerifier.sol";

/**
 * Drives the escrow through arbitrary call sequences.
 *
 * Every handler function bounds its inputs so that calls mostly *succeed*. A handler
 * whose calls all revert explores nothing — the fuzzer dutifully reports 100% passing
 * invariants over a state machine that never left its initial state, which is the most
 * common way invariant testing gets to be decorative.
 */
contract EscrowHandler is Test {
    uint256 internal constant BP = 10_000;
    uint16 internal constant BP16 = 10_000;
    uint64 internal constant WINDOW = 1 hours;
    uint64 internal constant MIN_DELAY = 7 days;

    TestUSDC public usdc;
    WRKSettlementVerifier public verifier;
    WRKEscrow public escrow;

    address public dao;
    address[] public workers;
    uint256[] public attestorKeys;

    /* ── ghost state ─────────────────────────────────────────────────────── */

    bytes32[] public mandateIds;
    mapping(bytes32 => bool) public knownMandate;
    mapping(bytes32 => address[]) public mandateWorkers;

    /// @dev Invariant I2's witness: incremented on every successful execute.
    mapping(bytes32 => uint256) public executionCount;
    bytes32[] public executedSettlements;

    /// @dev Every address this handler has ever named as a payee.
    address[] public everPaid;
    mapping(address => bool) public isEverPaid;

    uint256 public callsFund;
    uint256 public callsPost;
    uint256 public callsChallenge;
    uint256 public callsExecute;
    uint256 public callsRefund;
    uint256 public callsEarlyExecuteRefused;

    constructor(
        TestUSDC usdc_,
        WRKSettlementVerifier verifier_,
        WRKEscrow escrow_,
        address dao_,
        address[] memory workers_,
        uint256[] memory attestorKeys_
    ) {
        usdc = usdc_;
        verifier = verifier_;
        escrow = escrow_;
        dao = dao_;
        for (uint256 i = 0; i < workers_.length; ++i) workers.push(workers_[i]);
        for (uint256 i = 0; i < attestorKeys_.length; ++i) attestorKeys.push(attestorKeys_[i]);
    }

    /* ── helpers ─────────────────────────────────────────────────────────── */

    /// @dev An even basis-point share. `BP / n` with n >= 1 is at most 10000, so the cast
    ///      cannot truncate; the single suppression lives here rather than at each call.
    function _evenShare(uint256 n) internal pure returns (uint16) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(BP / n);
    }

    function mandateCount() external view returns (uint256) {
        return mandateIds.length;
    }

    function everPaidCount() external view returns (uint256) {
        return everPaid.length;
    }

    function executedCount() external view returns (uint256) {
        return executedSettlements.length;
    }

    function _pickMandate(uint256 seed) internal view returns (bytes32) {
        if (mandateIds.length == 0) return bytes32(0);
        return mandateIds[seed % mandateIds.length];
    }

    function _sign(Settlement memory s, uint256 count) internal view returns (bytes[] memory sigs) {
        bytes32 digest = verifier.settlementDigest(s);
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 sv) = vm.sign(attestorKeys[i], digest);
            sigs[i] = abi.encodePacked(r, sv, v);
        }
    }

    /* ── actions ─────────────────────────────────────────────────────────── */

    function fund(uint256 amountSeed, uint256 workerSeed, uint64 deadlineSeed) external {
        uint256 amount = bound(amountSeed, 1, 100_000e6);
        uint256 workerN = bound(workerSeed, 1, workers.length);

        bytes32 mandateId = keccak256(abi.encode("mnd", mandateIds.length, amount));
        if (knownMandate[mandateId]) return;

        address[] memory chosen = new address[](workerN);
        for (uint256 i = 0; i < workerN; ++i) chosen[i] = workers[i];

        uint64 deadline =
            uint64(bound(deadlineSeed, block.timestamp + MIN_DELAY, block.timestamp + 400 days));

        if (usdc.balanceOf(dao) < amount) return;

        vm.prank(dao);
        escrow.fund(mandateId, chosen, amount, deadline);

        mandateIds.push(mandateId);
        knownMandate[mandateId] = true;
        for (uint256 i = 0; i < workerN; ++i) mandateWorkers[mandateId].push(chosen[i]);
        callsFund += 1;
    }

    function post(uint256 mandateSeed, uint16 releaseSeed, uint256 nonceSeed, uint256 sigSeed)
        external
    {
        bytes32 mandateId = _pickMandate(mandateSeed);
        if (mandateId == bytes32(0)) return;
        if (escrow.activePosting(mandateId) != bytes32(0)) return;

        (, , uint256 released, uint256 refunded, , , , bool exists) = escrow.mandateOf(mandateId);
        if (!exists || released != 0 || refunded != 0) return;

        // bound() constrains the value to <= 10000 before the cast, so truncation is
        // impossible by construction.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 releaseBp = uint16(bound(uint256(releaseSeed), 0, BP));
        uint256 nonce = bound(nonceSeed, 1, 5);
        uint256 sigCount = bound(sigSeed, 2, attestorKeys.length);

        address[] memory payees = mandateWorkers[mandateId];
        Settlement memory s;
        s.mandateId = mandateId;
        s.decisionHash = keccak256(abi.encode("dec", mandateId, nonce));
        s.nonce = nonce;
        s.settlementId = escrow.deriveSettlementId(mandateId, s.decisionHash, nonce);
        s.releaseBp = releaseBp;
        s.refundBp = BP16 - releaseBp;
        s.genlayerFinalizedAt = uint64(block.timestamp);

        if (releaseBp == 0) {
            s.payees = new address[](0);
            s.shareBp = new uint16[](0);
        } else {
            uint16[] memory shares = new uint16[](payees.length);
            uint16 each = _evenShare(payees.length);
            uint16 assigned;
            for (uint256 i = 0; i + 1 < payees.length; ++i) {
                shares[i] = each;
                assigned += each;
            }
            shares[payees.length - 1] = BP16 - assigned;
            s.payees = payees;
            s.shareBp = shares;
            for (uint256 i = 0; i < payees.length; ++i) {
                if (!isEverPaid[payees[i]]) {
                    isEverPaid[payees[i]] = true;
                    everPaid.push(payees[i]);
                }
            }
        }

        if (escrow.settlementConsumed(s.settlementId)) return;

        escrow.postSettlement(s, _sign(s, sigCount));
        callsPost += 1;
    }

    function challenge(uint256 mandateSeed, uint16 releaseSeed) external {
        bytes32 mandateId = _pickMandate(mandateSeed);
        if (mandateId == bytes32(0)) return;
        bytes32 settlementId = escrow.activePosting(mandateId);
        if (settlementId == bytes32(0)) return;

        (, bytes32 decisionHash, bytes32 postedParams, uint256 nonce, , , uint16 postedRelease, , ) =
            escrow.postingOf(settlementId);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 releaseBp = uint16(bound(uint256(releaseSeed), 0, BP));
        if (releaseBp == postedRelease) return; // identical params express no disagreement

        address[] memory payees = mandateWorkers[mandateId];
        Settlement memory s;
        s.mandateId = mandateId;
        s.decisionHash = decisionHash;
        s.nonce = nonce;
        s.settlementId = settlementId;
        s.releaseBp = releaseBp;
        s.refundBp = BP16 - releaseBp;
        s.genlayerFinalizedAt = uint64(block.timestamp);
        if (releaseBp == 0) {
            s.payees = new address[](0);
            s.shareBp = new uint16[](0);
        } else {
            uint16[] memory shares = new uint16[](payees.length);
            uint16 each = _evenShare(payees.length);
            uint16 assigned;
            for (uint256 i = 0; i + 1 < payees.length; ++i) {
                shares[i] = each;
                assigned += each;
            }
            shares[payees.length - 1] = BP16 - assigned;
            s.payees = payees;
            s.shareBp = shares;
        }

        // The competing parameters must actually differ, which is the transcription claim.
        bytes32 competing = keccak256(
            abi.encode(s.releaseBp, s.refundBp, s.payees, s.shareBp, s.genlayerFinalizedAt)
        );
        if (competing == postedParams) return;

        escrow.challenge(s, _sign(s, 2));
        callsChallenge += 1;
    }

    function execute(uint256 mandateSeed) external {
        bytes32 mandateId = _pickMandate(mandateSeed);
        if (mandateId == bytes32(0)) return;
        bytes32 settlementId = escrow.activePosting(mandateId);
        if (settlementId == bytes32(0)) return;

        uint64 ready = escrow.executableAt(settlementId);
        if (ready == 0) return;
        if (escrow.settlementConsumed(settlementId)) return;
        // Warp to the window rather than returning. A handler that only executes when the
        // clock happens to be right explored 1 execution per 64-call run, which left every
        // post-settlement state -- where accounting bugs live -- essentially untested. The
        // early-execute refusal is still covered, by tryExecuteEarly below and by
        // invariant_activePostingHoldsItsDeposit.
        if (block.timestamp < ready) vm.warp(ready);

        escrow.execute(settlementId);

        executionCount[settlementId] += 1;
        executedSettlements.push(settlementId);
        callsExecute += 1;
    }

    function refundExpired(uint256 mandateSeed) external {
        uint256 count = mandateIds.length;
        if (count == 0) return;

        // Scan for a mandate that is actually refundable. Picking one at random almost
        // always found an active posting and returned, so the escape hatch went
        // unexercised across entire runs.
        bytes32 mandateId;
        uint64 deadline;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 candidate = mandateIds[(mandateSeed + i) % count];
            if (escrow.activePosting(candidate) != bytes32(0)) continue;
            (, , uint256 rel, uint256 ref, , uint64 dl, , bool ex) = escrow.mandateOf(candidate);
            if (!ex || rel != 0 || ref != 0) continue;
            mandateId = candidate;
            deadline = dl;
            break;
        }
        if (mandateId == bytes32(0)) return;
        (, , uint256 released, uint256 refunded, , , , bool exists) = escrow.mandateOf(mandateId);
        if (!exists || released != 0 || refunded != 0) return;
        // Reach the deadline instead of declining the call, for the same reason execute()
        // warps to its window: a handler that only acts when the clock happens to be right
        // left the expired-refund escape hatch at zero calls across entire runs.
        if (block.timestamp < deadline) vm.warp(deadline);

        escrow.refundExpired(mandateId);
        callsRefund += 1;
    }

    /// @dev Executing inside the window must always fail. Kept as a handler action so the
    ///      refusal is exercised across arbitrary orderings, not only in the unit test
    ///      that was written for it.
    function tryExecuteEarly(uint256 mandateSeed) external {
        bytes32 mandateId = _pickMandate(mandateSeed);
        if (mandateId == bytes32(0)) return;
        bytes32 settlementId = escrow.activePosting(mandateId);
        if (settlementId == bytes32(0)) return;
        uint64 ready = escrow.executableAt(settlementId);
        if (ready == 0 || block.timestamp >= ready) return;

        uint256 heldBefore = escrow.heldFor(mandateId);
        try escrow.execute(settlementId) {
            revert("execute inside the challenge window must revert");
        } catch {
            callsEarlyExecuteRefused += 1;
        }
        assertEq(escrow.heldFor(mandateId), heldBefore, "a refused execute moves nothing");
    }

    /// @dev Time must move or the challenge window never elapses and execute() is
    ///      unreachable, which would silently exclude the entire settlement path.
    function warp(uint256 secondsSeed) external {
        uint256 step = bound(secondsSeed, 1 minutes, 20 days);
        vm.warp(block.timestamp + step);
    }
}

/**
 * Stateful invariants over the escrow.
 *
 * These are the properties a drain must break, asserted over call sequences nobody wrote
 * down. The unit tests prove each guard works in the situation it was written for; this
 * suite looks for the situation nobody thought of.
 */
contract EscrowInvariantsTest is Test {
    uint64 constant START = 1_700_000_000;

    TestUSDC usdc;
    WRKSettlementVerifier verifier;
    WRKEscrow escrow;
    EscrowHandler handler;

    address dao = makeAddr("dao");

    function setUp() public {
        vm.warp(START);

        uint256[3] memory raw = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC0FFEE)];
        address[3] memory addrs;
        for (uint256 i = 0; i < 3; ++i) addrs[i] = vm.addr(raw[i]);
        for (uint256 i = 0; i < 3; ++i) {
            uint256 min = i;
            for (uint256 j = i + 1; j < 3; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[min])) min = j;
            }
            (addrs[i], addrs[min]) = (addrs[min], addrs[i]);
            (raw[i], raw[min]) = (raw[min], raw[i]);
        }
        address[] memory attestors = new address[](3);
        uint256[] memory keys = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            attestors[i] = addrs[i];
            keys[i] = raw[i];
        }

        usdc = new TestUSDC();
        verifier = new WRKSettlementVerifier(attestors, 2);
        escrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(verifier)));

        address[] memory workers = new address[](3);
        workers[0] = makeAddr("workerA");
        workers[1] = makeAddr("workerB");
        workers[2] = makeAddr("workerC");

        usdc.mint(dao, 100_000_000e6);
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);

        // deployCode resolves the artifact at run time instead of embedding the handler's
        // creation code here. With `new EscrowHandler(...)` this contract's initcode was
        // 52792 bytes, past the 49152 Shanghai limit -- and embedding is transitive, so
        // moving the system construction into the handler did not help: the handler's
        // code then carried the token, verifier and escrow with it.
        handler = EscrowHandler(
            deployCode(
                "EscrowInvariants.t.sol:EscrowHandler",
                abi.encode(usdc, verifier, escrow, dao, workers, keys)
            )
        );
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);

        targetContract(address(handler));
    }

    /* ── the accounting identity ─────────────────────────────────────────── */

    /// @dev Per mandate: deposited == held + released + refunded, exactly. This is the
    ///      assertion the escrow makes before each transfer, and the property a drain
    ///      must break.
    function invariant_perMandateAccountingIdentity() public view {
        uint256 count = handler.mandateCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 mandateId = handler.mandateIds(i);
            (, uint256 deposited, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(mandateId);
            assertEq(
                escrow.heldFor(mandateId) + released + refunded,
                deposited,
                "deposited == held + released + refunded"
            );
            assertLe(released + refunded, deposited, "never pays out more than was deposited");
        }
    }

    /// @dev The contract's token balance always covers what it still owes. `==` rather
    ///      than `>=` holds here because the handler never pushes an unsolicited surplus.
    function invariant_balanceCoversObligations() public view {
        assertEq(
            usdc.balanceOf(address(escrow)),
            escrow.totalDeposited() - escrow.totalReleased() - escrow.totalRefunded(),
            "token balance must equal outstanding obligations"
        );
        assertTrue(escrow.solvent());
    }

    function invariant_globalTotalsAgreeWithMandates() public view {
        uint256 count = handler.mandateCount();
        uint256 deposited;
        uint256 released;
        uint256 refunded;
        for (uint256 i = 0; i < count; ++i) {
            (, uint256 d, uint256 r, uint256 f,,,,) = escrow.mandateOf(handler.mandateIds(i));
            deposited += d;
            released += r;
            refunded += f;
        }
        assertEq(deposited, escrow.totalDeposited(), "global deposited");
        assertEq(released, escrow.totalReleased(), "global released");
        assertEq(refunded, escrow.totalRefunded(), "global refunded");
    }

    /* ── invariant I2 ────────────────────────────────────────────────────── */

    /// @dev No settlementId executes twice, over any call ordering the fuzzer finds.
    function invariant_eachSettlementExecutesAtMostOnce() public view {
        uint256 count = handler.executedCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 settlementId = handler.executedSettlements(i);
            assertEq(handler.executionCount(settlementId), 1, "executed at most once");
            assertTrue(escrow.settlementConsumed(settlementId), "and the flag is set");
        }
    }

    /* ── invariant I6 ────────────────────────────────────────────────────── */

    /// @dev Only the mandate's accepted workers and the funder ever hold USDC that came
    ///      out of the escrow. The handler names only real workers as payees, so any
    ///      other address holding a balance means the escrow paid someone it should not
    ///      have been able to reach.
    function invariant_onlyWorkersAndFunderHoldReleasedFunds() public view {
        assertEq(usdc.balanceOf(address(verifier)), 0, "the verifier never holds funds");
        assertEq(usdc.balanceOf(address(handler)), 0, "the handler never receives funds");

        uint256 paidCount = handler.everPaidCount();
        uint256 totalToPayees;
        for (uint256 i = 0; i < paidCount; ++i) {
            totalToPayees += usdc.balanceOf(handler.everPaid(i));
        }
        assertLe(totalToPayees, escrow.totalReleased(), "payees hold at most what was released");
    }

    /* ── the window ──────────────────────────────────────────────────────── */

    /// @dev An active posting is never executable before its window elapses, and the
    ///      mandate still holds its full deposit while one is pending.
    function invariant_activePostingHoldsItsDeposit() public view {
        uint256 count = handler.mandateCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 mandateId = handler.mandateIds(i);
            bytes32 settlementId = escrow.activePosting(mandateId);
            if (settlementId == bytes32(0)) continue;
            (, uint256 deposited, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(mandateId);
            assertEq(released, 0, "an active posting means nothing has been released");
            assertEq(refunded, 0, "an active posting means nothing has been refunded");
            assertEq(escrow.heldFor(mandateId), deposited, "the whole deposit is still held");
            assertFalse(escrow.settlementConsumed(settlementId), "and it is not yet consumed");
        }
    }

    /// @dev The handler must actually have exercised the interesting paths. Without this,
    ///      every invariant above could pass over a state machine that only ever funded.
    /// @dev Printed once at the end of the run so the coverage is visible rather than
    ///      assumed. A run with zero executes would satisfy every invariant above and
    ///      prove nothing about settlement.
    function afterInvariant() public view {
        console.log("fund               ", handler.callsFund());
        console.log("post               ", handler.callsPost());
        console.log("challenge          ", handler.callsChallenge());
        console.log("execute            ", handler.callsExecute());
        console.log("refund             ", handler.callsRefund());
        console.log("early-exec refused ", handler.callsEarlyExecuteRefused());

        // Printed, not asserted. A per-sequence floor was tried here and is the wrong
        // instrument: Foundry reverts handler state between runs and afterInvariant sees
        // only the last one, whose depth varies enormously -- one sequence reached 10
        // funds and 3 executions, the next reached 1 fund and 0. A floor on that is
        // flaky, and a flaky gate trains you to re-run it.
        //
        // The question the floor was trying to answer -- can the handler reach every
        // path at all, or are the invariants passing over a state machine that never
        // moves -- is answered deterministically by EscrowHandlerReachabilityTest below.
    }

}

/**
 * The positive control for the invariant suite.
 *
 * Invariant runs are random, so "every invariant passed" is compatible with "the handler
 * never got past funding". This test drives the handler through the whole lifecycle with
 * fixed inputs and asserts each action's counter moves, which proves the actions are
 * reachable. If a guard in the handler silently stops matching reality, these fail and
 * the invariant suite's silence stops being evidence.
 */
contract EscrowHandlerReachabilityTest is Test {
    uint64 constant START = 1_700_000_000;

    TestUSDC usdc;
    WRKSettlementVerifier verifier;
    WRKEscrow escrow;
    EscrowHandler handler;
    address dao = makeAddr("dao");

    function setUp() public {
        vm.warp(START);

        uint256[3] memory raw = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC0FFEE)];
        address[3] memory addrs;
        for (uint256 i = 0; i < 3; ++i) addrs[i] = vm.addr(raw[i]);
        for (uint256 i = 0; i < 3; ++i) {
            uint256 min = i;
            for (uint256 j = i + 1; j < 3; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[min])) min = j;
            }
            (addrs[i], addrs[min]) = (addrs[min], addrs[i]);
            (raw[i], raw[min]) = (raw[min], raw[i]);
        }
        address[] memory attestors = new address[](3);
        uint256[] memory keys = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            attestors[i] = addrs[i];
            keys[i] = raw[i];
        }

        usdc = new TestUSDC();
        verifier = new WRKSettlementVerifier(attestors, 2);
        escrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(verifier)));

        address[] memory workers = new address[](3);
        workers[0] = makeAddr("workerA");
        workers[1] = makeAddr("workerB");
        workers[2] = makeAddr("workerC");

        usdc.mint(dao, 100_000_000e6);
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);

        handler = EscrowHandler(
            deployCode(
                "EscrowInvariants.t.sol:EscrowHandler",
                abi.encode(usdc, verifier, escrow, dao, workers, keys)
            )
        );
    }

    function test_everyHandlerActionIsReachable() public {
        handler.fund(1_000e6, 2, uint64(START + 30 days));
        assertEq(handler.callsFund(), 1, "fund must be reachable");
        assertEq(handler.mandateCount(), 1);

        handler.post(0, 7500, 1, 2);
        assertEq(handler.callsPost(), 1, "post must be reachable");

        handler.tryExecuteEarly(0);
        assertEq(handler.callsEarlyExecuteRefused(), 1, "the early-execute refusal must fire");

        handler.challenge(0, 5000);
        assertEq(handler.callsChallenge(), 1, "challenge must be reachable");

        handler.post(0, 5000, 1, 2);
        assertEq(handler.callsPost(), 2, "re-posting after a challenge must be reachable");

        handler.execute(0);
        assertEq(handler.callsExecute(), 1, "execute must be reachable");
        assertTrue(usdc.balanceOf(makeAddr("workerA")) > 0, "and must actually move USDC");

        // A second mandate, left unposted, reaches the expired-refund escape hatch.
        handler.fund(2_000e6, 1, uint64(block.timestamp + 30 days));
        assertEq(handler.callsFund(), 2);
        handler.refundExpired(1);
        assertEq(handler.callsRefund(), 1, "refundExpired must be reachable");

        handler.warp(1 days);
        assertTrue(escrow.solvent(), "and the system stays solvent throughout");
    }
}
