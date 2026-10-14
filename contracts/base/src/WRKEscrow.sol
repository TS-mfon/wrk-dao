// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IWRKEscrow} from "./interfaces/IWRKEscrow.sol";
import {IWRKSettlementVerifier, Settlement} from "./interfaces/IWRKSettlementVerifier.sol";

/**
 * @title WRKEscrow
 * @notice Holds USDC for WRK work mandates and releases it only against a settlement
 *         that M-of-N attestors signed and that survived a one-hour challenge window.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * What this contract is not allowed to do
 * ──────────────────────────────────────────────────────────────────────────────
 * `docs/ARCHITECTURE.md` §1 separates four authorities and the failure mode it guards
 * against is one component acquiring two. This contract has custody authority and
 * nothing else:
 *
 *   - It never forms an opinion about whether work was good. It receives basis points
 *     that attestors co-signed, and re-checks their arithmetic.
 *   - It has **no owner, no admin, no pause and no upgrade path**. `usdc`,
 *     `verifier`, the window and the payee bound are `immutable` or `constant`. An
 *     "upgrade" is a fresh deployment. A pause would be an admin key able to freeze a
 *     worker's money, which is why there isn't one.
 *   - It cannot introduce a payee. Only addresses registered as workers at `fund`
 *     time can be paid (invariant I6), and that set cannot be changed afterwards
 *     (invariant I8).
 *
 * `scripts/verify-no-adjudication.mjs` enforces the shape of those claims
 * structurally, with a positive control, as `leaf-1.3.1:G8`.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The accounting identity
 * ──────────────────────────────────────────────────────────────────────────────
 *      deposited == held + released + refunded        (per mandate, exactly)
 *
 * Asserted at the end of every operation that moves money. `deposited` is the amount
 * **actually received**, measured as a balance delta rather than taken from the
 * caller's argument, so a token that charges a transfer fee cannot make the escrow
 * believe it holds more than it does.
 *
 * Integer division on basis points leaves a remainder, and the remainder goes to the
 * **refund** leg, never to a payee (`docs/ARCHITECTURE.md` §7). That makes two things
 * true at once: rounding can never over-pay a worker, and the identity above holds
 * exactly for every deposit, down to a single atomic unit.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Reentrancy
 * ──────────────────────────────────────────────────────────────────────────────
 * Storage-based `ReentrancyGuard`, deliberately not the transient variant — see
 * `docs/ARCHITECTURE.md` §8.1. `foundry.toml` sets `deny = "warnings"` because a
 * warning in code holding USDC is a finding, and `ReentrancyGuardTransient` pulls in
 * an EIP-1153 advisory warning that would force relaxing warnings-as-errors across
 * this whole layer. A few thousand gas on a path that runs once per settlement did
 * not win that trade.
 *
 * Beyond the guard, `execute` marks the settlement consumed and writes all balances
 * **before** the first transfer, so a malicious token calling back finds a consumed
 * settlement and a settled mandate.
 */
