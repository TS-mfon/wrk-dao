// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {WRKEscrow} from "../src/WRKEscrow.sol";
import {IWRKEscrow} from "../src/interfaces/IWRKEscrow.sol";
import {IWRKSettlementVerifier, Settlement} from "../src/interfaces/IWRKSettlementVerifier.sol";

/* ══════════════════════════════════════════════════════════════════════════════
   Test doubles.

   These live in this file rather than in test/helpers/ because that directory
   belongs to leaf-1.3.3; keeping them here leaves this leaf self-contained and its
   gates runnable on their own.
   ══════════════════════════════════════════════════════════════════════════════ */

/// @dev USDC's shape: 6 decimals, plain ERC-20 semantics.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Takes a fee on every transfer. USDC does not, and the escrow must not depend
///      on that: a fee-on-transfer asset is exactly how "we only support USDC" turns
///      into a shortfall on the last payout.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBp;

    constructor(uint256 feeBp_) ERC20("Fee", "FEE") {
        feeBp = feeBp_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBp == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBp) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee); // burn the fee
    }
}

/// @dev Calls back into `execute` from inside a transfer. The callback is wrapped in
///      try/catch so the outer settlement still succeeds — which is the harder case:
///      a token that swallows its own failed reentry would otherwise hide a double
///      release behind a successful transaction.
contract ReentrantToken is ERC20 {
    WRKEscrow public escrow;
    bytes32 public target;
    bool public armed;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(WRKEscrow escrow_, bytes32 settlementId) external {
        escrow = escrow_;
        target = settlementId;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed || from != address(escrow)) return;
        reentryAttempts += 1;
        try escrow.execute(target) {
            lastReentryReverted = false;
        } catch {
            lastReentryReverted = true;
        }
    }
}

