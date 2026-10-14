// G7: the EIP-712 Settlement digest matches an INDEPENDENTLY derived reference.
//
// The implementation uses viem's hashTypedData. This gate does not. It builds the
// digest from first principles — keccak256 over abi-encoded 32-byte words, per
// EIP-712 — using only keccak256 and hex concatenation, and compares. Comparing
// hashTypedData to hashTypedData would prove only that viem is deterministic.
//
// Why it matters: this digest is what attestors sign and what WRKSettlementVerifier
// recovers against. If the TypeScript signer and the Solidity verifier disagree by
// one field or one byte of the type string, every attestation is unrecoverable and
// no settlement can execute. So the type string, the field order, the domain and
// the array encoding are all pinned here.

import { keccak256, concat, pad, toHex, stringToHex, encodeAbiParameters } from "viem";
import { check, checkEqual, checkThrows, finish, abort } from "./_common.mjs";

/* ── the independent reference ─────────────────────────────────────────── */

// Hand-transcribed from docs/ARCHITECTURE.md §8. Field order is part of the hash.
const TYPE_STRING =
  "Settlement(bytes32 settlementId,bytes32 mandateId,bytes32 decisionHash,uint256 nonce," +
  "uint16 releaseBp,uint16 refundBp,address[] payees,uint16[] shareBp,uint64 genlayerFinalizedAt)";

const DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

const word = (value) => pad(toHex(value), { size: 32 });

function referenceDomainSeparator(domain) {
  return keccak256(
    concat([
      keccak256(stringToHex(DOMAIN_TYPE_STRING)),
      keccak256(stringToHex(domain.name)),
      keccak256(stringToHex(domain.version)),
      word(BigInt(domain.chainId)),
      pad(domain.verifyingContract.toLowerCase(), { size: 32 }),
    ]),
  );
}

function referenceHashStruct(message) {
  // EIP-712 encodes a dynamic array as keccak256 of the concatenated encodeData of
  // its members, each padded to 32 bytes.
  const payees = keccak256(concat(message.payees.map((a) => pad(a.toLowerCase(), { size: 32 }))));
  const shares = keccak256(concat(message.shareBp.map((s) => word(BigInt(s)))));
  return keccak256(
    concat([
      keccak256(stringToHex(TYPE_STRING)),
      pad(message.settlementId, { size: 32 }),
      pad(message.mandateId, { size: 32 }),
      pad(message.decisionHash, { size: 32 }),
      word(message.nonce),
      word(BigInt(message.releaseBp)),
      word(BigInt(message.refundBp)),
      payees,
      shares,
      word(message.genlayerFinalizedAt),
    ]),
  );
}

function referenceDigest(domain, message) {
  return keccak256(concat(["0x1901", referenceDomainSeparator(domain), referenceHashStruct(message)]));
}

/* ── fixed sample ──────────────────────────────────────────────────────── */

const DOMAIN = {
  name: "WRK Settlement",
  version: "1",
  chainId: 84532,
  verifyingContract: "0x1111111111111111111111111111111111111111",
};

const MESSAGE = {
  settlementId: "0x3d0b8f4e9b6a1c2d5e7f8a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5",
  mandateId: "0x00000000000000000000000001910f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70",
  decisionHash: "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d",
  nonce: 7n,
  releaseBp: 7500,
  refundBp: 2500,
  payees: ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"],
  shareBp: [6000, 4000],
  genlayerFinalizedAt: 1_790_001_234n,
};