contract WRKEscrow is IWRKEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ── constants and immutables ────────────────────────────────────────── */

    uint256 public constant BP_DENOMINATOR = 10_000;

    /// @notice The owner-chosen challenge window (`docs/ARCHITECTURE.md` §3.3).
    uint64 public constant CHALLENGE_WINDOW = 1 hours;

    /**
     * @notice Floor on how soon a funder may set its own refund deadline.
     *
     * `refundExpired` exists so that a mandate GenLayer never finalises does not lock
     * the DAO's USDC forever. The risk it introduces is a DAO that funds, takes the
     * work, then waits out the clock — so the deadline is chosen at `fund` time,
     * published on-chain before any worker starts, immutable afterwards (I8), and can
     * never be sooner than this.
     */
    uint64 public constant MIN_REFUND_DELAY = 7 days;

    /// @notice Bounds the payout loop. Matches `max_team_size` in the mandate schema.
    uint256 public constant MAX_PAYEES = 16;

    IERC20 public immutable usdc;
    IWRKSettlementVerifier public immutable verifier;

    /* ── storage ─────────────────────────────────────────────────────────── */

    struct MandateEscrow {
        address funder; //            ─┐
        uint64 fundedAt; //            │ one slot
        uint32 workerCount; //        ─┘
        uint64 refundDeadline; //     ─┐ one slot
        bool exists; //               ─┘
        uint256 deposited;
        uint256 released;
        uint256 refunded;
    }

    struct Posting {
        bytes32 decisionHash;
        bytes32 mandateId;
        /// @dev keccak256(abi.encode(releaseBp, refundBp, payees, shareBp, genlayerFinalizedAt)).
        ///      Lets `challenge` compare a competing set in one SLOAD. abi.encode, never
        ///      packed: see docs/CANONICAL.md §2.
        bytes32 paramHash;
        uint256 nonce;
        uint64 postedAt; //           ─┐
        uint64 genlayerFinalizedAt; // │ one slot
        uint16 releaseBp; //           │
        uint16 refundBp; //            │
        bool exists; //               ─┘
        address[] payees;
        uint16[] shareBp;
    }

    mapping(bytes32 => MandateEscrow) private _mandates;
    mapping(bytes32 => mapping(address => bool)) private _isWorker;
    mapping(bytes32 => Posting) private _postings;

    /// @inheritdoc IWRKEscrow
    mapping(bytes32 => bytes32) public activePosting;

    /// @inheritdoc IWRKEscrow
    /// @dev Invariant I2: a settlementId can be executed at most once, ever. Set before
    ///      any transfer, and never cleared — not even by a challenge, because a
    ///      challenge voids a *posting*, and the adapter must be able to re-post the
    ///      same decision correctly.
    mapping(bytes32 => bool) public settlementConsumed;

    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public totalRefunded;

    /* ── errors ──────────────────────────────────────────────────────────── */

    error ZeroMandateId();
    error ZeroAmount();
    error ZeroAddress();
    error MandateAlreadyFunded(bytes32 mandateId);
    error MandateNotFunded(bytes32 mandateId);
    error NoWorkers();
    error TooManyWorkers(uint256 given, uint256 maximum);
    error DuplicateWorker(address worker);
    error RefundDeadlineTooSoon(uint64 given, uint64 minimum);
    error MandateAlreadySettled(bytes32 mandateId);
    error SettlementAlreadyPosted(bytes32 mandateId, bytes32 settlementId);
    error SettlementAlreadyConsumed(bytes32 settlementId);
    error SettlementIdMismatch(bytes32 given, bytes32 derived);
    error DecisionNotFinalized();
    error BasisPointsMustSumToDenominator(uint16 releaseBp, uint16 refundBp);
    error PayeeShareLengthMismatch(uint256 payees, uint256 shares);
    error TooManyPayees(uint256 given, uint256 maximum);
    error PayeesWithoutRelease(uint16 releaseBp);
    error NoPayeesForRelease(uint16 releaseBp);
    error SharesMustSumToDenominator(uint256 total);
    error NotAnAcceptedWorker(bytes32 mandateId, address payee);
    error DuplicatePayee(address payee);
    error PostingNotFound(bytes32 settlementId);
    error PostingNotActive(bytes32 settlementId);
    error ChallengeWindowOpen(uint64 postedAt, uint64 executableAt);
    error ChallengeMustDifferFromPosting(bytes32 settlementId);
    /// @dev A competing set naming a different mandate than the posting it challenges.
    ///      Previously reported as SettlementIdMismatch(id, id) -- both arguments
    ///      identical, which told a caller nothing about what was actually wrong.
    error ChallengeMandateMismatch(bytes32 posted, bytes32 competing);
    error MandateHasActivePosting(bytes32 mandateId, bytes32 settlementId);
    error RefundNotYetAvailable(uint64 refundDeadline);
    error AccountingBroken(uint256 deposited, uint256 released, uint256 refunded);

    /* ── construction ────────────────────────────────────────────────────── */

    constructor(IERC20 usdc_, IWRKSettlementVerifier verifier_) {
        if (address(usdc_) == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        verifier = verifier_;
    }

    /* ── fund ────────────────────────────────────────────────────────────── */

    /**
     * @notice Deposit USDC for `mandateId` and fix the set of addresses that may ever
     *         be paid from it.
     *
     * One deposit per mandate. Top-ups are deliberately absent: every top-up path has
     * to answer "may the worker set change?", and the only safe answer is no, which
     * makes the feature a strictly more complex way to do nothing. If more money is
     * needed, that is a new mandate.
     *
     * @param workers        The mandate's accepted workers. Only these can be payees (I6),
     *                       and the set is immutable afterwards (I8).
     * @param amount         Amount to pull via `transferFrom`. The amount *received* is
     *                       what gets recorded.
     * @param refundDeadline When `refundExpired` becomes callable. At least
     *                       `MIN_REFUND_DELAY` from now, and visible on-chain before any
     *                       worker commits.
     */
    function fund(
        bytes32 mandateId,
        address[] calldata workers,
        uint256 amount,
        uint64 refundDeadline
    ) external nonReentrant {
        if (mandateId == bytes32(0)) revert ZeroMandateId();
        if (amount == 0) revert ZeroAmount();
        if (_mandates[mandateId].exists) revert MandateAlreadyFunded(mandateId);
        if (workers.length == 0) revert NoWorkers();
        if (workers.length > MAX_PAYEES) revert TooManyWorkers(workers.length, MAX_PAYEES);

        uint64 minimum = uint64(block.timestamp) + MIN_REFUND_DELAY;
        if (refundDeadline < minimum) revert RefundDeadlineTooSoon(refundDeadline, minimum);

        for (uint256 i = 0; i < workers.length; ++i) {
            address worker = workers[i];
            if (worker == address(0)) revert ZeroAddress();
            if (_isWorker[mandateId][worker]) revert DuplicateWorker(worker);
            _isWorker[mandateId][worker] = true;
        }

        // Record what arrived, not what was asked for. A fee-on-transfer token would
        // otherwise leave the escrow believing it holds more than it does, and the
        // shortfall would surface as a failed transfer to the last payee.
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        _mandates[mandateId] = MandateEscrow({
            funder: msg.sender,
            fundedAt: uint64(block.timestamp),
            workerCount: uint32(workers.length),
            refundDeadline: refundDeadline,
            exists: true,
            deposited: received,
            released: 0,
            refunded: 0
        });
        totalDeposited += received;

        emit MandateFunded(mandateId, msg.sender, received, refundDeadline, workers.length);
    }

    /* ── post ────────────────────────────────────────────────────────────── */

    /**
     * @notice Post a settlement for a funded mandate, starting the challenge window.
     *
     * Every parameter is re-checked against the on-chain record before the attestor
     * signatures are even looked at. That is what "bounded by the on-chain record"
     * means (`docs/ARCHITECTURE.md` §8): attestors cannot introduce facts, only
     * co-sign facts the chain already holds. In particular `settlementId` is
     * re-derived here and a mismatch is refused, so the signed id cannot disagree
     * with the triple it claims to summarise (invariant I3).
     */
    function postSettlement(Settlement calldata settlement, bytes[] calldata signatures)
        external
        nonReentrant
    {
        bytes32 mandateId = settlement.mandateId;
        MandateEscrow storage mandate = _mandates[mandateId];
        if (!mandate.exists) revert MandateNotFunded(mandateId);
        if (mandate.released != 0 || mandate.refunded != 0) revert MandateAlreadySettled(mandateId);

        bytes32 settlementId = settlement.settlementId;
        if (settlementConsumed[settlementId]) revert SettlementAlreadyConsumed(settlementId);

        bytes32 current = activePosting[mandateId];
        if (current != bytes32(0)) revert SettlementAlreadyPosted(mandateId, current);

        bytes32 derived = deriveSettlementId(mandateId, settlement.decisionHash, settlement.nonce);
        if (settlementId != derived) revert SettlementIdMismatch(settlementId, derived);

        // Invariant I1's on-chain tripwire. A decision that is accepted but not yet
        // finalised has no finality timestamp, and a zero here is the shape a
        // "settle it anyway" bug takes.
        if (settlement.genlayerFinalizedAt == 0) revert DecisionNotFinalized();

        _validateSplit(mandateId, settlement);

        // Only now: does the attestor set vouch for exactly these parameters, on this
        // chain, for this verifying contract? Reverts if not.
        verifier.verifySettlement(settlement, signatures);

        Posting storage posting = _postings[settlementId];
        posting.decisionHash = settlement.decisionHash;
        posting.mandateId = mandateId;
        posting.paramHash = _paramHash(settlement);
        posting.nonce = settlement.nonce;
        posting.postedAt = uint64(block.timestamp);
        posting.genlayerFinalizedAt = settlement.genlayerFinalizedAt;
        posting.releaseBp = settlement.releaseBp;
        posting.refundBp = settlement.refundBp;
        posting.exists = true;
        posting.payees = settlement.payees;
        posting.shareBp = settlement.shareBp;

        activePosting[mandateId] = settlementId;

        emit SettlementPosted(
            mandateId,
            settlementId,
            settlement.decisionHash,
            settlement.releaseBp,
            uint64(block.timestamp) + CHALLENGE_WINDOW
        );
    }

    /* ── challenge ───────────────────────────────────────────────────────── */

    /**
     * @notice Void an active posting by submitting a competing, equally-attested set of
     *         parameters for the same settlementId.
     *
     * A challenge asserts exactly one thing: **the posted settlement does not match the
     * finalized GenLayer decision**. It is a claim about transcription, never about
     * correctness (invariant I12), and the function's shape is the enforcement —
     * there is no field in which to express "the decision was wrong". Disagreement
     * with a decision belongs to GenLayer's appeal path, before finality (SPEC §34).
     *
     * Resolution is mechanical, with no human and no model involved: either M-of-N
     * attestors signed parameters that differ from the posted ones for this same
     * settlementId, or they did not.
     *
     * Calling is permissionless, but succeeding is not: a challenge needs a valid
     * M-of-N attestation set, so in practice only the attestor set can challenge, and
     * a successful challenge is itself on-chain evidence that the attestors signed two
     * conflicting things for one settlementId — misbehaviour that is visible and
     * attributable. That is also why this cannot be used to grief: a caller without M
     * signatures cannot void anything.
     *
     * Voiding is cheap. Wrongly releasing is not. So the posting is discarded and the
     * adapter must re-post; `settlementConsumed` is deliberately left false so the
     * correct parameters can still be posted for the same decision.
     */
    function challenge(Settlement calldata competing, bytes[] calldata signatures)
        external
        nonReentrant
    {
        bytes32 settlementId = competing.settlementId;
        Posting storage posting = _postings[settlementId];
        if (!posting.exists) revert PostingNotFound(settlementId);
        if (settlementConsumed[settlementId]) revert SettlementAlreadyConsumed(settlementId);

        bytes32 mandateId = posting.mandateId;
        if (activePosting[mandateId] != settlementId) revert PostingNotActive(settlementId);
        if (competing.mandateId != mandateId) revert ChallengeMandateMismatch(mandateId, competing.mandateId);

        // The competing set must be internally consistent too, or a challenger could
        // void a posting with a payload the escrow would never have accepted.
        bytes32 derived = deriveSettlementId(mandateId, competing.decisionHash, competing.nonce);
        if (settlementId != derived) revert SettlementIdMismatch(settlementId, derived);

        bytes32 competingParams = _paramHash(competing);
        bytes32 postedParams = posting.paramHash;
        if (competingParams == postedParams) revert ChallengeMustDifferFromPosting(settlementId);

        verifier.verifySettlement(competing, signatures);

        delete _postings[settlementId];
        activePosting[mandateId] = bytes32(0);

        emit SettlementChallenged(mandateId, settlementId, postedParams, competingParams, msg.sender);
    }

    /* ── execute ─────────────────────────────────────────────────────────── */

    /**
     * @notice Transfer USDC per a posting whose challenge window has elapsed.
     *
     * Permissionless on purpose. A GitHub Actions cron keeper calls this for liveness,
     * and `docs/ARCHITECTURE.md` §3.3 is explicit that the keeper buys liveness and
     * never authority: if it is offline, compromised or malicious, the worst case is
     * delayed settlement, because anyone may call this and every check is made here.
     *
     * Checks-effects-interactions throughout: the settlement is marked consumed and
     * every balance is written before the first transfer, so a token that calls back
     * finds a consumed settlement and a settled mandate.
     */
    function execute(bytes32 settlementId) external nonReentrant {
        Posting storage posting = _postings[settlementId];
        if (!posting.exists) revert PostingNotFound(settlementId);
        if (settlementConsumed[settlementId]) revert SettlementAlreadyConsumed(settlementId);

        bytes32 mandateId = posting.mandateId;
        if (activePosting[mandateId] != settlementId) revert PostingNotActive(settlementId);

        uint64 ready = posting.postedAt + CHALLENGE_WINDOW;
        // Timestamp dependence, deliberate and bounded. A proposer can nudge
        // `block.timestamp` by a few seconds; the window is 3600. Shaving seconds off a
        // one-hour window changes nothing an attacker can use, and the alternative —
        // counting blocks — would make the window drift against the wall-clock hour the
        // spec names every time block time changes.
        if (block.timestamp < ready) revert ChallengeWindowOpen(posting.postedAt, ready);

        MandateEscrow storage mandate = _mandates[mandateId];
        if (mandate.released != 0 || mandate.refunded != 0) revert MandateAlreadySettled(mandateId);

        // Invariant I2, before anything else can happen.
        settlementConsumed[settlementId] = true;

        uint256 deposited = mandate.deposited;
        uint256 pool = (deposited * posting.releaseBp) / BP_DENOMINATOR;

        uint256 payeeCount = posting.payees.length;
        uint256[] memory amounts = new uint256[](payeeCount);
        uint256 paid;
        for (uint256 i = 0; i < payeeCount; ++i) {
            uint256 amount = (pool * posting.shareBp[i]) / BP_DENOMINATOR;
            amounts[i] = amount;
            paid += amount;
        }

        // Both floors shed value, and every shed unit lands here rather than being
        // handed to a payee (docs/ARCHITECTURE.md §7).
        uint256 refund = deposited - paid;

        mandate.released = paid;
        mandate.refunded = refund;
        totalReleased += paid;
        totalRefunded += refund;
        activePosting[mandateId] = bytes32(0);

        if (mandate.released + mandate.refunded != deposited) {
            revert AccountingBroken(deposited, mandate.released, mandate.refunded);
        }

        emit SettlementExecuted(mandateId, settlementId, paid, refund);

        for (uint256 i = 0; i < payeeCount; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            address payee = posting.payees[i];
            emit PayeePaid(settlementId, payee, posting.shareBp[i], amount);
            usdc.safeTransfer(payee, amount);
        }
        if (refund != 0) {
            usdc.safeTransfer(mandate.funder, refund);
        }
    }

    /* ── refundExpired ───────────────────────────────────────────────────── */

    /**
     * @notice Return the full deposit to its funder after the refund deadline, if no
     *         settlement was ever posted.
     *
     * A liveness escape hatch, not a settlement path. It can only pay the address that
     * deposited the money, so it cannot enrich an attacker, and it is blocked while a
     * posting is active so it cannot be used to outrun a settlement that is already in
     * its challenge window.
     *
     * The risk it carries, stated plainly: a DAO could fund, take delivery of the work,
     * and then wait out the clock rather than letting adjudication finish. The
     * mitigations are that the deadline is published on-chain before any worker commits,
     * cannot be shortened afterwards (I8), can never be sooner than `MIN_REFUND_DELAY`,
     * and that a posted settlement blocks this path outright. The alternative — no
     * escape hatch at all — locks a DAO's USDC forever whenever GenLayer fails to
     * finalise, which is a worse failure with no recovery.
     */
    function refundExpired(bytes32 mandateId) external nonReentrant {
        MandateEscrow storage mandate = _mandates[mandateId];
        if (!mandate.exists) revert MandateNotFunded(mandateId);
        if (mandate.released != 0 || mandate.refunded != 0) revert MandateAlreadySettled(mandateId);

        bytes32 posted = activePosting[mandateId];
        if (posted != bytes32(0)) revert MandateHasActivePosting(mandateId, posted);
        // Same bounded timestamp dependence as `execute`, against a 7-day floor rather
        // than a 1-hour one, so the margin is three orders of magnitude larger.
        if (block.timestamp < mandate.refundDeadline) {
            revert RefundNotYetAvailable(mandate.refundDeadline);
        }

        uint256 amount = mandate.deposited;
        mandate.refunded = amount;
        totalRefunded += amount;

        if (mandate.released + mandate.refunded != mandate.deposited) {
            revert AccountingBroken(mandate.deposited, mandate.released, mandate.refunded);
        }

        emit ExpiredRefund(mandateId, mandate.funder, amount);
        usdc.safeTransfer(mandate.funder, amount);
    }

    /* ── internal ────────────────────────────────────────────────────────── */

    /**
     * @dev Re-checks the money arithmetic and the payee set against the on-chain
     *      record. Every rule here is also enforced off-chain in `packages/types` and
     *      `contracts/genlayer/lib`; doing it again on-chain is the point, because this
     *      is the only layer that cannot be bypassed.
     */
    function _validateSplit(bytes32 mandateId, Settlement calldata settlement) private view {
        if (uint256(settlement.releaseBp) + uint256(settlement.refundBp) != BP_DENOMINATOR) {
            revert BasisPointsMustSumToDenominator(settlement.releaseBp, settlement.refundBp);
        }

        uint256 payeeCount = settlement.payees.length;
        if (payeeCount != settlement.shareBp.length) {
            revert PayeeShareLengthMismatch(payeeCount, settlement.shareBp.length);
        }
        if (payeeCount > MAX_PAYEES) revert TooManyPayees(payeeCount, MAX_PAYEES);

        if (payeeCount == 0) {
            // A full rejection pays nobody. Any release with no payee is a bug, not a
            // rounding convenience.
            if (settlement.releaseBp != 0) revert NoPayeesForRelease(settlement.releaseBp);
            return;
        }

        uint256 total;
        for (uint256 i = 0; i < payeeCount; ++i) {
            address payee = settlement.payees[i];
            // Invariant I6: the escrow cannot introduce a payee, only pay one the
            // mandate already accepted.
            if (!_isWorker[mandateId][payee]) revert NotAnAcceptedWorker(mandateId, payee);
            for (uint256 j = 0; j < i; ++j) {
                if (settlement.payees[j] == payee) revert DuplicatePayee(payee);
            }
            total += settlement.shareBp[i];
        }
        if (total != BP_DENOMINATOR) revert SharesMustSumToDenominator(total);
    }

    /// @dev abi.encode, never abi.encodePacked — see docs/CANONICAL.md §2.
    function _paramHash(Settlement calldata settlement) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                settlement.releaseBp,
                settlement.refundBp,
                settlement.payees,
                settlement.shareBp,
                settlement.genlayerFinalizedAt
            )
        );
    }

    /* ── reads ───────────────────────────────────────────────────────────── */

    /**
     * @notice `settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce))`
     *         (SPEC §40, invariant I3).
     * @dev `abi.encode` and not `abi.encodePacked`. Packed encoding concatenates
     *      without length prefixes, so two different field splits can produce identical
     *      bytes and therefore identical settlement ids. With three fixed-width fields
     *      the two happen to agree today; using `encode` means that stays true if a
     *      dynamic field is ever added, rather than becoming a collision.
     */
    function deriveSettlementId(bytes32 mandateId, bytes32 decisionHash, uint256 nonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(mandateId, decisionHash, nonce));
    }

    function heldFor(bytes32 mandateId) external view returns (uint256) {
        MandateEscrow storage mandate = _mandates[mandateId];
        return mandate.deposited - mandate.released - mandate.refunded;
    }

    function isAcceptedWorker(bytes32 mandateId, address account) external view returns (bool) {
        return _isWorker[mandateId][account];
    }

    function executableAt(bytes32 settlementId) external view returns (uint64) {
        Posting storage posting = _postings[settlementId];
        if (!posting.exists) return 0;
        return posting.postedAt + CHALLENGE_WINDOW;
    }

    function mandateOf(bytes32 mandateId)
        external
        view
        returns (
            address funder,
            uint256 deposited,
            uint256 released,
            uint256 refunded,
            uint64 fundedAt,
            uint64 refundDeadline,
            uint32 workerCount,
            bool exists
        )
    {
        MandateEscrow storage mandate = _mandates[mandateId];
        return (
            mandate.funder,
            mandate.deposited,
            mandate.released,
            mandate.refunded,
            mandate.fundedAt,
            mandate.refundDeadline,
            mandate.workerCount,
            mandate.exists
        );
    }

    function postingOf(bytes32 settlementId)
        external
        view
        returns (
            bytes32 mandateId,
            bytes32 decisionHash,
            bytes32 paramHash,
            uint256 nonce,
            uint64 postedAt,
            uint64 genlayerFinalizedAt,
            uint16 releaseBp,
            uint16 refundBp,
            bool exists
        )
    {
        Posting storage posting = _postings[settlementId];
        return (
            posting.mandateId,
            posting.decisionHash,
            posting.paramHash,
            posting.nonce,
            posting.postedAt,
            posting.genlayerFinalizedAt,
            posting.releaseBp,
            posting.refundBp,
            posting.exists
        );
    }

    function payeesOf(bytes32 settlementId)
        external
        view
        returns (address[] memory payees, uint16[] memory shareBp)
    {
        Posting storage posting = _postings[settlementId];
        return (posting.payees, posting.shareBp);
    }

    /**
     * @notice True while the contract's USDC balance covers everything it still owes.
     * @dev `>=` rather than `==` on purpose: anyone can push tokens to this address and
     *      a strict equality would let a stranger make the escrow report itself broken.
     *      A surplus is harmless and unreachable — there is no sweep.
     */
    function solvent() external view returns (bool) {
        return usdc.balanceOf(address(this)) >= totalDeposited - totalReleased - totalRefunded;
    }
}
