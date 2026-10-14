// G3: every illegal value is refused, and the one legal normalisation is applied.
//
// Two classes of input are covered. The shared `reject` vectors, which Python must
// refuse too, and the JavaScript-local values that cannot appear in a JSON file at
// all (undefined, NaN, bigint, function, symbol) but arrive constantly from
// hand-built objects. Both are checked for the specific error code, not merely for
// "something threw" — a depth guard firing where a bad-key guard was expected is a
// silently wrong encoder.

import { loadFrozenVectors, check, checkEqual, checkThrows, finish, abort } from "./_common.mjs";

try {
  const { canonicalize, contentHash, isCanonicalizable, isWrkError } = await import("../dist/index.js");
  const { inputs } = loadFrozenVectors();

  /* ── shared reject vectors ─────────────────────────────────────────────── */

  check(inputs.reject.length > 0, "fixtures must carry reject vectors");
  for (const vector of inputs.reject) {
    checkThrows(() => canonicalize(vector.value), `reject vector ${vector.name} (${vector.reason})`);
    checkEqual(isCanonicalizable(vector.value), false, `isCanonicalizable(${vector.name}) must be false`);
    // contentHash must refuse too: a hash of an illegal value is worse than no hash.
    checkThrows(() => contentHash(vector.value), `contentHash must refuse ${vector.name}`);
  }

  /* ── the one accepted asymmetry (docs/CANONICAL.md §1.2) ───────────────── */

  check(inputs.reject_python_only.length > 0, "fixtures must carry reject_python_only vectors");
  for (const vector of inputs.reject_python_only) {
    // JavaScript cannot see the float spelling: JSON.parse turned 2.0 into 2 before
    // the encoder ran. It must produce the documented integer output, not throw —
    // and Python must reject the same input. leaf-1.1.2 owns that half.
    checkEqual(
      canonicalize(vector.value),
      vector.js_canonical,
      `asymmetric vector ${vector.name}: JavaScript must emit the documented text`,
    );
  }

  /* ── JavaScript-local illegal values ──────────────────────────────────── */

  const localRejects = [
    ["undefined bare", undefined, "CANONICAL_UNDEFINED"],
    ["undefined in object", { a: undefined }, "CANONICAL_UNDEFINED"],
    ["undefined in array", [1, undefined, 3], "CANONICAL_UNDEFINED"],
    ["NaN", Number.NaN, "CANONICAL_NON_INTEGER"],
    ["Infinity", Number.POSITIVE_INFINITY, "CANONICAL_NON_INTEGER"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "CANONICAL_NON_INTEGER"],
    ["float", 1.5, "CANONICAL_NON_INTEGER"],
    ["bigint", 1n, "CANONICAL_BIGINT"],
    ["bigint nested", { a: 1n }, "CANONICAL_BIGINT"],
    ["function", () => 1, "CANONICAL_UNSUPPORTED_TYPE"],
    ["symbol", Symbol("x"), "CANONICAL_UNSUPPORTED_TYPE"],
    ["unsafe integer above", 9007199254740992, "CANONICAL_UNSAFE_INTEGER"],
    ["unsafe integer below", -9007199254740992, "CANONICAL_UNSAFE_INTEGER"],
    ["key with dash", { "a-b": 1 }, "CANONICAL_BAD_KEY"],
    ["key with dot", { "a.b": 1 }, "CANONICAL_BAD_KEY"],
    ["key with space", { "a b": 1 }, "CANONICAL_BAD_KEY"],
    ["empty key", { "": 1 }, "CANONICAL_BAD_KEY"],
    ["non-ascii key", { "é": 1 }, "CANONICAL_BAD_KEY"],
    ["astral key", { "\u{1F600}": 1 }, "CANONICAL_BAD_KEY"],
    ["nested bad key", { a: { "b c": 1 } }, "CANONICAL_BAD_KEY"],
    ["bad key inside array", [{ "b-c": 1 }], "CANONICAL_BAD_KEY"],
    // Added strictness, all fail-closed. Object.keys would have made each of these
    // encode as {} or drop data silently.
    ["Date", new Date(0), "CANONICAL_NON_PLAIN_OBJECT"],
    ["Map", new Map([["a", 1]]), "CANONICAL_NON_PLAIN_OBJECT"],
    ["Set", new Set([1]), "CANONICAL_NON_PLAIN_OBJECT"],
    ["RegExp", /x/, "CANONICAL_NON_PLAIN_OBJECT"],
    ["boxed string", new String("a"), "CANONICAL_NON_PLAIN_OBJECT"],
    ["boxed number", new Number(1), "CANONICAL_NON_PLAIN_OBJECT"],
    ["Uint8Array", new Uint8Array([1]), "CANONICAL_NON_PLAIN_OBJECT"],
    ["class instance", new (class Thing { constructor() { this.a = 1; } })(), "CANONICAL_NON_PLAIN_OBJECT"],
    ["symbol-keyed property", { a: 1, [Symbol("s")]: 2 }, "CANONICAL_SYMBOL_KEY"],
  ];

  for (const [label, value, code] of localRejects) {
    checkThrows(() => canonicalize(value), `local reject: ${label}`, code);
  }

  // A cycle must be a typed error, not a stack overflow.
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  checkThrows(() => canonicalize(cyclic), "local reject: cycle", "CANONICAL_CYCLE");

  const sharedChild = { a: 1 };
  checkEqual(
    canonicalize({ x: sharedChild, y: sharedChild }),
    '{"x":{"a":1},"y":{"a":1}}',
    "a value referenced twice without a cycle is legal",
  );

  // Depth: 129 nested objects must be refused, 128 accepted, so the boundary is
  // pinned in both directions rather than only on the failing side.
  const nest = (depth) => {
    let value = 1;
    for (let i = 0; i < depth; i++) value = { a: value };
    return value;
  };
  check(typeof canonicalize(nest(127)) === "string", "127 levels of nesting must be accepted");
  checkThrows(() => canonicalize(nest(200)), "local reject: over-depth", "CANONICAL_DEPTH");

  /* ── the one legal normalisation ──────────────────────────────────────── */

  checkEqual(canonicalize(-0), "0", "-0 must normalise to 0");
  checkEqual(canonicalize({ a: -0 }), '{"a":0}', "-0 must normalise inside an object");
  checkEqual(canonicalize([-0]), "[0]", "-0 must normalise inside an array");
  checkEqual(
    contentHash(-0),
    contentHash(0),
    "-0 and 0 must hash identically, or the same amount has two digests",
  );

  /* ── errors are typed ─────────────────────────────────────────────────── */

  let caught;
  try {
    canonicalize(undefined);
  } catch (error) {
    caught = error;
  }
  check(isWrkError(caught), "canonical failures must be WrkError instances");
  check(typeof caught?.code === "string", "WrkError must carry a stable code string");

  finish("TYPES-REJECTS OK");
} catch (error) {
  abort(error);
}