/// @dev Stands in for WRKSettlementVerifier (leaf-1.3.2). This leaf's job is the
///      custody logic; what it needs from the verifier is a yes/no it cannot ignore,
///      so the double reverts on refusal exactly as the interface requires.
contract MockVerifier is IWRKSettlementVerifier {
    error MockVerifierRejected();

    bool public accepting = true;
    uint256 public calls;
    bytes32 public lastDigest;

    function setAccepting(bool value) external {
        accepting = value;
    }

    function verifySettlement(Settlement calldata settlement, bytes[] calldata) external view {
        if (!accepting) revert MockVerifierRejected();
        // Touch the payload so a settlement the escrow never built cannot slip past a
        // double that ignores its argument entirely.
        if (settlement.settlementId == bytes32(0)) revert MockVerifierRejected();
    }

    function threshold() external pure returns (uint256) {
        return 2;
    }

    function attestorCount() external pure returns (uint256) {
        return 3;
    }

    function isAttestor(address) external pure returns (bool) {
        return true;
    }

    function settlementDigest(Settlement calldata settlement) external pure returns (bytes32) {
        return keccak256(abi.encode(settlement.settlementId));
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   WRKEscrow
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Shared fixture. Split into several concrete test contracts below rather than one
 * large one: every `new X(...)` embeds X's creation bytecode into the test contract,
 * and one contract holding all of them exceeded the 49152-byte initcode limit. The
 * split also puts each test double only where it is used.
 */
abstract contract EscrowFixture is Test {
    uint256 constant BP = 10_000;
    /// @dev Same value typed for basis-point arithmetic, so the common case needs no cast.
    uint16 constant BP16 = 10_000;
    uint64 constant WINDOW = 1 hours;
    uint64 constant MIN_DELAY = 7 days;
    uint64 constant START = 1_700_000_000;

    MockUSDC usdc;
    MockVerifier verifier;
    WRKEscrow escrow;

    address dao = makeAddr("dao");
    address workerA = makeAddr("workerA");
    address workerB = makeAddr("workerB");
    address stranger = makeAddr("stranger");
    address keeper = makeAddr("keeper");

    bytes32 constant MANDATE = keccak256("mnd_one");
    bytes32 constant DECISION_HASH = keccak256("decision");
    bytes[] emptySigs;

    function setUp() public {
        vm.warp(START);
        usdc = new MockUSDC();
        verifier = new MockVerifier();
        escrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(verifier)));
        usdc.mint(dao, 1_000_000e6);
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);
        emptySigs = new bytes[](0);
    }

    /* ── helpers ─────────────────────────────────────────────────────────── */

    /**
     * @dev `block.timestamp` as uint64. The cast is safe for any plausible chain clock
     *      — uint64 seconds runs out in the year 584942417355 — and collapsing it into
     *      one helper keeps the suppression to a single reviewed site.
     */
    // forge-lint: disable-next-line(unsafe-typecast)
    function _now() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    /// @dev forge-std's `bound` returns uint256; the result is constrained to <= 10000
    ///      before the cast, so truncation is impossible by construction.
    function _boundBp(uint256 raw, uint256 low) internal pure returns (uint16) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(bound(raw, low, BP));
    }

    function _workers() internal view returns (address[] memory workers) {
        workers = new address[](2);
        workers[0] = workerA;
        workers[1] = workerB;
    }

    /**
     * @dev Fixed relative to START, not to `block.timestamp`. Deriving it from the
     *      current clock means a test that warps and then asks for "the deadline" gets
     *      a different answer than the one the contract stored — which cost a confusing
     *      failure while writing these.
     */
    function _deadline() internal pure returns (uint64) {
        return START + MIN_DELAY + 1 days;
    }

    function _fund(uint256 amount) internal {
        vm.prank(dao);
        escrow.fund(MANDATE, _workers(), amount, _deadline());
    }

    function _settlement(uint16 releaseBp, address[] memory payees, uint16[] memory shares, uint256 nonce)
        internal
        view
        returns (Settlement memory s)
    {
        s.mandateId = MANDATE;
        s.decisionHash = DECISION_HASH;
        s.nonce = nonce;
        s.settlementId = escrow.deriveSettlementId(MANDATE, DECISION_HASH, nonce);
        s.releaseBp = releaseBp;
        s.refundBp = BP16 - releaseBp;
        s.payees = payees;
        s.shareBp = shares;
        s.genlayerFinalizedAt = _now();
    }

    function _twoWaySplit(uint16 releaseBp, uint16 shareA)
        internal
        view
        returns (Settlement memory)
    {
        address[] memory payees = new address[](2);
        payees[0] = workerA;
        payees[1] = workerB;
        uint16[] memory shares = new uint16[](2);
        shares[0] = shareA;
        shares[1] = BP16 - shareA;
        return _settlement(releaseBp, payees, shares, 1);
    }

    function _rejection() internal view returns (Settlement memory) {
        return _settlement(0, new address[](0), new uint16[](0), 1);
    }

    function _post(Settlement memory s) internal {
        vm.prank(stranger);
        escrow.postSettlement(s, emptySigs);
    }

    function _assertIdentity(bytes32 mandateId) internal view {
        (, uint256 deposited, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(mandateId);
        assertEq(escrow.heldFor(mandateId) + released + refunded, deposited, "deposited == held + released + refunded");
        assertTrue(escrow.solvent(), "escrow must remain solvent");
    }

}

