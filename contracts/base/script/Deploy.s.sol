// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WRKEscrow} from "../src/WRKEscrow.sol";
import {WRKSettlementVerifier} from "../src/WRKSettlementVerifier.sol";
import {IWRKSettlementVerifier} from "../src/interfaces/IWRKSettlementVerifier.sol";

/**
 * Deploys the Base settlement layer and records what it deployed.
 *
 * Order is forced by the design: the escrow holds an **immutable** reference to the
 * verifier, so the verifier must exist first. There is no setter to fix a wrong order
 * afterwards, which is deliberate — a settable verifier would make every past
 * attestation re-interpretable.
 *
 * Dry run (no key, no broadcast, nothing touched on chain):
 *
 *     forge script script/Deploy.s.sol --root contracts/base
 *
 * Live:
 *
 *     forge script script/Deploy.s.sol --root contracts/base \
 *       --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --private-key $BASE_DEPLOYER_KEY
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * On the attestor set
 * ──────────────────────────────────────────────────────────────────────────────
 * `SETTLEMENT_THRESHOLD` defaults to the number of attestor keys found, and the script
 * prints the threshold it is about to use in `M-of-N` form. If one key is supplied, it
 * says `1-of-1` — which is **not a quorum**, and saying so here is the point: a 1-of-1
 * is a single point of trust, and a deployment log that rounded it up to "M-of-N
 * attestation deployed" would be the kind of true-but-misleading claim this project's
 * gates exist to prevent. `deploy/verify-attestor-threshold.mjs` reads the recorded
 * value back and reports it as measured.
 */
