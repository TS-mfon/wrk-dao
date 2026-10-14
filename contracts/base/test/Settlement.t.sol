// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {WRKEscrow} from "../src/WRKEscrow.sol";
import {WRKSettlementVerifier} from "../src/WRKSettlementVerifier.sol";
import {IWRKSettlementVerifier, Settlement} from "../src/interfaces/IWRKSettlementVerifier.sol";

contract SettlementUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * Shared fixture: a real 2-of-3 attestor set backed by generated keys, a real escrow,
 * and a real verifier. Nothing here is mocked — the point of this suite is that the two
 * contracts agree, and a mock on either side would hide exactly the disagreement that
 * matters.
 */
abstract contract SettlementFixture is Test {
    uint256 constant BP = 10_000;
    uint16 constant BP16 = 10_000;
    uint64 constant WINDOW = 1 hours;
    uint64 constant MIN_DELAY = 7 days;
    uint64 constant START = 1_700_000_000;

    /* Cross-language reference values, computed by packages/types from the EIP-712 spec
       and pasted here as literals. If Solidity and TypeScript ever disagree about the
       type string or the array encoding, these fail rather than silently making every
       attestation unrecoverable. */
    bytes32 constant TS_TYPEHASH = 0x52d0dcaf11da5951a0db60fec2665e42701208def8646f2eb13710a469d6e77c;
    bytes32 constant TS_NAME_HASH = 0x102ae2c08e77b0b75bf9ba0cb05585b4db5752625f3a4834f3f2efc8212c87fc;
    bytes32 constant TS_VERSION_HASH = 0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6;
    bytes32 constant TS_HASH_STRUCT = 0x1a67b0e72831101511af91b187b9274f0dd116126d11ddfdf47c179e75050dbe;
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    SettlementUSDC usdc;
    WRKSettlementVerifier verifier;
    WRKEscrow escrow;

    // Sorted ascending at setUp, because the constructor requires that order.
    address[] attestors;
    uint256[] attestorKeys;

    address dao = makeAddr("dao");
    address workerA;
    address workerB;
    address stranger = makeAddr("stranger");

    bytes32 constant MANDATE = keccak256("mnd_settlement");
    bytes32 constant DECISION_HASH = keccak256("decision");

    function setUp() public virtual {
        vm.warp(START);

        // Three attestor keys, then sorted by address.
        uint256[3] memory raw = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC0FFEE)];
        address[3] memory addrs;
        for (uint256 i = 0; i < 3; ++i) addrs[i] = vm.addr(raw[i]);
        // Insertion sort over three items, carrying the keys with the addresses.
        for (uint256 i = 0; i < 3; ++i) {
            uint256 min = i;
            for (uint256 j = i + 1; j < 3; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[min])) min = j;
            }
            (addrs[i], addrs[min]) = (addrs[min], addrs[i]);
            (raw[i], raw[min]) = (raw[min], raw[i]);
        }
        for (uint256 i = 0; i < 3; ++i) {
            attestors.push(addrs[i]);
            attestorKeys.push(raw[i]);
        }

        usdc = new SettlementUSDC();
        verifier = new WRKSettlementVerifier(attestors, 2);
        escrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(verifier)));

        workerA = makeAddr("workerA");
        workerB = makeAddr("workerB");

        usdc.mint(dao, 1_000_000e6);
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _deadline() internal pure returns (uint64) {
        return START + MIN_DELAY + 1 days;
    }

    function _fund(uint256 amount) internal {
        address[] memory workers = new address[](2);
        workers[0] = workerA;
        workers[1] = workerB;
        vm.prank(dao);
        escrow.fund(MANDATE, workers, amount, _deadline());
    }

    function _settlement(uint16 releaseBp, uint16 shareA, uint256 nonce)
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
        if (releaseBp == 0) {
            s.payees = new address[](0);
            s.shareBp = new uint16[](0);
        } else {
            address[] memory payees = new address[](2);
            payees[0] = workerA;
            payees[1] = workerB;
            uint16[] memory shares = new uint16[](2);
            shares[0] = shareA;
            shares[1] = BP16 - shareA;
            s.payees = payees;
            s.shareBp = shares;
        }
        s.genlayerFinalizedAt = START;
    }

    /// @dev Signs with the first `count` attestors. They are already address-ascending,
    ///      so the resulting array satisfies the verifier's ordering rule.
    function _sign(Settlement memory s, uint256 count) internal view returns (bytes[] memory sigs) {
        bytes32 digest = verifier.settlementDigest(s);
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 vs) = vm.sign(attestorKeys[i], digest);
            sigs[i] = abi.encodePacked(r, vs, v);
        }
    }

    function _signWith(Settlement memory s, uint256[] memory keys)
        internal
        view
        returns (bytes[] memory sigs)
    {
        bytes32 digest = verifier.settlementDigest(s);
        sigs = new bytes[](keys.length);
        for (uint256 i = 0; i < keys.length; ++i) {
            (uint8 v, bytes32 r, bytes32 vs) = vm.sign(keys[i], digest);
            sigs[i] = abi.encodePacked(r, vs, v);
        }
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   G2 — the two languages must agree
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementCrossLanguageTest is SettlementFixture {
    function test_typeHashMatchesTypescript() public view {
        assertEq(verifier.SETTLEMENT_TYPEHASH(), TS_TYPEHASH, "Settlement type hash");
    }

    function test_domainSeparatorMatchesTypescript() public view {
        bytes32 expected = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, TS_NAME_HASH, TS_VERSION_HASH, block.chainid, address(verifier)
            )
        );
        assertEq(verifier.domainSeparator(), expected, "domain separator");
    }

    /// @dev The array-encoding rule, pinned across languages. A dynamic array hashes to
    ///      keccak256 of its members padded to 32 bytes each; encoding addresses as 20
    ///      bytes would produce a plausible-looking but wrong hash that no unit test
    ///      inside one language would catch.
    function test_hashStructMatchesTypescript() public view {
        Settlement memory s;
        s.settlementId = bytes32(0x3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d);
        s.mandateId = bytes32(0x0101010101010101010101010101010101010101010101010101010101010101);
        s.decisionHash = bytes32(0x0202020202020202020202020202020202020202020202020202020202020202);
        s.nonce = 7;
        s.releaseBp = 7500;
        s.refundBp = 2500;
        address[] memory payees = new address[](2);
        payees[0] = 0x2222222222222222222222222222222222222222;
        payees[1] = 0x3333333333333333333333333333333333333333;
        uint16[] memory shares = new uint16[](2);
        shares[0] = 6000;
        shares[1] = 4000;
        s.payees = payees;
        s.shareBp = shares;
        s.genlayerFinalizedAt = 1_790_001_234;

        assertEq(verifier.hashStruct(s), TS_HASH_STRUCT, "hashStruct must match packages/types");
    }

    function test_digestIsDomainBoundHashStruct() public view {
        Settlement memory s = _settlement(7500, 6000, 1);
        bytes32 expected =
            keccak256(abi.encodePacked(hex"1901", verifier.domainSeparator(), verifier.hashStruct(s)));
        assertEq(verifier.settlementDigest(s), expected, "digest = 0x1901 || domain || hashStruct");
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   G3 — full release, partial release and full refund all verify and execute
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementVerifiesTest is SettlementFixture {
    function test_verifiesFullRelease() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 50e6);
        assertEq(usdc.balanceOf(workerB), 50e6);
        assertTrue(escrow.solvent());
    }

    function test_verifiesPartialRelease() public {
        _fund(250e6);
        Settlement memory s = _settlement(7500, 6000, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 112.5e6);
        assertEq(usdc.balanceOf(workerB), 75e6);
        assertEq(usdc.balanceOf(dao), 1_000_000e6 - 250e6 + 62.5e6);
    }

    function test_verifiesFullRefund() public {
        _fund(100e6);
        Settlement memory s = _settlement(0, 0, 1);
        escrow.postSettlement(s, _sign(s, 2));
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 0);
        assertEq(usdc.balanceOf(dao), 1_000_000e6);
    }

    function test_verifiesWithMoreThanTheThreshold() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        escrow.postSettlement(s, _sign(s, 3)); // all three, threshold is 2
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 50e6);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   G4, G7, G9 — refusals
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementRefusalsTest is SettlementFixture {
    function test_revertWhen_quorumShortByOne() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        // Signatures are built BEFORE expectRevert: _sign calls settlementDigest, and an
        // external call between expectRevert and the call under test consumes the
        // expectation. Four tests here failed that way before this was hoisted.
        bytes[] memory sigs = _sign(s, 1);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.QuorumNotMet.selector, 1, 2));
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_quorumIsEmpty() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.QuorumNotMet.selector, 0, 2));
        escrow.postSettlement(s, new bytes[](0));
    }

    /// @dev One attestor signing twice. Caught by ordering, not by a nested loop.
    function test_revertWhen_duplicateSigner() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKeys[0];
        keys[1] = attestorKeys[0];
        bytes[] memory sigs = _signWith(s, keys);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.SignersMustBeAscending.selector, 1));
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_signersDescending() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKeys[1];
        keys[1] = attestorKeys[0];
        bytes[] memory sigs = _signWith(s, keys);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.SignersMustBeAscending.selector, 1));
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_signerIsNotAnAttestor() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        uint256 outsiderKey = 0xDEADBEEF;
        address outsider = vm.addr(outsiderKey);
        // Place the outsider where ordering still holds, so the refusal is about
        // membership rather than about order.
        uint256[] memory keys = new uint256[](2);
        if (uint160(outsider) < uint160(attestors[0])) {
            keys[0] = outsiderKey;
            keys[1] = attestorKeys[0];
        } else {
            keys[0] = attestorKeys[0];
            keys[1] = outsiderKey;
        }
        bytes[] memory sigs = _signWith(s, keys);
        vm.expectRevert(abi.encodeWithSelector(WRKSettlementVerifier.NotAnAttestor.selector, outsider));
        escrow.postSettlement(s, sigs);
    }

    /// @dev A signature gathered for this chain must not verify on another. The digest is
    ///      domain-bound, so changing the chain id changes what the attestors signed.
    function test_revertWhen_crossChainReplay() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes[] memory sigs = _sign(s, 2);
        vm.chainId(8453); // Base mainnet
        vm.expectRevert(); // recovers some other address, which is not an attestor
        escrow.postSettlement(s, sigs);
        vm.chainId(31337);
    }

    function test_revertWhen_wrongVerifyingContract() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes[] memory sigs = _sign(s, 2);

        // A second verifier at a different address: same attestors, same threshold, so
        // only the domain differs.
        WRKSettlementVerifier other = new WRKSettlementVerifier(attestors, 2);
        assertTrue(other.domainSeparator() != verifier.domainSeparator(), "domains must differ");
        vm.expectRevert();
        other.verifySettlement(s, sigs);
    }

    /// @dev ECDSA.recover must reject these rather than returning address(0), which would
    ///      compare equal to an uninitialised attestor slot.
    function test_revertWhen_malformedSignatureLength() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = hex"dead";
        sigs[1] = hex"beef";
        vm.expectRevert();
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_signatureIsMalleable() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes32 digest = verifier.settlementDigest(s);
        (uint8 v, bytes32 r, bytes32 sVal) = vm.sign(attestorKeys[0], digest);

        // Flip s to n - s and v accordingly: a second valid signature for one message.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(sVal));
        uint8 flipped = v == 27 ? 28 : 27;

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(r, highS, flipped);
        sigs[1] = sigs[0];
        vm.expectRevert();
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_parametersChangedAfterSigning() public {
        _fund(100e6);
        Settlement memory s = _settlement(7500, 6000, 1);
        bytes[] memory sigs = _sign(s, 2);
        // The adapter tries to pay the workers more than the attestors agreed to.
        s.releaseBp = BP16;
        s.refundBp = 0;
        vm.expectRevert();
        escrow.postSettlement(s, sigs);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   G5 — replay protection and settlementId injectivity
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementReplayTest is SettlementFixture {
    function test_revertWhen_replayingAnExecutedSettlement() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes[] memory sigs = _sign(s, 2);
        escrow.postSettlement(s, sigs);
        vm.warp(block.timestamp + WINDOW);
        escrow.execute(s.settlementId);

        // Two independent guards stop a replay, and the mandate-level one is checked
        // first because it is the cheaper and broader statement: this mandate's money is
        // already gone. Assert the guard that actually fires rather than the one that
        // reads better.
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateAlreadySettled.selector, MANDATE));
        escrow.postSettlement(s, sigs);

        // And invariant I2's flag is set, which is the guard that holds when the mandate
        // record alone would not — it is never cleared, not even by a challenge.
        assertTrue(escrow.settlementConsumed(s.settlementId), "I2: settlementId consumed forever");
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementAlreadyConsumed.selector, s.settlementId)
        );
        escrow.execute(s.settlementId);
    }

    function testFuzz_settlementIdInjective(bytes32 mandateId, bytes32 decisionHash, uint256 nonce)
        public
        view
    {
        bytes32 base = escrow.deriveSettlementId(mandateId, decisionHash, nonce);
        assertTrue(base != escrow.deriveSettlementId(mandateId, decisionHash, nonce ^ 1));
        assertTrue(base != escrow.deriveSettlementId(mandateId ^ bytes32(uint256(1)), decisionHash, nonce));
        assertTrue(base != escrow.deriveSettlementId(mandateId, decisionHash ^ bytes32(uint256(1)), nonce));
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   G6 — attestors cannot introduce facts the chain does not hold
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementOnChainBindingTest is SettlementFixture {
    /// @dev The pair is what protects the money: the escrow decides admissibility, the
    ///      verifier decides whether the attestors vouched. A fully-attested settlement
    ///      paying a non-worker must still fail.
    function test_revertWhen_attestationDisagreesWithChain_nonWorkerPayee() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        address[] memory payees = new address[](1);
        payees[0] = stranger;
        uint16[] memory shares = new uint16[](1);
        shares[0] = BP16;
        s.payees = payees;
        s.shareBp = shares;

        bytes[] memory sigs = _sign(s, 2); // genuinely attested by a real quorum
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.NotAnAcceptedWorker.selector, MANDATE, stranger)
        );
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_attestationDisagreesWithChain_forgedSettlementId() public {
        _fund(100e6);
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes32 derived = s.settlementId;
        s.settlementId = keccak256("a nicer id");
        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(
            abi.encodeWithSelector(WRKEscrow.SettlementIdMismatch.selector, s.settlementId, derived)
        );
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_attestationDisagreesWithChain_unfundedMandate() public {
        Settlement memory s = _settlement(BP16, 5000, 1);
        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(abi.encodeWithSelector(WRKEscrow.MandateNotFunded.selector, MANDATE));
        escrow.postSettlement(s, sigs);
    }

    function test_revertWhen_attestationDisagreesWithChain_badBasisPoints() public {
        _fund(100e6);
        Settlement memory s = _settlement(7500, 6000, 1);
        s.refundBp = 2400;
        bytes[] memory sigs = _sign(s, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRKEscrow.BasisPointsMustSumToDenominator.selector, uint16(7500), uint16(2400)
            )
        );
        escrow.postSettlement(s, sigs);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   Construction and structure
   ══════════════════════════════════════════════════════════════════════════════ */

contract SettlementConstructionTest is SettlementFixture {
    function test_recordsTheAttestorSetAndThreshold() public view {
        assertEq(verifier.threshold(), 2);
        assertEq(verifier.attestorCount(), 3);
        address[] memory list = verifier.attestors();
        assertEq(list.length, 3);
        for (uint256 i = 0; i < 3; ++i) {
            assertTrue(verifier.isAttestor(list[i]));
            if (i > 0) assertTrue(uint160(list[i]) > uint160(list[i - 1]), "ascending");
        }
        assertFalse(verifier.isAttestor(stranger));
    }

    function test_revertWhen_attestorsNotAscending() public {
        address[] memory bad = new address[](2);
        bad[0] = attestors[1];
        bad[1] = attestors[0];
        vm.expectRevert(
            abi.encodeWithSelector(WRKSettlementVerifier.AttestorsMustBeAscending.selector, 1)
        );
        new WRKSettlementVerifier(bad, 1);
    }

    function test_revertWhen_attestorRepeated() public {
        address[] memory bad = new address[](2);
        bad[0] = attestors[0];
        bad[1] = attestors[0];
        vm.expectRevert(
            abi.encodeWithSelector(WRKSettlementVerifier.AttestorsMustBeAscending.selector, 1)
        );
        new WRKSettlementVerifier(bad, 1);
    }

    function test_revertWhen_thresholdOutOfRange() public {
        vm.expectRevert(
            abi.encodeWithSelector(WRKSettlementVerifier.ThresholdOutOfRange.selector, 0, 3)
        );
        new WRKSettlementVerifier(attestors, 0);
        vm.expectRevert(
            abi.encodeWithSelector(WRKSettlementVerifier.ThresholdOutOfRange.selector, 4, 3)
        );
        new WRKSettlementVerifier(attestors, 4);
    }

    function test_revertWhen_attestorSetIsEmptyOrContainsZero() public {
        vm.expectRevert(WRKSettlementVerifier.NoAttestors.selector);
        new WRKSettlementVerifier(new address[](0), 1);

        address[] memory withZero = new address[](1);
        withZero[0] = address(0);
        vm.expectRevert(WRKSettlementVerifier.ZeroAttestor.selector);
        new WRKSettlementVerifier(withZero, 1);
    }

    /// @dev A 1-of-1 is constructible, because that is what the live testnet run uses.
    ///      It is not a quorum, and leaf-1.6.3:G6 reports it as measured rather than
    ///      letting a report round it up to "M-of-N".
    function test_oneOfOneIsConstructibleAndWorks() public {
        address[] memory one = new address[](1);
        one[0] = attestors[0];
        WRKSettlementVerifier solo = new WRKSettlementVerifier(one, 1);
        assertEq(solo.threshold(), 1);
        assertEq(solo.attestorCount(), 1);

        WRKEscrow soloEscrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(solo)));
        address[] memory workers = new address[](1);
        workers[0] = workerA;
        vm.prank(dao);
        usdc.approve(address(soloEscrow), type(uint256).max);
        vm.prank(dao);
        soloEscrow.fund(MANDATE, workers, 10e6, _deadline());

        Settlement memory s;
        s.mandateId = MANDATE;
        s.decisionHash = DECISION_HASH;
        s.nonce = 1;
        s.settlementId = soloEscrow.deriveSettlementId(MANDATE, DECISION_HASH, 1);
        s.releaseBp = BP16;
        s.refundBp = 0;
        address[] memory payees = new address[](1);
        payees[0] = workerA;
        uint16[] memory shares = new uint16[](1);
        shares[0] = BP16;
        s.payees = payees;
        s.shareBp = shares;
        s.genlayerFinalizedAt = START;

        bytes32 digest = solo.settlementDigest(s);
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(attestorKeys[0], digest);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, sv, v);

        soloEscrow.postSettlement(s, sigs);
        vm.warp(block.timestamp + WINDOW);
        soloEscrow.execute(s.settlementId);
        assertEq(usdc.balanceOf(workerA), 10e6);
    }
}