contract EscrowFundingTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G2 — funding
       ══════════════════════════════════════════════════════════════════════ */

    function test_fund_recordsDepositAndWorkerSet() public {
        _fund(250e6);

        (
            address funder,
            uint256 deposited,
            uint256 released,
            uint256 refunded,
            uint64 fundedAt,
            uint64 refundDeadline,
            uint32 workerCount,
            bool exists
        ) = escrow.mandateOf(MANDATE);

        assertEq(funder, dao);
        assertEq(deposited, 250e6);
        assertEq(released, 0);
        assertEq(refunded, 0);
        assertEq(fundedAt, START);
        assertEq(refundDeadline, _deadline());
        assertEq(workerCount, 2);
        assertTrue(exists);

        assertTrue(escrow.isAcceptedWorker(MANDATE, workerA));
        assertTrue(escrow.isAcceptedWorker(MANDATE, workerB));
        assertFalse(escrow.isAcceptedWorker(MANDATE, stranger));
        assertEq(escrow.heldFor(MANDATE), 250e6);
        assertEq(usdc.balanceOf(address(escrow)), 250e6);
        _assertIdentity(MANDATE);
    }

    function test_fund_attributesBalanceToOneMandateOnly() public {
        bytes32 other = keccak256("mnd_two");
        _fund(100e6);
        vm.prank(dao);
        escrow.fund(other, _workers(), 40e6, _deadline());

        assertEq(escrow.heldFor(MANDATE), 100e6);
        assertEq(escrow.heldFor(other), 40e6);
        assertEq(escrow.totalDeposited(), 140e6);
        // A worker accepted on one mandate is not thereby a worker on another.
        address[] memory onlyA = new address[](1);
        onlyA[0] = workerA;
        bytes32 third = keccak256("mnd_three");
        vm.prank(dao);
        escrow.fund(third, onlyA, 1e6, _deadline());
        assertTrue(escrow.isAcceptedWorker(third, workerA));
        assertFalse(escrow.isAcceptedWorker(third, workerB));
    }

    function test_fund_emitsTheAmountActuallyReceived() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IWRKEscrow.MandateFunded(MANDATE, dao, 250e6, _deadline(), 2);
        _fund(250e6);
    }

    /// @dev The escrow records a balance delta, not the caller's argument. A token that
    ///      charges a fee must not leave it believing it holds more than it does.
    function test_fund_recordsDeltaNotArgumentUnderFeeOnTransfer() public {
        FeeOnTransferToken fee = new FeeOnTransferToken(100); // 1%
        WRKEscrow feeEscrow =
            new WRKEscrow(IERC20(address(fee)), IWRKSettlementVerifier(address(verifier)));
        fee.mint(dao, 1_000e6);
        vm.startPrank(dao);
        fee.approve(address(feeEscrow), type(uint256).max);
        feeEscrow.fund(MANDATE, _workers(), 100e6, _deadline());
        vm.stopPrank();

        (, uint256 deposited,,,,,,) = feeEscrow.mandateOf(MANDATE);
        assertEq(deposited, 99e6, "must record what arrived");
        assertEq(fee.balanceOf(address(feeEscrow)), 99e6);
        assertTrue(feeEscrow.solvent());
    }

}

