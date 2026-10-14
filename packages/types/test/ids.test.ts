import { describe, expect, it } from "vitest";
import {
  ANY_ID_PATTERN,
  fromBytes32,
  ID_PREFIXES,
  idPattern,
  idTime,
  isId,
  newId,
  parseId,
  toBytes32,
} from "../src/index.js";

describe("identifiers (docs/ARCHITECTURE.md §5)", () => {
  it("covers every object in the protocol", () => {
    expect([...ID_PREFIXES]).toEqual(["agt", "dao", "msn", "prp", "mnd", "dlv", "evd", "dec", "stl"]);
  });

  it("mints ids of the documented shape", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id).toHaveLength(prefix.length + 1 + 26);
      expect(idPattern(prefix).test(id)).toBe(true);
      expect(ANY_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it("excludes the confusable Crockford characters I, L, O and U", () => {
    const ulid = newId("agt").slice(4);
    expect(ulid).not.toMatch(/[ILOU]/);
    for (const bad of ["I", "L", "O", "U"]) {
      expect(() => parseId(`agt_${bad}${ulid.slice(1)}`)).toThrow(/ID_BAD_ALPHABET/);
    }
  });

  it("sorts lexicographically in creation order", () => {
    const burst = Array.from({ length: 500 }, () => newId("msn"));
    expect([...burst].sort()).toEqual(burst);
    expect(new Set(burst).size).toBe(burst.length);
  });

  it("honours an explicit timestamp exactly", () => {
    // The parameter exists for deterministic construction. An id whose embedded time
    // is not the time you asked for would make it useless.
    const at = 1_700_000_000_123;
    expect(parseId(newId("dec", at)).timeMs).toBe(at);
    expect(idTime(newId("dec", at)).getTime()).toBe(at);
  });

  it("orders ids across milliseconds", () => {
    expect(newId("dec", 1_700_000_000_001) > newId("dec", 1_700_000_000_000)).toBe(true);
  });

  it("round-trips through bytes32 without loss", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      const hex = toBytes32(id);
      expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
      expect(hex.slice(2, 34)).toBe("0".repeat(32));
      expect(fromBytes32(hex, prefix)).toBe(id);
    }
  });

  it("does not encode the prefix on-chain", () => {
    // Intended: an object's type is implied by which mapping holds it. Pinned so
    // nobody "fixes" it later and invalidates every stored id.
    const mandate = newId("mnd", 1_700_000_000_000);
    const asAgent = `agt_${mandate.slice(4)}`;
    expect(toBytes32(asAgent)).toBe(toBytes32(mandate));
  });

  it("refuses a bytes32 whose high bytes are not zero", () => {
    expect(() => fromBytes32(`0x${"f".repeat(64)}`, "mnd")).toThrow(/ID_BAD_BYTES32/);
    expect(() => fromBytes32(`0x01${"0".repeat(62)}`, "mnd")).toThrow(/ID_BAD_BYTES32/);
  });

  it("refuses a ULID that overflows 128 bits", () => {
    // 26 Crockford characters can express 130 bits; only the low 128 are an id.
    expect(() => parseId(`mnd_${"Z".repeat(26)}`)).toThrow(/ID_OVERFLOW/);
    expect(() => parseId(`mnd_8${"0".repeat(25)}`)).toThrow(/ID_OVERFLOW/);
  });

  it("refuses the wrong prefix even when the ULID is valid", () => {
    const id = newId("mnd");
    expect(() => parseId(id, "agt")).toThrow(/ID_BAD_PREFIX/);
    expect(isId(id, "agt")).toBe(false);
    expect(isId(id, "mnd")).toBe(true);
  });

  it("refuses lowercase, which would be a second spelling of one value", () => {
    const id = newId("mnd");
    expect(() => parseId(id.slice(0, 4) + id.slice(4).toLowerCase())).toThrow(/ID_BAD_ALPHABET/);
  });

  it("has a total predicate", () => {
    expect(isId(newId("dao"))).toBe(true);
    for (const value of [undefined, null, 1, "", "dao_", {}, []]) {
      expect(isId(value)).toBe(false);
    }
  });

  it("rejects a timestamp outside the 48-bit ULID range", () => {
    expect(() => newId("agt", -1)).toThrow(/ID_BAD_FORMAT/);
    expect(() => newId("agt", 2 ** 48)).toThrow(/ID_BAD_FORMAT/);
  });
});
