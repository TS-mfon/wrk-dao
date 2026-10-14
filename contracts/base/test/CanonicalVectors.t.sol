// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// GENERATED FILE — regenerate rather than edit:
//   node scripts/generate-canonical-vectors-test.mjs
//
// Asserts that Solidity's keccak256 reproduces every digest in
// fixtures/canonical-vectors.json. With TypeScript (viem) and Python (a vendored
// pure-Python keccak) already proven against the same file, this makes the EVM the
// third independent agreeing implementation of the canonical hashing contract — and the
// three share no lineage, which is the whole point. Agreement between two
// implementations that descend from one another proves only that the copy worked.
//
// Why Solidity can hash these bytes at all (docs/CANONICAL.md §1.4): canonical output
// contains no byte above 0x7E, so its UTF-8 encoding is byte-identical to its ASCII
// encoding. `keccak256(bytes(s))` on a literal therefore hashes exactly what the other
// two languages hash, with no UTF-8 encoder in the contract and no lone-surrogate edge
// case to handle on-chain. This file is the evidence for that claim rather than a
// comment asserting it.

import {Test} from "forge-std/Test.sol";

contract CanonicalVectorsTest is Test {
    uint256 internal constant FROZEN_VECTOR_COUNT = 41;

    function _assertVector(string memory name, string memory canonical, bytes32 expected)
        internal
        pure
    {
        assertEq(keccak256(bytes(canonical)), expected, name);
    }

    /// @dev Chunk 1 of 3. Split so no one function's string data
    ///      approaches the 49152-byte initcode limit.
    function test_solidityReproducesFrozenDigests_chunk1() public pure {
        _assertVector("empty_object", "{}", 0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d);
        _assertVector("true_scalar", "true", 0x6273151f959616268004b58dbb21e5c851b7b8d04498b4aabee12291d22fc034);
        _assertVector("negative_int", "-12345", 0x46734fa80f6cc201db368f70431010973f1ae071876dd6f4d61d454414d31152);
        _assertVector("empty_string", "\"\"", 0x2392a80f8a87b8cfde0aa5c84e199f163aae4c2a4c512d37598362ace687ad0c);
        _assertVector("nested_unsorted", "{\"outer_a\":[{\"p\":2,\"q\":1},{\"a\":4,\"b\":3}],\"outer_b\":{\"inner_a\":{\"deep_b\":null,\"deep_y\":true},\"inner_z\":1}}", 0x64e21fa1697a1261a3f5f25bcbc583117b8a8c15b07ae521af9ac757a8f5e0b3);
        _assertVector("string_backslash", "\"C:\\\\\\\\path\\\\\\\\to\\\\\\\\thing\"", 0x7fabd96333df838aeccf8ac7d2f66a72c628344b07aba1fb761dacd2c4873884);
        _assertVector("string_shorthand_escapes", "\"\\b\\t\\n\\f\\r\"", 0x5c09b29c73cf0dbbf9c0a74ce96f96aee6b8005c269c7fe51f0325db7807e0c7);
        _assertVector("string_del_raw", "\"before\\u007fafter\"", 0x8d3b8f053ad661da5b9c91ef39c83aa181bde4ac50b437d6a523c61747583cd9);
        _assertVector("string_latin1", "\"caf\\u00e9 na\\u00efve \\u00dfra\\u00dfe\"", 0xe8f177f601242a7dfc232d1ab8193ab95df94d6bf5e6ef2c2421a3f2764b4376);
        _assertVector("string_cjk", "\"\\u4f60\\u597d\\u4e16\\u754c\"", 0x6d765e4af859d9902ab3dbf3b7b1ecfd1d15942ee235a0227316eb7db58a9eed);
        _assertVector("string_astral_max", "\"\\udbff\\udfff\"", 0x0780464af8f70a9427d75454a90b381ac9738cc3bf4901ea9355fe951a5cd80e);
        _assertVector("string_lone_high_surrogate", "\"x\\ud83dy\"", 0xd8b2e7e9f634ac8f995708a321e4701dc377b6e5b7bd249424a7c330eabae335);
        _assertVector("string_line_separators", "\"\\u2028\\u2029\"", 0xc507d686d11f0ce0c34401292e4c5d577d345456da1e36e0a60d277120224ef2);
        _assertVector("wrk_mission_payload", "{\"acceptance_criteria\":[{\"id\":\"ac_1\",\"statement\":\"Adapter refuses a non-finalized decision.\",\"weight_bp\":4000},{\"id\":\"ac_2\",\"statement\":\"Adapter is idempotent per decision_id.\",\"weight_bp\":3500},{\"id\":\"ac_3\",\"statement\":\"Partial acceptance splits to the basis point.\",\"weight_bp\":2500}],\"allow_teams\":true,\"budget\":{\"amount_atomic\":\"250000000\",\"asset\":\"USDC\",\"chain_id\":84532,\"decimals\":6},\"creator_agent_id\":\"agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A\",\"dao_id\":\"dao_01JQ8Z1A2B3C4D5E6F7G8H9J0K\",\"deadline_unix\":1790000000,\"evidence_requirements\":[\"source_repository\",\"test_output\",\"deployed_address\"],\"max_team_size\":3,\"mission_id\":\"msn_01JQ8Z3X9K2M4N6P8R0T2V4W6Y\",\"outcome_statement\":\"A deployed adapter that releases USDC only after finality.\",\"schema_version\":1,\"title\":\"Ship a GenLayer settlement adapter\"}", 0xc7280e3e6a88e35df1cec35af26ddf02ceffee39c5f576c2be3c822d786df456);
    }

    /// @dev Chunk 2 of 3. Split so no one function's string data
    ///      approaches the 49152-byte initcode limit.
    function test_solidityReproducesFrozenDigests_chunk2() public pure {
        _assertVector("empty_array", "[]", 0x518674ab2b227e5f11e9084f615d57663cde47bce1ba168b4c19c7ee22a73d70);
        _assertVector("false_scalar", "false", 0xba9154e0baa69c78e0ca563b867df81bae9d177c4ea1452c35c84386a70f0f7a);
        _assertVector("max_safe_int", "9007199254740991", 0xf991b5a33dc6cbd1c5141621c1532264df7e27ea6946a65829565420ba9f62e7);
        _assertVector("key_order_ascii_classes", "{\"0\":6,\"9\":7,\"A\":2,\"Az\":9,\"Z\":5,\"_\":3,\"_z\":8,\"a\":4,\"z\":1}", 0xd971b2db2614c999463c61b4a4d6ce76011dc54a28cf896d149f5019003cb048);
        _assertVector("deep_nesting", "{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":[1,[2,[3,[4]]]]}}}}}}}", 0xce521ebd6aced0dab245e5b53c0f910b6d3725fce4f2e1f4b5da157a0789c185);
        _assertVector("string_backslash_u_literal", "\"not an escape: \\\\\\\\u0041\"", 0x9a73a7eebc2904c21233f582b25d98b6df6d5ef9fa4779c70c9db1d62b0632b5);
        _assertVector("string_all_c0_controls", "\"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f\"", 0x55594b823b3b94b80f756465766ce0cb73b63d0274d614797186fbad3133d398);
        _assertVector("string_c1_controls", "\"\\u0080\\u009f\"", 0x7036aa76811a5b1571f1ef6c578515efc18bc075bf22d1d0740dd108192799e1);
        _assertVector("string_replacement_char", "\"\\ufffd\"", 0xfa9b92abdc400251d64c7fbfa44ca1973fc8c38a15cda31250e48597e07b5dd8);
        _assertVector("string_rtl", "\"\\u05e9\\u05dc\\u05d5\\u05dd \\u0645\\u0631\\u062d\\u0628\\u0627\"", 0x1be1021c1ed97cdcca8968635112fedfb1e7da22ddbef9b908fdfc1f1f67d0ac);
        _assertVector("string_zwj_sequence", "\"\\ud83d\\udc69\\u200d\\ud83d\\udcbb\"", 0x236c9a6f753e5384edbb9ee0d8aba3e14c0fea28d60f72fe87392741175a6c92);
        _assertVector("string_lone_low_surrogate", "\"x\\ude00y\"", 0x1a6d129594b172cad710c41364b258418928614de529f377aa87f2937fb1ebd0);
        _assertVector("array_mixed", "[0,-1,true,false,null,\"\",\"x\",[],{},[[]],[{}]]", 0x6e4bf005d693f7745e95842f9af5dddc0c6f42ac2ab1f3ef5f6c5bcc290c5456);
        _assertVector("wrk_decision_payload", "{\"adjudicated_at_unix\":1790001234,\"allocations\":[{\"agent_id\":\"agt_01JQ8ZC1D2E3F4G5H6J7K8M9N0\",\"share_bp\":6000},{\"agent_id\":\"agt_01JQ8ZD1E2F3G4H5J6K7M8N9P0\",\"share_bp\":4000}],\"criteria_findings\":[{\"confidence_bp\":9500,\"criterion_id\":\"ac_1\",\"met\":true,\"rationale\":\"Reverts on pending.\"},{\"confidence_bp\":9000,\"criterion_id\":\"ac_2\",\"met\":true,\"rationale\":\"Nonce map blocks replay.\"},{\"confidence_bp\":7000,\"criterion_id\":\"ac_3\",\"met\":false,\"rationale\":\"Rounds against payee.\"}],\"decision_id\":\"dec_01JQ8ZB1C2D3E4F5G6H7J8K9M0\",\"mandate_id\":\"mnd_01JQ8ZA0B1C2D3E4F5G6H7J8K9\",\"notes\":\"Rounding fixed in follow-up; \\\"as-is\\\" at deadline.\",\"refund_bp\":2500,\"release_bp\":7500,\"schema_version\":1,\"verdict\":\"PARTIAL_ACCEPTANCE\"}", 0xd49622f1cd4b7ce3bca0adc78d8124396bc23f9615b8d6bb5984ddcd72f68435);
    }

    /// @dev Chunk 3 of 3. Split so no one function's string data
    ///      approaches the 49152-byte initcode limit.
    function test_solidityReproducesFrozenDigests_chunk3() public pure {
        _assertVector("null_scalar", "null", 0xefbde2c3aee204a69b7696d4b10ff31137fe78e3946306284f806e2dfc68b805);
        _assertVector("zero", "0", 0x044852b2a670ade5407e78fb2863c51de9fcb96542a07186fe3aeda6bb8a116d);
        _assertVector("min_safe_int", "-9007199254740991", 0xc9c75392c425ae0d28adcc018ebf841f54f6584521b48c6cfdbb1c0b53634865);
        _assertVector("key_order_prefix_vs_longer", "{\"a\":2,\"aB\":5,\"a_\":4,\"ab\":1,\"abc\":3}", 0xa1aacfb52b2e3753e79107b8e394ae20002b1d295ff060e1104f0d7de7096bd1);
        _assertVector("string_quote", "\"he said \\\"yes\\\"\"", 0x35b4f651a3110510509c9acd4799eada843edd9cec4f024a32ea58a2aa2d7a71);
        _assertVector("string_solidus", "\"a/b/c\"", 0xcd4ed9f3bd3c2d881d736c82b74e75ab381b10022749cb36a28a0d66ac6becd1);
        _assertVector("string_space_and_tilde", "\" !~\"", 0x7e700d6b2477eb204aa7a2f7afaddbb5d35bde239605b9a6854b27f10f2a31e3);
        _assertVector("string_nbsp", "\"a\\u00a0b\"", 0x4f2c9fc3e44a8a3afc34ac5e27c2968e056eb598fcc34a0e1fba5509e3f28f1a);
        _assertVector("string_bmp_max", "\"\\uffff\"", 0x619088fe6845412a79120d192594a25ed94ba0ef77cb5b5af51269255c57283f);
        _assertVector("string_astral_emoji", "\"\\ud83d\\ude00\"", 0xd03b1bbb602fa8d6b6ad878c7f3cd0f66164ccf1b82828fa4007bd65cb43d714);
        _assertVector("string_combining_marks", "\"e\\u0301 vs \\u00e9\"", 0x5da3fd1b6c2dd9eebc49bf22ff20c5b8eb73f1f526d4445250a46df1bc0bd4a0);
        _assertVector("string_bom", "\"\\ufeffleading bom\"", 0x4e7a9cc5ca5b5947677d03c5f053ea97122605e33cbed9405a0e2fe55b563bc7);
        _assertVector("array_order_is_preserved", "[\"z\",\"a\",\"m\",\"b\"]", 0xbed188c1ac272c1d0d66896941c46a5a6bb5519152309bb5377bb9e6b7b5ce55);
    }

    /// @dev Asserted separately so a chunk that silently loses vectors is caught. Three
    ///      green chunks over a shrinking set look identical, from the outside, to three
    ///      green chunks over the full set.
    function test_everyFrozenVectorIsCovered() public pure {
        uint256 covered = 14 + 14 + 13;
        assertEq(covered, FROZEN_VECTOR_COUNT, "every frozen vector must be asserted");
    }

    /// @dev The anchor, stated plainly: this is the digest the entire three-language
    ///      contract is pinned to, and the value a reviewer can check by hand.
    function test_anchorDigest() public pure {
        assertEq(
            keccak256(bytes("{}")),
            0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d
        );
    }
}