contract EscrowAccountingTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G3 — the accounting identity, fuzzed
       ══════════════════════════════════════════════════════════════════════ */

    function testFuzz_accounting_identityHoldsThroughExecute(
        uint256 amount,
        uint16 releaseBp,
        uint16 shareA
    ) public {
        amount = bound(amount, 1, 1_000_000e6);
        releaseBp = _boundBp(releaseBp, 0);
        shareA = _boundBp(shareA, 0);

        _fund(amount);
        _assertIdentity(MANDATE);

        Settlement memory s = releaseBp == 0 ? _rejection() : _twoWaySplit(releaseBp, shareA);
        _post(s);
        _assertIdentity(MANDATE); // a posting moves nothing

        vm.warp(block.timestamp + WINDOW);
        vm.prank(keeper);
        escrow.execute(s.settlementId);

        (, uint256 deposited, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(MANDATE);
        assertEq(released + refunded, deposited, "fully settled: released + refunded == deposited");
        assertEq(escrow.heldFor(MANDATE), 0, "nothing left held");
        assertEq(
            usdc.balanceOf(workerA) + usdc.balanceOf(workerB) + refunded,
            deposited,
            "every unit arrived somewhere"
        );
        assertEq(escrow.totalReleased() + escrow.totalRefunded(), escrow.totalDeposited());
        assertTrue(escrow.solvent());
    }

    function testFuzz_accounting_identityHoldsThroughExpiredRefund(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);
        _fund(amount);
        vm.warp(_deadline());
        vm.prank(stranger); // permissionless, but pays the funder
        escrow.refundExpired(MANDATE);

        (, uint256 deposited, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(MANDATE);
        assertEq(released, 0);
        assertEq(refunded, deposited);
        assertEq(escrow.heldFor(MANDATE), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertTrue(escrow.solvent());
    }

}

contract EscrowExecutionTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G4 — execution pays the posted splits, remainder to the refund leg
       ══════════════════════════════════════════════════════════════════════ */

    function test_executeReleases_paysPostedSplitsToTheBasisPoint() public {
        _fund(250_000_000); // 250 USDC
        Settlement memory s = _twoWaySplit(7500, 6000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IWRKEscrow.SettlementExecuted(MANDATE, s.settlementId, 187_500_000, 62_500_000);
        vm.prank(keeper);
        escrow.execute(s.settlementId);

        // pool = 250e6 * 7500/10000 = 187.5e6; A gets 60%, B gets 40%.
        assertEq(usdc.balanceOf(workerA), 112_500_000);
        assertEq(usdc.balanceOf(workerB), 75_000_000);
        assertEq(usdc.balanceOf(dao), 1_000_000e6 - 250_000_000 + 62_500_000);
        assertTrue(escrow.settlementConsumed(s.settlementId));
        assertEq(escrow.activePosting(MANDATE), bytes32(0));
        _assertIdentity(MANDATE);
    }

    function test_executeReleases_fullAcceptancePaysEverything() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(BP16, 5000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        assertEq(usdc.balanceOf(workerA), 50e6);
        assertEq(usdc.balanceOf(workerB), 50e6);
        (,, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(MANDATE);
        assertEq(released, 100e6);
        assertEq(refunded, 0);
    }

    function test_executeReleases_rejectionRefundsEverythingAndPaysNobody() public {
        _fund(100e6);
        Settlement memory s = _rejection();
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        assertEq(usdc.balanceOf(workerA), 0);
        assertEq(usdc.balanceOf(workerB), 0);
        assertEq(usdc.balanceOf(dao), 1_000_000e6);
        (,, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(MANDATE);
        assertEq(released, 0);
        assertEq(refunded, 100e6);
    }

    /// @dev Two floors shed value — the pool and each payee's share — and every shed
    ///      unit must land in the refund rather than being handed to a payee.
    function testFuzz_splitRemainder_goesToRefundNeverToAPayee(uint256 amount, uint16 releaseBp)
        public
    {
        amount = bound(amount, 1, 1_000_000e6);
        releaseBp = _boundBp(releaseBp, 1);

        // Three near-equal shares: 10000/3 does not divide, so a remainder always exists.
        address[] memory payees = new address[](3);
        payees[0] = workerA;
        payees[1] = workerB;
        address workerC = makeAddr("workerC");
        payees[2] = workerC;
        uint16[] memory shares = new uint16[](3);
        shares[0] = 3334;
        shares[1] = 3333;
        shares[2] = 3333;

        address[] memory workers = new address[](3);
        workers[0] = workerA;
        workers[1] = workerB;
        workers[2] = workerC;
        vm.prank(dao);
        escrow.fund(MANDATE, workers, amount, _deadline());

        Settlement memory s = _settlement(releaseBp, payees, shares, 7);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        uint256 pool = (amount * releaseBp) / BP;
        uint256 expectedA = (pool * 3334) / BP;
        uint256 expectedB = (pool * 3333) / BP;
        assertEq(usdc.balanceOf(workerA), expectedA);
        assertEq(usdc.balanceOf(workerB), expectedB);
        assertEq(usdc.balanceOf(workerC), expectedB);

        (,, uint256 released, uint256 refunded,,,,) = escrow.mandateOf(MANDATE);
        assertEq(released, expectedA + 2 * expectedB);
        // The refund is never below its nominal share: it holds the remainder.
        assertGe(refunded, (amount * (BP - releaseBp)) / BP);
        assertEq(released + refunded, amount);
    }

}

contract EscrowChallengeWindowTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G5 — the challenge window, asserted in both directions at the boundary
       ══════════════════════════════════════════════════════════════════════ */

    function test_challengeWindow_isExactlyOneHour() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        uint64 postedAt = _now();
        _post(s);
        assertEq(escrow.executableAt(s.settlementId), postedAt + WINDOW);
    }

    function test_challengeWindow_revertsOneSecondBeforeTheBoundary() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        uint64 postedAt = _now();
        _post(s);

        vm.warp(postedAt + WINDOW - 1);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.ChallengeWindowOpen.selector, postedAt, postedAt + WINDOW)
        );
        escrow.execute(s.settlementId);
    }

    function test_challengeWindow_succeedsExactlyAtTheBoundary() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        uint64 postedAt = _now();
        _post(s);

        vm.warp(postedAt + WINDOW);
        escrow.execute(s.settlementId);
        assertTrue(escrow.settlementConsumed(s.settlementId));
    }

    function test_challengeWindow_voidedPostingReturnsMandateToUnposted() public {
        _fund(100e6);
        Settlement memory posted = _twoWaySplit(7500, 6000);
        _post(posted);
        assertEq(escrow.activePosting(MANDATE), posted.settlementId);

        // A competing set for the SAME settlementId with different parameters: the
        // transcription claim. Same mandateId, decisionHash and nonce by construction.
        Settlement memory competing = _twoWaySplit(5000, 6000);
        assertEq(competing.settlementId, posted.settlementId, "same id, different numbers");

        vm.prank(stranger);
        escrow.challenge(competing, emptySigs);

        assertEq(escrow.activePosting(MANDATE), bytes32(0), "posting voided");
        assertFalse(escrow.settlementConsumed(posted.settlementId), "the adapter may re-post");
        assertEq(escrow.heldFor(MANDATE), 100e6, "a challenge moves no money");

        // And the correct parameters can then be posted and executed.
        _post(competing);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(competing.settlementId);
        assertEq(usdc.balanceOf(workerA), 30e6); // 100 * 50% * 60%
        _assertIdentity(MANDATE);
    }

}

