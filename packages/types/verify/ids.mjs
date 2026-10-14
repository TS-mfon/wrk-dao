// G5: identifiers round-trip string <-> bytes32 losslessly, and malformed ids are
// refused.
//
// 10000 generated ids per prefix, all nine prefixes. The round-trip is the whole
// point: an id that survives the trip to Base and back is the only way the escrow
// and the read model can agree on which mandate is being paid. A silent truncation
// here pays the wrong worker.

import { check, checkEqual, checkThrows, finish, abort } from "./_common.mjs";

const PER_PREFIX = 10000;

try {
  const { newId, parseId, toBytes32, fromBytes32, isId, idTime, ID_PREFIXES, idPattern, ANY_ID_PATTERN } =
    await import("../dist/index.js");

  checkEqual(ID_PREFIXES.length, 9, "there are nine object prefixes (docs/ARCHITECTURE.md §5)");

  let generated = 0;

  for (const prefix of ID_PREFIXES) {
    const seen = new Set();
    let previous = "";

    for (let i = 0; i < PER_PREFIX; i++) {
      const id = newId(prefix);
      generated += 1;

      // Shape.
      if (!idPattern(prefix).test(id)) {
        check(false, `${prefix}: generated id ${id} does not match its own pattern`);
        break;
      }
      if (!ANY_ID_PATTERN.test(id)) {
        check(false, `${prefix}: generated id ${id} does not match ANY_ID_PATTERN`);
        break;
      }

      // Uniqueness.
      if (seen.has(id)) {
        check(false, `${prefix}: duplicate id ${id} at iteration ${i}`);
        break;
      }
      seen.add(id);

      // Monotonicity: lexicographic order must equal creation order, because the
      // read model sorts by id and calls it chronological.
      if (previous !== "" && id <= previous) {
        check(false, `${prefix}: id ${id} does not sort after its predecessor ${previous}`);
        break;
      }
      previous = id;

      // The round-trip.
      const hex = toBytes32(id);
      if (!/^0x[0-9a-f]{64}$/.test(hex)) {
        check(false, `${prefix}: toBytes32 produced ${hex}`);
        break;
      }
      if (hex.slice(2, 34) !== "0".repeat(32)) {
        check(false, `${prefix}: high 16 bytes must be zero, got ${hex.slice(0, 34)}`);
        break;
      }
      const back = fromBytes32(hex, prefix);
      if (back !== id) {
        check(false, `${prefix}: round-trip changed ${id} into ${back}`);
        break;
      }

      // Parsing agrees with the bytes.
      const parsed = parseId(id, prefix);
      if (parsed.ulid !== id.slice(prefix.length + 1)) {
        check(false, `${prefix}: parseId returned ulid ${parsed.ulid} for ${id}`);
        break;
      }
      if (parsed.value !== BigInt(hex)) {
        check(false, `${prefix}: parsed value ${parsed.value} disagrees with bytes32 ${hex}`);
        break;
      }
    }

    checkEqual(seen.size, PER_PREFIX, `${prefix}: ${PER_PREFIX} distinct ids`);
  }

  checkEqual(generated, PER_PREFIX * 9, "every prefix generated its full batch");

  /* ── timestamps ───────────────────────────────────────────────────────── */

  const at = 1_790_000_000_000;
  const pinned = newId("mnd", at);
  checkEqual(parseId(pinned).timeMs, at, "the ULID time component round-trips exactly");
  checkEqual(idTime(pinned).getTime(), at, "idTime returns the creation instant");
  // Ordering across milliseconds, not just within one.
  check(newId("mnd", at + 1) > pinned, "a later millisecond sorts after an earlier one");

  /* ── refusals ─────────────────────────────────────────────────────────── */

  const sample = newId("mnd");
  const ulid = sample.slice(4);

  checkThrows(() => parseId(sample, "agt"), "wrong expected prefix", "ID_BAD_PREFIX");
  checkThrows(() => parseId(`xyz_${ulid}`), "unknown prefix", "ID_BAD_PREFIX");
  checkThrows(() => parseId(ulid), "no prefix separator", "ID_BAD_FORMAT");
  checkThrows(() => parseId(`mnd_${ulid.slice(0, 25)}`), "too short", "ID_BAD_FORMAT");
  checkThrows(() => parseId(`mnd_${ulid}A`), "too long", "ID_BAD_FORMAT");
  // I, L, O and U are excluded from Crockford base32 precisely because they are
  // confusable; accepting them would make two different strings decode alike.
  for (const bad of ["I", "L", "O", "U", "i", "l", "o", "u", "-", "!"]) {
    checkThrows(
      () => parseId(`mnd_${bad}${ulid.slice(1)}`),
      `character ${bad} must be refused`,
      bad === "-" || bad === "!" ? "ID_BAD_ALPHABET" : "ID_BAD_ALPHABET",
    );
  }
  // Lowercase is not merely unusual, it is a second spelling of the same value.
  checkThrows(() => parseId(`mnd_${ulid.toLowerCase()}`), "lowercase ULID", "ID_BAD_ALPHABET");
  // 26 characters can express 130 bits; anything above 2^128 is not an id.
  checkThrows(() => parseId(`mnd_ZZZZZZZZZZZZZZZZZZZZZZZZZZ`), "overflows 128 bits", "ID_OVERFLOW");

  checkThrows(() => fromBytes32("0x00", "mnd"), "short bytes32", "ID_BAD_BYTES32");
  checkThrows(() => fromBytes32(`0x${"f".repeat(64)}`, "mnd"), "non-zero high bytes", "ID_BAD_BYTES32");
  checkThrows(() => fromBytes32(toBytes32(sample), "xyz"), "unknown prefix on decode", "ID_BAD_PREFIX");
  checkThrows(() => toBytes32("not-an-id"), "toBytes32 of a non-id", "ID_BAD_FORMAT");

  checkEqual(isId(sample), true, "isId accepts a valid id");
  checkEqual(isId(sample, "mnd"), true, "isId accepts a matching prefix");
  checkEqual(isId(sample, "agt"), false, "isId rejects a mismatched prefix");
  checkEqual(isId(42), false, "isId rejects a non-string");
  checkEqual(isId(""), false, "isId rejects the empty string");
  checkEqual(isId(null), false, "isId rejects null");

  /* ── the prefix is deliberately not encoded on-chain ──────────────────── */

  // Two ids that differ only by prefix share a bytes32. That is intended — the
  // object's type is implied by which mapping holds it — and it is pinned here so
  // nobody later "fixes" it and breaks every stored id.
  const fixed = 1_790_000_000_001;
  const asMandate = newId("mnd", fixed);
  const asAgent = `agt_${asMandate.slice(4)}`;
  checkEqual(toBytes32(asAgent), toBytes32(asMandate), "bytes32 form carries no prefix");
  checkEqual(fromBytes32(toBytes32(asMandate), "agt"), asAgent, "decoding requires naming the prefix");

  finish("TYPES-IDS OK");
} catch (error) {
  abort(error);
}
