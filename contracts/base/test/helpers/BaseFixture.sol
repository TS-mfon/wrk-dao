// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WRKEscrow} from "../../src/WRKEscrow.sol";
import {WRKSettlementVerifier} from "../../src/WRKSettlementVerifier.sol";
import {IWRKSettlementVerifier, Settlement} from "../../src/interfaces/IWRKSettlementVerifier.sol";

/**
 * Shared test doubles and fixture for the adversarial Base suite.
 *
 * Escrow.t.sol and Settlement.t.sol keep their own inline mocks on purpose: they belong
 * to other leaves, and refactoring them from here would cross an ownership boundary for
 * no correctness gain. A duplicated six-line ERC-20 is cheaper than a shared base that
 * three leaves can break for each other.
 */

/// @dev USDC's shape: six decimals, plain ERC-20 semantics.
contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * A real escrow, a real verifier and a real 2-of-3 attestor set backed by generated
 * keys. Nothing is mocked: these suites exist to find disagreements between the two
 * contracts, and a mock on either side would hide exactly the disagreement that matters.
 */
abstract contract BaseFixture is Test {
    uint256 internal constant BP = 10_000;
    uint16 internal constant BP16 = 10_000;
    uint64 internal constant WINDOW = 1 hours;
    uint64 internal constant MIN_DELAY = 7 days;
    uint64 internal constant START = 1_700_000_000;

    TestUSDC internal usdc;
    WRKSettlementVerifier internal verifier;
    WRKEscrow internal escrow;

    address[] internal attestors;
    uint256[] internal attestorKeys;

    address internal dao = makeAddr("dao");
    address internal workerA = makeAddr("workerA");
    address internal workerB = makeAddr("workerB");
    address internal stranger = makeAddr("stranger");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(START);

        uint256[3] memory raw = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC0FFEE)];
        address[3] memory addrs;
        for (uint256 i = 0; i < 3; ++i) addrs[i] = vm.addr(raw[i]);
        // The verifier requires an ascending set, so sort rather than hope.
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

        usdc = new TestUSDC();
        verifier = new WRKSettlementVerifier(attestors, 2);
        escrow = new WRKEscrow(IERC20(address(usdc)), IWRKSettlementVerifier(address(verifier)));

        usdc.mint(dao, 10_000_000e6);
        vm.prank(dao);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _deadline() internal pure returns (uint64) {
        return START + MIN_DELAY + 1 days;
    }

    function _twoWorkers() internal view returns (address[] memory workers) {
        workers = new address[](2);
        workers[0] = workerA;
        workers[1] = workerB;
    }

    function _fund(bytes32 mandateId, uint256 amount) internal {
        vm.prank(dao);
        escrow.fund(mandateId, _twoWorkers(), amount, _deadline());
    }

    function _settlement(bytes32 mandateId, bytes32 decisionHash, uint16 releaseBp, uint256 nonce)
        internal
        view
        returns (Settlement memory s)
    {
        s.mandateId = mandateId;
        s.decisionHash = decisionHash;
        s.nonce = nonce;
        s.settlementId = escrow.deriveSettlementId(mandateId, decisionHash, nonce);
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
            shares[0] = 6000;
            shares[1] = 4000;
            s.payees = payees;
            s.shareBp = shares;
        }
        s.genlayerFinalizedAt = START;
    }

    /// @dev Signs with the first `count` attestors, which are already address-ascending.
    function _sign(Settlement memory s, uint256 count) internal view returns (bytes[] memory sigs) {
        bytes32 digest = verifier.settlementDigest(s);
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 sv) = vm.sign(attestorKeys[i], digest);
            sigs[i] = abi.encodePacked(r, sv, v);
        }
    }
}
