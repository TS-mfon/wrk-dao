import { describe, expect, it } from "vitest";
import {
  assertAscendingSigners,
  assertSettlementMessage,
  settlementDigest,
  settlementDomain,
  SETTLEMENT_DOMAIN_NAME,
  SETTLEMENT_DOMAIN_VERSION,
  SETTLEMENT_TYPE_STRING,
  SETTLEMENT_TYPES,
} from "../src/index.js";
import type { SettlementMessage } from "../src/index.js";
import type { Address } from "viem";

const VERIFIER = "0x1111111111111111111111111111111111111111" as Address;
const BASE_SEPOLIA = 84_532;
const BASE_MAINNET = 8_453;

const MESSAGE: SettlementMessage = {
  settlementId: `0x${"3d".repeat(32)}`,
  mandateId: `0x${"01".repeat(32)}`,
  decisionHash: `0x${"02".repeat(32)}`,
  nonce: 7n,
  releaseBp: 7500,
  refundBp: 2500,
  payees: ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"],
  shareBp: [6000, 4000],
  genlayerFinalizedAt: 1_790_001_234n,
};

describe("settlement attestation (docs/ARCHITECTURE.md §8)", () => {
  it("pins the domain", () => {
    expect(SETTLEMENT_DOMAIN_NAME).toBe("WRK Settlement");
    expect(SETTLEMENT_DOMAIN_VERSION).toBe("1");
    expect(settlementDomain(BASE_SEPOLIA, VERIFIER)).toEqual({
      name: "WRK Settlement",
      version: "1",
      chainId: BASE_SEPOLIA,
      verifyingContract: VERIFIER,
    });
  });

  it("pins the field order, which is part of the type hash", () => {
    expect(SETTLEMENT_TYPES.Settlement.map((f) => f.name)).toEqual([
      "settlementId",
      "mandateId",
      "decisionHash",
      "nonce",
      "releaseBp",
      "refundBp",
      "payees",
      "shareBp",
      "genlayerFinalizedAt",
    ]);
    const derived = `Settlement(${SETTLEMENT_TYPES.Settlement.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(derived).toBe(SETTLEMENT_TYPE_STRING);
  });

  describe("replay protection", () => {
    const digest = settlementDigest(settlementDomain(BASE_SEPOLIA, VERIFIER), MESSAGE);

    it("binds the chain", () => {
      expect(settlementDigest(settlementDomain(BASE_MAINNET, VERIFIER), MESSAGE)).not.toBe(digest);
    });

    it("binds the verifying contract", () => {
      const other = "0x9999999999999999999999999999999999999999" as Address;
      expect(settlementDigest(settlementDomain(BASE_SEPOLIA, other), MESSAGE)).not.toBe(digest);
    });

    it("binds every message field", () => {
      const domain = settlementDomain(BASE_SEPOLIA, VERIFIER);
      const mutations: SettlementMessage[] = [
        { ...MESSAGE, settlementId: `0x${"ff".repeat(32)}` },
        { ...MESSAGE, mandateId: `0x${"ee".repeat(32)}` },
        { ...MESSAGE, decisionHash: `0x${"dd".repeat(32)}` },
        { ...MESSAGE, nonce: 8n },
        { ...MESSAGE, releaseBp: 7400, refundBp: 2600 },
        { ...MESSAGE, shareBp: [4000, 6000] },
        { ...MESSAGE, genlayerFinalizedAt: 1_790_001_235n },
        {
          ...MESSAGE,
          payees: [MESSAGE.payees[0]!, "0x4444444444444444444444444444444444444444"],
        },
      ];
      for (const mutated of mutations) {
        expect(settlementDigest(domain, mutated)).not.toBe(digest);
      }
    });

    it("ignores address casing, since one signer set has one digest", () => {
      const domain = settlementDomain(BASE_SEPOLIA, VERIFIER);
      const upper = {
        ...MESSAGE,
        payees: MESSAGE.payees.map((a) => a.toUpperCase().replace("0X", "0x")) as Address[],
      };
      expect(settlementDigest(domain, upper)).toBe(digest);
    });
  });

  describe("ascending signers", () => {
    it("accepts a strictly ascending set", () => {
      expect(() =>
        assertAscendingSigners([
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ]),
      ).not.toThrow();
    });

    it("rejects descending, equal, and case-disguised duplicates", () => {
      expect(() =>
        assertAscendingSigners([
          "0x2222222222222222222222222222222222222222",
          "0x1111111111111111111111111111111111111111",
        ]),
      ).toThrow(/EIP712_SIGNER_ORDER/);
      expect(() =>
        assertAscendingSigners([
          "0x1111111111111111111111111111111111111111",
          "0x1111111111111111111111111111111111111111",
        ]),
      ).toThrow(/EIP712_SIGNER_ORDER/);
      expect(() =>
        assertAscendingSigners([
          "0xabcdef1111111111111111111111111111111111",
          "0xABCDEF1111111111111111111111111111111111" as Address,
        ]),
      ).toThrow(/EIP712_SIGNER_ORDER/);
    });

    it("rejects an empty set", () => {
      expect(() => assertAscendingSigners([])).toThrow(/EIP712_SIGNER_ORDER/);
    });
  });

  describe("message validation", () => {
    it("accepts a well-formed partial acceptance", () => {
      expect(() => assertSettlementMessage(MESSAGE)).not.toThrow();
    });

    it("accepts a rejection with no payees", () => {
      expect(() =>
        assertSettlementMessage({ ...MESSAGE, releaseBp: 0, refundBp: 10_000, payees: [], shareBp: [] }),
      ).not.toThrow();
    });

    it("refuses a zero finality timestamp", () => {
      // Invariant I1's tripwire: an unfinalized decision has no finality time, and a
      // zero here is the shape a "settle it anyway" bug takes.
      expect(() => assertSettlementMessage({ ...MESSAGE, genlayerFinalizedAt: 0n })).toThrow(/EIP712_FIELD/);
    });

    it("refuses mismatched payee and share lengths", () => {
      expect(() => assertSettlementMessage({ ...MESSAGE, shareBp: [10_000] })).toThrow(/EIP712_FIELD/);
    });

    it("refuses shares that do not sum to 10000", () => {
      expect(() => assertSettlementMessage({ ...MESSAGE, shareBp: [6000, 3999] })).toThrow(/EIP712_FIELD/);
    });

    it("refuses the zero address as a payee", () => {
      expect(() =>
        assertSettlementMessage({ ...MESSAGE, payees: [MESSAGE.payees[0]!, `0x${"0".repeat(40)}`] }),
      ).toThrow(/EIP712_FIELD/);
    });

    it("refuses a duplicated payee", () => {
      expect(() =>
        assertSettlementMessage({ ...MESSAGE, payees: [MESSAGE.payees[0]!, MESSAGE.payees[0]!] }),
      ).toThrow(/EIP712_FIELD/);
    });

    it("refuses a release with nobody to pay", () => {
      expect(() => assertSettlementMessage({ ...MESSAGE, payees: [], shareBp: [] })).toThrow(/EIP712_FIELD/);
    });

    it("refuses basis points that do not sum to 10000", () => {
      expect(() => assertSettlementMessage({ ...MESSAGE, refundBp: 2400 })).toThrow(/BP_SUM/);
    });

    it("validates before hashing, so a bad message never produces a signable digest", () => {
      const domain = settlementDomain(BASE_SEPOLIA, VERIFIER);
      expect(() => settlementDigest(domain, { ...MESSAGE, refundBp: 2400 })).toThrow(/BP_SUM/);
    });
  });
});