try {
  const {
    settlementDigest,
    settlementDomain,
    assertAscendingSigners,
    assertSettlementMessage,
    SETTLEMENT_TYPE_STRING,
    EIP712_DOMAIN_TYPE_STRING,
    SETTLEMENT_TYPES,
    SETTLEMENT_DOMAIN_NAME,
    SETTLEMENT_DOMAIN_VERSION,
    settlementId,
    assertBytes32,
  } = await import("../dist/index.js");

  /* The type string the package exports must be the one the reference used. */
  checkEqual(SETTLEMENT_TYPE_STRING, TYPE_STRING, "exported Settlement type string");
  checkEqual(EIP712_DOMAIN_TYPE_STRING, DOMAIN_TYPE_STRING, "exported EIP712Domain type string");
  checkEqual(SETTLEMENT_DOMAIN_NAME, "WRK Settlement", "domain name");
  checkEqual(SETTLEMENT_DOMAIN_VERSION, "1", "domain version");

  // The type string must also be derivable from the exported field table, so a
  // field added to one and not the other cannot slip through.
  const derived = `Settlement(${SETTLEMENT_TYPES.Settlement.map((f) => `${f.type} ${f.name}`).join(",")})`;
  checkEqual(derived, TYPE_STRING, "type string derived from the field table");

  /* The digest itself. */
  const domain = settlementDomain(DOMAIN.chainId, DOMAIN.verifyingContract);
  checkEqual(JSON.stringify(domain), JSON.stringify(DOMAIN), "settlementDomain builds the documented domain");

  const produced = settlementDigest(domain, MESSAGE);
  const expected = referenceDigest(DOMAIN, MESSAGE);
  checkEqual(produced, expected, "settlementDigest matches the independent EIP-712 derivation");

  // Pin the shape too: a digest that came back as undefined would compare equal to
  // another undefined.
  check(/^0x[0-9a-f]{64}$/.test(produced), "the digest is a 32-byte hex value");

  /* Every field must affect the digest. A field the hash ignores is a field an
     attacker can change after the signature is gathered. */
  const mutations = {
    settlementId: { ...MESSAGE, settlementId: "0x" + "1".repeat(64) },
    mandateId: { ...MESSAGE, mandateId: "0x" + "2".repeat(64) },
    decisionHash: { ...MESSAGE, decisionHash: "0x" + "3".repeat(64) },
    nonce: { ...MESSAGE, nonce: 8n },
    releaseBp: { ...MESSAGE, releaseBp: 7400, refundBp: 2600 },
    payees: {
      ...MESSAGE,
      payees: ["0x2222222222222222222222222222222222222222", "0x4444444444444444444444444444444444444444"],
    },
    shareBp: { ...MESSAGE, shareBp: [4000, 6000] },
    genlayerFinalizedAt: { ...MESSAGE, genlayerFinalizedAt: 1_790_001_235n },
  };
  for (const [field, mutated] of Object.entries(mutations)) {
    const other = settlementDigest(domain, mutated);
    check(other !== produced, `changing ${field} must change the digest`);
    checkEqual(other, referenceDigest(DOMAIN, mutated), `mutated ${field} still matches the reference`);
  }

  /* Replay protection comes from the domain, so the domain must bind both fields. */
  const mainnetDomain = settlementDomain(8453, DOMAIN.verifyingContract);
  check(
    settlementDigest(mainnetDomain, MESSAGE) !== produced,
    "a different chainId must produce a different digest",
  );
  const otherContract = settlementDomain(DOMAIN.chainId, "0x5555555555555555555555555555555555555555");
  check(
    settlementDigest(otherContract, MESSAGE) !== produced,
    "a different verifyingContract must produce a different digest",
  );

  /* Checksum casing must not change the digest: the same signer set spelled two ways
     is one signer set. */
  const checksummed = {
    ...MESSAGE,
    payees: MESSAGE.payees.map((a) => a.toUpperCase().replace("0X", "0x")),
  };
  checkEqual(settlementDigest(domain, checksummed), produced, "payee address casing must not change the digest");

  /* settlementId is the §2 struct hash, not a content hash. Pin its shape and its
     injectivity, since I3 depends on it. */
  const sid = settlementId(MESSAGE.mandateId, MESSAGE.decisionHash, MESSAGE.nonce);
  checkEqual(
    sid,
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [assertBytes32(MESSAGE.mandateId), assertBytes32(MESSAGE.decisionHash), MESSAGE.nonce],
      ),
    ),
    "settlementId is keccak256(abi.encode(mandateId, decisionHash, nonce))",
  );
  check(
    settlementId(MESSAGE.mandateId, MESSAGE.decisionHash, 8n) !== sid,
    "changing the nonce must change the settlementId",
  );
  check(
    settlementId(MESSAGE.decisionHash, MESSAGE.mandateId, MESSAGE.nonce) !== sid,
    "swapping mandateId and decisionHash must change the settlementId",
  );

  /* Ascending signers. */
  assertAscendingSigners([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ]);
  // Casing must not fool the ordering check.
  assertAscendingSigners([
    "0xAAAA111111111111111111111111111111111111".toLowerCase(),
    "0xbbbb111111111111111111111111111111111111".toUpperCase().replace("0X", "0x"),
  ]);
  checkThrows(() => assertAscendingSigners([]), "empty signer set", "EIP712_SIGNER_ORDER");
  checkThrows(
    () =>
      assertAscendingSigners([
        "0x2222222222222222222222222222222222222222",
        "0x1111111111111111111111111111111111111111",
      ]),
    "descending signers",
    "EIP712_SIGNER_ORDER",
  );
  checkThrows(
    () =>
      assertAscendingSigners([
        "0x1111111111111111111111111111111111111111",
        "0x1111111111111111111111111111111111111111",
      ]),
    "duplicate signer",
    "EIP712_SIGNER_ORDER",
  );
  // The same attestor spelled in two cases is still the same attestor.
  checkThrows(
    () =>
      assertAscendingSigners([
        "0xabcdef1111111111111111111111111111111111",
        "0xABCDEF1111111111111111111111111111111111",
      ]),
    "duplicate signer differing only in case",
    "EIP712_SIGNER_ORDER",
  );
  checkThrows(() => assertAscendingSigners(["not-an-address"]), "non-address signer", "EIP712_FIELD");

  /* Message validation refuses everything the verifier would refuse. */
  assertSettlementMessage(MESSAGE);
  const bad = [
    ["basis points not summing to 10000", { ...MESSAGE, refundBp: 2400 }, "BP_SUM"],
    ["payees and shares of different length", { ...MESSAGE, shareBp: [10000] }, "EIP712_FIELD"],
    ["shares not summing to 10000", { ...MESSAGE, shareBp: [6000, 3999] }, "EIP712_FIELD"],
    ["zero-address payee", { ...MESSAGE, payees: [MESSAGE.payees[0], `0x${"0".repeat(40)}`] }, "EIP712_FIELD"],
    [
      "duplicate payee",
      { ...MESSAGE, payees: [MESSAGE.payees[0], MESSAGE.payees[0]] },
      "EIP712_FIELD",
    ],
    ["no payees but a non-zero release", { ...MESSAGE, payees: [], shareBp: [] }, "EIP712_FIELD"],
    ["unfinalized decision", { ...MESSAGE, genlayerFinalizedAt: 0n }, "EIP712_FIELD"],
    ["nonce as a number", { ...MESSAGE, nonce: 7 }, "EIP712_FIELD"],
    ["settlementId not bytes32", { ...MESSAGE, settlementId: "0xdead" }, "HASH_BAD_BYTES32"],
  ];
  for (const [label, message, code] of bad) {
    checkThrows(() => assertSettlementMessage(message), `must refuse: ${label}`, code);
    checkThrows(() => settlementDigest(domain, message), `digest must refuse: ${label}`, code);
  }

  // A full rejection is legal with no payees, and must still hash.
  const rejection = { ...MESSAGE, releaseBp: 0, refundBp: 10000, payees: [], shareBp: [] };
  assertSettlementMessage(rejection);
  checkEqual(settlementDigest(domain, rejection), referenceDigest(DOMAIN, rejection), "rejection digest");

  checkThrows(() => settlementDomain(0, DOMAIN.verifyingContract), "zero chainId", "EIP712_FIELD");
  checkThrows(() => settlementDomain(84532, "0x00"), "malformed verifyingContract", "EIP712_FIELD");

  finish("TYPES-EIP712 OK");
} catch (error) {
  abort(error);
}