contract Deploy is Script {
    /// @dev Circle's USDC on Base Sepolia. Overridable so the script is testable against
    ///      a mock, but defaulted so a live run cannot quietly point at nothing.
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @dev Stands in for an attestor during simulation only. Deliberately an address
    ///      with no known key, and refused outright when broadcasting.
    address constant DRY_RUN_PLACEHOLDER = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        address usdc = vm.envOr("BASE_SEPOLIA_USDC", BASE_SEPOLIA_USDC);
        address[] memory attestors = _readAttestors();
        uint256 threshold = vm.envOr("SETTLEMENT_THRESHOLD", attestors.length);

        if (attestors.length == 0) {
            // A simulation with no attestor set is useful — it is how the deploy gate runs
            // in CI, and it still exercises construction, wiring and the written record.
            // A *broadcast* with no attestor set would deploy a verifier whose only
            // attestor is a placeholder nobody holds the key to, permanently freezing
            // every settlement. So the placeholder is allowed in simulation and refused
            // when broadcasting, rather than relying on whoever runs it to notice.
            require(
                !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast),
                "set SETTLEMENT_ATTESTOR_1..N before broadcasting"
            );
            attestors = new address[](1);
            attestors[0] = DRY_RUN_PLACEHOLDER;
            threshold = 1;
            console.log("NO ATTESTOR SET FOUND -- simulating with a placeholder. Not deployable.");
        }
        require(threshold > 0 && threshold <= attestors.length, "SETTLEMENT_THRESHOLD out of range");

        console.log("=== WRK Base settlement layer ===");
        console.log("chain id          ", block.chainid);
        console.log("usdc              ", usdc);
        console.log("attestors         ", attestors.length);
        for (uint256 i = 0; i < attestors.length; ++i) {
            console.log("  attestor        ", attestors[i]);
        }
        console.log("threshold         ", threshold);
        if (threshold == 1 && attestors.length == 1) {
            console.log("THRESHOLD IS 1-of-1 -- a single point of trust, NOT a quorum.");
        }

        // vm.deployCode resolves each artifact at run time. With `new`, this script
        // contract embedded both contracts' creation code and its own deployed size hit
        // 27618 bytes -- past the 24576 Spurious Dragon limit, which `deny = "warnings"`
        // correctly refused. Relaxing that policy to fit a deploy script would have
        // relaxed it for the escrow too, where an oversized contract is a real finding.
        vm.startBroadcast();
        // Verifier first: the escrow's reference to it is immutable, so there is no
        // setter to repair a wrong order afterwards.
        WRKSettlementVerifier verifier = WRKSettlementVerifier(
            vm.deployCode(
                "WRKSettlementVerifier.sol:WRKSettlementVerifier", abi.encode(attestors, threshold)
            )
        );
        WRKEscrow escrow = WRKEscrow(
            vm.deployCode("WRKEscrow.sol:WRKEscrow", abi.encode(usdc, address(verifier)))
        );
        vm.stopBroadcast();

        // Read the wiring back out of the deployed contracts rather than trusting the
        // local variables. A record built from what we intended to deploy proves nothing.
        require(address(escrow.verifier()) == address(verifier), "escrow is not wired to the verifier");
        require(address(escrow.usdc()) == usdc, "escrow is not wired to the token");
        require(verifier.threshold() == threshold, "verifier threshold mismatch");
        require(verifier.attestorCount() == attestors.length, "verifier attestor count mismatch");

        console.log("verifier          ", address(verifier));
        console.log("escrow            ", address(escrow));
        console.log("challenge window  ", escrow.CHALLENGE_WINDOW());
        console.log("min refund delay  ", escrow.MIN_REFUND_DELAY());
        console.log("domain separator  ", vm.toString(verifier.domainSeparator()));

        _writeRecord(usdc, address(verifier), address(escrow), attestors, threshold);
        console.log("Script ran successfully");
    }

    /**
     * @dev Reads `SETTLEMENT_ATTESTOR_1` upward until one is missing.
     *
     *      Addresses, not keys. A deploy script that reads private keys in order to derive
     *      addresses has no reason to hold them, and every reason not to.
     */
    function _readAttestors() private view returns (address[] memory) {
        address[] memory buffer = new address[](32);
        uint256 found;
        for (uint256 i = 1; i <= 32; ++i) {
            address attestor =
                vm.envOr(string.concat("SETTLEMENT_ATTESTOR_", vm.toString(i)), address(0));
            if (attestor == address(0)) break;
            buffer[found++] = attestor;
        }

        address[] memory attestors = new address[](found);
        for (uint256 i = 0; i < found; ++i) attestors[i] = buffer[i];

        // The verifier requires a strictly ascending set. Sorting here rather than in the
        // constructor is deliberate: the constructor refuses an unsorted set so the
        // deployment transaction shows the exact ordering, and a duplicate cannot pass as
        // a typo.
        for (uint256 i = 0; i < found; ++i) {
            uint256 min = i;
            for (uint256 j = i + 1; j < found; ++j) {
                if (uint160(attestors[j]) < uint160(attestors[min])) min = j;
            }
            (attestors[i], attestors[min]) = (attestors[min], attestors[i]);
        }
        for (uint256 i = 1; i < found; ++i) {
            require(attestors[i] != attestors[i - 1], "duplicate attestor address");
        }
        return attestors;
    }

    function _writeRecord(
        address usdc,
        address verifier,
        address escrow,
        address[] memory attestors,
        uint256 threshold
    ) private {
        string memory attestorList = "[";
        for (uint256 i = 0; i < attestors.length; ++i) {
            attestorList = string.concat(
                attestorList,
                i == 0 ? "\"" : ",\"",
                vm.toString(attestors[i]),
                "\""
            );
        }
        attestorList = string.concat(attestorList, "]");

        string memory json = string.concat(
            "{\n",
            '  "chain_id": ', vm.toString(block.chainid), ",\n",
            '  "usdc": "', vm.toString(usdc), '",\n',
            '  "verifier": "', vm.toString(verifier), '",\n',
            '  "escrow": "', vm.toString(escrow), '",\n',
            '  "attestors": ', attestorList, ",\n",
            '  "threshold": ', vm.toString(threshold), ",\n",
            '  "attestor_count": ', vm.toString(attestors.length), ",\n",
            '  "challenge_window_seconds": 3600,\n',
            '  "deployed_at_block": ', vm.toString(block.number), "\n",
            "}\n"
        );

        string memory path =
            string.concat("deployments/base-", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console.log("record            ", path);
    }
}