contract EscrowRefusalsTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G6 — every path that would move money early must revert
       ══════════════════════════════════════════════════════════════════════ */

    function test_revertWhen_executeWithoutAPosting() public {
        _fund(100e6);
        bytes32 unknown = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.PostingNotFound.selector, unknown));
        escrow.execute(unknown);
    }

    function test_revertWhen_executeTwice() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, s.settlementId)
        );
        escrow.execute(s.settlementId);
    }

    function test_revertWhen_executeOnAChallengedPosting() public {
        _fund(100e6);
        Settlement memory posted = _twoWaySplit(7500, 6000);
        _post(posted);
        Settlement memory competing = _twoWaySplit(5000, 6000);
        vm.prank(stranger);
        escrow.challenge(competing, emptySigs);

        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.PostingNotFound.selector, posted.settlementId)
        );
        escrow.execute(posted.settlementId);
        assertEq(escrow.heldFor(MANDATE), 100e6);
    }

    function test_revertWhen_postingAgainstAnUnfundedMandate() public {
        Settlement memory s = _twoWaySplit(5000, 5000);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateNotFunded.selector, MANDATE));
        escrow.postSettlement(s, emptySigs);
    }

    /// @dev Invariant I3 and "bounded by the on-chain record": the escrow re-derives the
    ///      settlement id and refuses a signed id that disagrees with its own triple.
    function test_revertWhen_postedSettlementIdDoesNotMatchItsTriple() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        bytes32 derived = s.settlementId;
        s.settlementId = keccak256("something else");
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementIdMismatch.selector, s.settlementId, derived)
        );
        escrow.postSettlement(s, emptySigs);
    }

    /// @dev Invariant I1's tripwire. An accepted-but-not-finalized decision has no
    ///      finality timestamp, and zero is the shape a "settle it anyway" bug takes.
    function test_revertWhen_decisionIsNotFinalized() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        s.genlayerFinalizedAt = 0;
        vm.expectRevert(WRKEscrow.DecisionNotFinalized.selector);
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_basisPointsDoNotSumToTenThousand() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(7500, 5000);
        s.refundBp = 2400;
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.BasisPointsMustSumToDenominator.selector, s.releaseBp, s.refundBp
            )
        );
        escrow.postSettlement(s, emptySigs);
    }

    /// @dev Invariant I6: the escrow cannot introduce a payee.
    function test_revertWhen_payingAnAddressThatIsNotAnAcceptedWorker() public {
        _fund(100e6);
        address[] memory payees = new address[](1);
        payees[0] = stranger;
        uint16[] memory shares = new uint16[](1);
        shares[0] = BP16;
        Settlement memory s = _settlement(BP16, payees, shares, 1);

        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.NotAnAcceptedWorker.selector, MANDATE, stranger)
        );
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_aPayeeIsListedTwice() public {
        _fund(100e6);
        address[] memory payees = new address[](2);
        payees[0] = workerA;
        payees[1] = workerA;
        uint16[] memory shares = new uint16[](2);
        shares[0] = 5000;
        shares[1] = 5000;
        Settlement memory s = _settlement(BP16, payees, shares, 1);

        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.DuplicatePayee.selector, workerA));
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_sharesDoNotSumToTenThousand() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(BP16, 6000);
        s.shareBp[1] = 3999;
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.SharesMustSumToDenominator.selector, 9999));
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_releasingWithNoPayees() public {
        _fund(100e6);
        Settlement memory s = _settlement(5000, new address[](0), new uint16[](0), 1);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.NoPayeesForRelease.selector, 5000));
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_payeeAndShareLengthsDisagree() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(BP16, 5000);
        uint16[] memory oneShare = new uint16[](1);
        oneShare[0] = BP16;
        s.shareBp = oneShare;
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.PayeeShareLengthMismatch.selector, 2, 1));
        escrow.postSettlement(s, emptySigs);
    }

    function test_revertWhen_postingTwiceForOneMandate() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(7500, 6000);
        _post(s);
        Settlement memory second = _twoWaySplit(5000, 6000);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.SettlementAlreadyPosted.selector, MANDATE, s.settlementId
            )
        );
        escrow.postSettlement(second, emptySigs);
    }

    function test_revertWhen_fundingTheSameMandateTwice() public {
        _fund(100e6);
        vm.prank(dao);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadyFunded.selector, MANDATE));
        escrow.fund(MANDATE, _workers(), 1e6, _deadline());
    }

    function test_revertWhen_refundDeadlineIsSoonerThanTheFloor() public {
        uint64 tooSoon = _now() + MIN_DELAY - 1;
        vm.prank(dao);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.RefundDeadlineTooSoon.selector,
                tooSoon,
                _now() + MIN_DELAY
            )
        );
        escrow.fund(MANDATE, _workers(), 100e6, tooSoon);
    }

    function test_revertWhen_refundingBeforeTheDeadline() public {
        _fund(100e6);
        vm.warp(_deadline() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.RefundNotYetAvailable.selector, _deadline())
        );
        escrow.refundExpired(MANDATE);
    }

    /// @dev The escape hatch must not outrun a settlement already in its window.
    function test_revertWhen_refundingWhileAPostingIsActive() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(7500, 6000);
        _post(s);
        vm.warp(_deadline() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.MandateHasActivePosting.selector, MANDATE, s.settlementId
            )
        );
        escrow.refundExpired(MANDATE);
    }

    function test_revertWhen_refundingAfterSettlement() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(5000, 5000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);
        vm.warp(_deadline() + 1);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.refundExpired(MANDATE);
    }

    /// @dev Invariant I12: a challenge is a transcription claim. Identical parameters
    ///      express no disagreement, so there is nothing to resolve.
    function test_revertWhen_challengingWithIdenticalParameters() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(7500, 6000);
        _post(s);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.ChallengeMustDifferFromPosting.selector, s.settlementId
            )
        );
        escrow.challenge(s, emptySigs);
    }

    function test_revertWhen_challengingAnExecutedSettlement() public {
        _fund(100e6);
        Settlement memory s = _twoWaySplit(7500, 6000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        Settlement memory competing = _twoWaySplit(5000, 6000);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, s.settlementId)
        );
        escrow.challenge(competing, emptySigs);
    }

    /// @dev The verifier's refusal cannot be ignored: it reverts rather than returning
    ///      a bool, so there is no call site that can drop it.
    function test_revertWhen_theVerifierRefusesTheAttestations() public {
        _fund(100e6);
        verifier.setAccepting(false);
        Settlement memory s = _twoWaySplit(5000, 5000);
        vm.expectRevert(MockVerifier.MockVerifierRejected.selector);
        escrow.postSettlement(s, emptySigs);
        assertEq(escrow.activePosting(MANDATE), bytes32(0));
        assertEq(escrow.heldFor(MANDATE), 100e6);
    }

    function test_revertWhen_fundingWithZeroAmountOrNoWorkers() public {
        vm.startPrank(dao);
        vm.expectRevert(WRKEscrow.ZeroAmount.selector);
        escrow.fund(MANDATE, _workers(), 0, _deadline());

        vm.expectRevert(WRKEscrow.NoWorkers.selector);
        escrow.fund(MANDATE, new address[](0), 1e6, _deadline());

        vm.expectRevert(WRKEscrow.ZeroMandateId.selector);
        escrow.fund(bytes32(0), _workers(), 1e6, _deadline());

        address[] memory withZero = new address[](2);
        withZero[0] = workerA;
        withZero[1] = address(0);
        vm.expectRevert(WRKEscrow.ZeroAddress.selector);
        escrow.fund(MANDATE, withZero, 1e6, _deadline());

        address[] memory duplicated = new address[](2);
        duplicated[0] = workerA;
        duplicated[1] = workerA;
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.DuplicateWorker.selector, workerA));
        escrow.fund(MANDATE, duplicated, 1e6, _deadline());
        vm.stopPrank();
    }

}

