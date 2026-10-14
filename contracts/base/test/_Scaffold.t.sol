// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ScaffoldTest is Test {
    // Confirms the remappings, solc version, cancun evm_version and the frozen
    // canonical vector digest all line up before any leaf builds on them.
    function test_toolchainAndCanonicalDigest() public pure {
        // fixtures/canonical-vectors.json :: empty_object
        assertEq(keccak256(bytes("{}")), 0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d);
    }

    function test_abiEncodeIsInjectiveWherePackedIsNot() public pure {
        // docs/CANONICAL.md 2: why abi.encodePacked is forbidden for multi-field hashes.
        assertEq(keccak256(abi.encodePacked("ab", "c")), keccak256(abi.encodePacked("a", "bc")));
        assertTrue(keccak256(abi.encode("ab", "c")) != keccak256(abi.encode("a", "bc")));
    }

    function test_reentrancyGuardCompiles() public {
        Guarded g = new Guarded();
        assertEq(g.ping(), 1);
    }
}

contract Guarded is ReentrancyGuard {
    function ping() external nonReentrant returns (uint256) {
        return 1;
    }
}
