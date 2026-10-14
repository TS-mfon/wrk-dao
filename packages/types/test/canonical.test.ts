import { describe, expect, it } from "vitest";
import {
  CANONICAL_JSON_VERSION,
  CANONICAL_KEY_PATTERN,
  canonicalize,
  isCanonicalizable,
  MAX_SAFE_CANONICAL_INTEGER,
  MIN_SAFE_CANONICAL_INTEGER,
  WrkError,
} from "../src/index.js";

describe("canonical JSON", () => {
  it("pins the version string that gives every hash its meaning", () => {
    expect(CANONICAL_JSON_VERSION).toBe("wrk/canonical-json/v1");
  });

  it("sorts object keys ascending, not by insertion order", () => {
    expect(canonicalize({ b: 1, a: 2, C: 3, _d: 4 })).toBe('{"C":3,"_d":4,"a":2,"b":1}');
  });

  it("sorts a prefix before a longer key sharing that prefix", () => {
    expect(canonicalize({ ab: 1, a: 2 })).toBe('{"a":2,"ab":1}');
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  describe("string escaping", () => {
    it("prefers the shorthand escapes", () => {
      expect(canonicalize("\b\t\n\f\r")).toBe('"\\b\\t\\n\\f\\r"');
      expect(canonicalize('"')).toBe('"\\""');
      expect(canonicalize("\\")).toBe('"\\\\"');
    });

    it("does not escape the solidus", () => {
      expect(canonicalize("a/b")).toBe('"a/b"');
    });

    it("escapes every C0 control it has no shorthand for, in lowercase hex", () => {
      expect(canonicalize("\u0000\u0001\u001f")).toBe('"\\u0000\\u0001\\u001f"');
      expect(canonicalize("\u000b")).toBe('"\\u000b"');
    });

    it("escapes 0x7f (DEL) — the one code point a naive ASCII boundary gets wrong", () => {
      expect(canonicalize("\u007f")).toBe('"\\u007f"');
      // Its neighbour is printable and must stay literal.
      expect(canonicalize("~")).toBe('"~"');
    });

    it("escapes non-BMP characters as a surrogate pair", () => {
      expect(canonicalize("\u{1F600}")).toBe('"\\ud83d\\ude00"');
    });

    it("escapes lone surrogates rather than replacing them", () => {
      expect(canonicalize("\ud800")).toBe('"\\ud800"');
      expect(canonicalize("\udfff")).toBe('"\\udfff"');
    });

    it("keeps every printable ASCII character literal", () => {
      let printable = "";
      for (let code = 0x20; code <= 0x7e; code++) printable += String.fromCharCode(code);
      const encoded = canonicalize(printable);
      // Only the quote and backslash gain an escape.
      expect(encoded.length).toBe(printable.length + 2 + 2);
      // The run around the quote, which is the only escape in this stretch.
      expect(encoded).toContain("!\\\"#$%&'()*+,-./");
      expect(encoded).toContain("0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[");
      expect(encoded).toContain("]^_`abcdefghijklmnopqrstuvwxyz{|}~");
    });

    it("produces output that is always pure ASCII", () => {
      for (const input of ["é", "→", "\u{1F4A9}", " ", "﻿", "  "]) {
        const encoded = canonicalize(input);
        for (let i = 0; i < encoded.length; i++) {
          expect(encoded.charCodeAt(i)).toBeGreaterThanOrEqual(0x20);
          expect(encoded.charCodeAt(i)).toBeLessThanOrEqual(0x7e);
        }
      }
    });
  });

  describe("numbers", () => {
    it("accepts the safe integer boundaries", () => {
      expect(canonicalize(MAX_SAFE_CANONICAL_INTEGER)).toBe("9007199254740991");
      expect(canonicalize(MIN_SAFE_CANONICAL_INTEGER)).toBe("-9007199254740991");
    });

    it("normalises -0 to 0 so one amount has one digest", () => {
      expect(canonicalize(-0)).toBe("0");
    });

    it("rejects anything that is not a safe integer", () => {
      for (const value of [1.5, Number.NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)]) {
        expect(() => canonicalize(value)).toThrow(WrkError);
      }
    });

    it("rejects bigint rather than silently widening the number space", () => {
      expect(() => canonicalize(1n)).toThrow(/CANONICAL_BIGINT/);
    });
  });

  describe("keys", () => {
    it("pins the key pattern", () => {
      expect(CANONICAL_KEY_PATTERN.source).toBe("^[A-Za-z0-9_]+$");
    });

    it("rejects any key outside the pattern, at any depth", () => {
      for (const key of ["a-b", "a.b", "a b", "", "é", "\u{1F600}", "a:b", "a/b", "a\u007fb"]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => canonicalize({ [key]: 1 } as any)).toThrow(/CANONICAL_BAD_KEY/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => canonicalize({ ok: [{ [key]: 1 }] } as any)).toThrow(/CANONICAL_BAD_KEY/);
      }
    });

    it("accepts digits, underscores and mixed case", () => {
      expect(canonicalize({ a_1: 1, B2: 2, _: 3 })).toBe('{"B2":2,"_":3,"a_1":1}');
      // A key that looks like a hex prefix is still just letters and digits.
      expect(canonicalize({ "0x": 1 })).toBe('{"0x":1}');
      expect(canonicalize({ "0": 1, "1": 2 })).toBe('{"0":1,"1":2}');
    });
  });

  describe("value space", () => {
    it("allows null but not undefined", () => {
      expect(canonicalize(null)).toBe("null");
      expect(canonicalize({ a: null })).toBe('{"a":null}');
      expect(() => canonicalize(undefined)).toThrow(/CANONICAL_UNDEFINED/);
      expect(() => canonicalize({ a: undefined })).toThrow(/CANONICAL_UNDEFINED/);
    });

    it("rejects objects that Object.keys would flatten to {}", () => {
      for (const value of [new Date(0), new Map(), new Set(), /x/, new Uint8Array(1)]) {
        expect(() => canonicalize(value)).toThrow(/CANONICAL_NON_PLAIN_OBJECT/);
      }
    });

    it("rejects symbol-keyed properties instead of dropping them", () => {
      expect(() => canonicalize({ a: 1, [Symbol("s")]: 2 })).toThrow(/CANONICAL_SYMBOL_KEY/);
    });

    it("reports a cycle as a typed error, not a stack overflow", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => canonicalize(cyclic)).toThrow(/CANONICAL_CYCLE/);
    });

    it("allows the same object in two places when there is no cycle", () => {
      const shared = { a: 1 };
      expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    });
  });

  it("is idempotent through a JSON round-trip", () => {
    const value = { z: [1, { b: "x", a: null }], a: -0 };
    const once = canonicalize(value);
    expect(canonicalize(JSON.parse(once))).toBe(once);
  });

  it("exposes a total predicate that never throws", () => {
    expect(isCanonicalizable({ a: 1 })).toBe(true);
    expect(isCanonicalizable(undefined)).toBe(false);
    expect(isCanonicalizable(new Date())).toBe(false);
  });

  it("carries a machine-readable code on every failure", () => {
    try {
      canonicalize(1.5);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WrkError);
      expect((error as WrkError).code).toBe("CANONICAL_NON_INTEGER");
    }
  });
});