contract EscrowReentrancyTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       G7 — reentrancy
       ══════════════════════════════════════════════════════════════════════ */

    /// @dev A token that reenters and swallows its own failure is the dangerous case:
    ///      the outer settlement still succeeds, so a double release would be invisible
    ///      in the transaction's success. Assert the reentry was attempted, that it
    ///      failed, and that exactly one payout happened.
    function test_reentrancy_tokenCallbackCannotDoubleRelease() public {
        ReentrantToken token = new ReentrantToken();
        WRKEscrow reEscrow =
            new WRKEscrow(IERC20(address(token)), IWRKSettlementVerifier(address(verifier)));
        token.mint(dao, 1_000e6);
        vm.startPrank(dao);
        token.approve(address(reEscrow), type(uint256).max);
        reEscrow.fund(MANDATE, _workers(), 100e6, _deadline());
        vm.stopPrank();

        address[] memory payees = new address[](1);
        payees[0] = workerA;
        uint16[] memory shares = new uint16[](1);
        shares[0] = BP16;
        Settlement memory s;
        s.mandateId = MANDATE;
        s.decisionHash = DECISION_HASH;
        s.nonce = 1;
        s.settlementId = reEscrow.deriveSettlementId(MANDATE, DECISION_HASH, 1);
        s.releaseBp = BP16;
        s.refundBp = 0;
        s.payees = payees;
        s.shareBp = shares;
        s.genlayerFinalizedAt = _now();

        reEscrow.postSettlement(s, emptySigs);
        token.arm(reEscrow, s.settlementId);
        vm.warp(block.timestamp + WINDOW);
        reEscrow.execute(s.settlementId);

        assertGt(token.reentryAttempts(), 0, "the token must actually have reentered");
        assertTrue(token.lastReentryReverted(), "the reentrant execute must have failed");
        assertEq(token.balanceOf(workerA), 100e6, "paid exactly once");
        assertEq(token.balanceOf(address(reEscrow)), 0);
        assertTrue(reEscrow.settlementConsumed(s.settlementId));
        assertTrue(reEscrow.solvent());
    }

    /// @dev And the guard itself is present on every state-changing entry point.
    function test_reentrancy_guardIsArmedOnExecute() public {
        ReentrantToken token = new ReentrantToken();
        WRKEscrow reEscrow =
            new WRKEscrow(IERC20(address(token)), IWRKSettlementVerifier(address(verifier)));
        token.mint(dao, 1_000e6);
        vm.startPrank(dao);
        token.approve(address(reEscrow), type(uint256).max);
        reEscrow.fund(MANDATE, _workers(), 100e6, _deadline());
        vm.stopPrank();
        vm.warp(block.timestamp + MIN_DELAY + 1 days);

        // Reenter from inside the expired-refund transfer instead of the payout path.
        token.arm(reEscrow, keccak256("irrelevant"));
        reEscrow.refundExpired(MANDATE);
        assertTrue(token.lastReentryReverted(), "reentry must be refused wherever it comes from");
        assertEq(token.balanceOf(dao), 1_000e6);
    }

}

contract EscrowStructureTest is EscrowFixture {
    /* ══════════════════════════════════════════════════════════════════════
       Structural guarantees
       ══════════════════════════════════════════════════════════════════════ */

    function test_settlementIdIsKeccakOfAbiEncode() public view {
        // docs/CANONICAL.md §2 / SPEC §40. Pinned so the off-chain adapter and the
        // escrow cannot drift apart.
        assertEq(
            escrow.deriveSettlementId(MANDATE, DECISION_HASH, 7),
            keccak256(abi.encode(MANDATE, DECISION_HASH, uint256(7)))
        );
    }

    function testFuzz_settlementIdIsInjective(
        bytes32 mandateId,
        bytes32 decisionHash,
        uint256 nonce
    ) public view {
        bytes32 base = escrow.deriveSettlementId(mandateId, decisionHash, nonce);
        assertTrue(base != escrow.deriveSettlementId(mandateId, decisionHash, nonce ^ 1));
        assertTrue(base != escrow.deriveSettlementId(mandateId ^ bytes32(uint256(1)), decisionHash, nonce));
        assertTrue(base != escrow.deriveSettlementId(mandateId, decisionHash ^ bytes32(uint256(1)), nonce));
    }

    function test_constantsMatchTheArchitectureDocument() public view {
        assertEq(escrow.CHALLENGE_WINDOW(), 1 hours, "owner's 1h challenge window");
        assertEq(escrow.BP_DENOMINATOR(), 10_000);
        assertEq(escrow.MIN_REFUND_DELAY(), 7 days);
        assertEq(escrow.MAX_PAYEES(), 16, "matches max_team_size in the mandate schema");
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(address(escrow.verifier()), address(verifier));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(WRKEscrow.ZeroAddress.selector);
        new WRKEscrow(IERC20(address(0)), IWRKSettlementVerifier(address(verifier)));
        vm.expectRevert(WRKEscrow.ZeroAddress.selector);
        new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(0)));
    }

    /// @dev A surplus pushed in by a stranger must not make the escrow report itself
    ///      broken, and must not become reachable — there is no sweep.
    function test_unsolicitedTransferDoesNotBreakSolvencyOrBecomeSpendable() public {
        _fund(100e6);
        usdc.mint(address(escrow), 500e6);
        assertTrue(escrow.solvent());

        Settlement memory s = _twoWaySplit(BP16, 5000);
        _post(s);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        // Workers receive exactly the mandate's deposit, never the surplus.
        assertEq(usdc.balanceOf(workerA), 50e6);
        assertEq(usdc.balanceOf(workerB), 50e6);
        assertEq(usdc.balanceOf(address(escrow)), 500e6);
        assertTrue(escrow.solvent());
    }
}
