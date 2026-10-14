/**
 * Identifiers — `<prefix>_<ULID>` (docs/ARCHITECTURE.md §5).
 *
 * ULID is chosen for two properties the read model depends on: lexicographic
 * ordering equals creation ordering (so "sort by id" is free and correct), and
 * 80 bits of randomness per millisecond makes collisions a non-issue without a
 * coordinator.
 *
 * On-chain an id is `bytes32`: the ULID's 128 bits, left-padded with zeros. The
 * high 16 bytes being zero is checked on the way back, so a `bytes32` that was
 * never an id cannot be decoded into a plausible-looking one.
 *
 * ULID is implemented here rather than taken as a dependency: it is 40 lines, the
 * alphabet is the part that must be exactly right, and a supply-chain dependency
 * that mints protocol identifiers is a poor trade for 40 lines.
 */

import { fail, describe } from "./errors.js";

/** Crockford base32, ULID flavour: no I, L, O or U — they invite transcription errors. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const TIME_BITS = 48n;
const RANDOM_BITS = 80n;
const MAX_TIME = (1n << TIME_BITS) - 1n;
const MAX_RANDOM = (1n << RANDOM_BITS) - 1n;
const MAX_ULID = (1n << 128n) - 1n;

const DECODE = new Map<string, bigint>();
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE.set(ALPHABET.charAt(i), BigInt(i));
}

/** Every object that carries an id, per docs/ARCHITECTURE.md §5. */
export const ID_PREFIXES = [
  "agt",
  "dao",
  "msn",
  "prp",
  "mnd",
  "dlv",
  "evd",
  "dec",
  "stl",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const PREFIX_SET: ReadonlySet<string> = new Set<string>(ID_PREFIXES);

declare const idBrand: unique symbol;

/**
 * A validated identifier. The brand makes `Id<"agt">` and `Id<"mnd">` mutually
 * unassignable, so a mandate id cannot be passed where an agent id is expected —
 * a mistake that on the money path means paying the wrong party.
 */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}` & {
  readonly [idBrand]: P;
};

export type AgentId = Id<"agt">;
export type DaoId = Id<"dao">;
export type MissionId = Id<"msn">;
export type ProposalId = Id<"prp">;
export type MandateId = Id<"mnd">;
export type DeliverableId = Id<"dlv">;
export type EvidenceId = Id<"evd">;
export type DecisionId = Id<"dec">;
export type SettlementRecordId = Id<"stl">;

/** The regex form of a valid id, for schemas. Per-prefix so each is exact. */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`);
}

/** Matches any valid prefix. Used where the object type is not known in advance. */
export const ANY_ID_PATTERN = new RegExp(
  `^(?:${ID_PREFIXES.join("|")})_[0-7][0-9A-HJKMNP-TV-Z]{25}$`,
);

function encodeUlid(value: bigint): string {
  let remaining = value;
  const chars = new Array<string>(ULID_LENGTH);
  for (let i = ULID_LENGTH - 1; i >= 0; i--) {
    chars[i] = ALPHABET.charAt(Number(remaining & 31n));
    remaining >>= 5n;
  }
  // Unreachable while every call site bounds its input by MAX_ULID; kept because
  // "unreachable" is a property of today's call sites, not of the function.
  if (remaining !== 0n) {
    fail("ID_OVERFLOW", `ULID value exceeds 128 bits: ${value}`);
  }
  return chars.join("");
}

function decodeUlid(text: string): bigint {
  if (text.length !== ULID_LENGTH) {
    fail("ID_BAD_FORMAT", `ULID must be ${ULID_LENGTH} characters, got ${text.length}`, {
      length: text.length,
    });
  }
  let value = 0n;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    const digit = DECODE.get(char);
    if (digit === undefined) {
      fail(
        "ID_BAD_ALPHABET",
        `ULID character ${describe(char)} at index ${i} is outside Crockford base32 (I, L, O and U are excluded)`,
        { index: i, char },
      );
    }
    value = value * 32n + digit;
  }
  if (value > MAX_ULID) {
    fail("ID_OVERFLOW", `ULID decodes to more than 128 bits: first character must be 0-7`);
  }
  return value;
}

/* ── generation ──────────────────────────────────────────────────────────── */

let lastMs = -1n;
let lastRandom = 0n;

function randomBits80(): bigint {
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    fail(
      "ID_BAD_FORMAT",
      "no cryptographic random source: globalThis.crypto.getRandomValues is unavailable",
    );
  }
  const bytes = new Uint8Array(10);
  source.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Mints a new id.
 *
 * With no argument, ids are **monotonic**: those minted within the same
 * millisecond increment the random component instead of re-randomising, so
 * lexicographic order still equals creation order for a burst of writes. That
 * matters because the read model sorts by id and calls the result chronological,
 * and a burst is the normal case for an agent.
 *
 * With an explicit `nowMs`, the timestamp is honoured exactly and the monotonic
 * counter is neither read nor written. The parameter exists for deterministic
 * construction — tests, replaying a chain event, deriving an id for a known
 * instant — and an id whose embedded time is not the time you asked for would make
 * it useless. Ordering among explicitly-timed ids is the caller's business.
 */
export function newId<P extends IdPrefix>(prefix: P, nowMs?: number): Id<P> {
  assertPrefix(prefix);

  if (nowMs !== undefined) {
    const explicit = BigInt(Math.floor(nowMs));
    if (explicit < 0n || explicit > MAX_TIME) {
      fail("ID_BAD_FORMAT", `timestamp out of ULID range: ${explicit}`);
    }
    return `${prefix}_${encodeUlid((explicit << RANDOM_BITS) | randomBits80())}` as Id<P>;
  }

  const now = BigInt(Date.now());
  if (now < 0n || now > MAX_TIME) {
    fail("ID_BAD_FORMAT", `system clock out of ULID range: ${now}`);
  }

  if (now > lastMs) {
    lastMs = now;
    lastRandom = randomBits80();
  } else {
    // Same millisecond, or a clock that went backwards: keep the previous
    // timestamp and step the random component so ordering stays strict.
    if (lastRandom >= MAX_RANDOM) {
      fail("ID_CLOCK_EXHAUSTED", `more than 2^80 ids requested within millisecond ${lastMs}`);
    }
    lastRandom += 1n;
  }

  const value = (lastMs << RANDOM_BITS) | lastRandom;
  return `${prefix}_${encodeUlid(value)}` as Id<P>;
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

export interface ParsedId<P extends IdPrefix = IdPrefix> {
  readonly id: Id<P>;
  readonly prefix: P;
  readonly ulid: string;
  /** Milliseconds since the Unix epoch, from the ULID's 48-bit time component. */
  readonly timeMs: number;
  /** The 128-bit value, for on-chain conversion. */
  readonly value: bigint;
}

function assertPrefix(prefix: string): void {
  if (!PREFIX_SET.has(prefix)) {
    fail("ID_BAD_PREFIX", `unknown id prefix ${describe(prefix)}`, { prefix });
  }
}

/** Parses and validates an id. Throws `WrkError` on anything malformed. */
export function parseId<P extends IdPrefix>(id: string, expected?: P): ParsedId<P> {
  const separator = id.indexOf("_");
  if (separator === -1) {
    fail("ID_BAD_FORMAT", `id ${describe(id)} has no prefix separator`, { id });
  }
  const prefix = id.slice(0, separator);
  const ulid = id.slice(separator + 1);
  assertPrefix(prefix);
  if (expected !== undefined && prefix !== expected) {
    fail("ID_BAD_PREFIX", `expected prefix ${expected}, got ${prefix}`, { expected, prefix });
  }
  const value = decodeUlid(ulid);
  const timeMs = Number(value >> RANDOM_BITS);
  return {
    id: id as Id<P>,
    prefix: prefix as P,
    ulid,
    timeMs,
    value,
  };
}

/** Narrowing guard. Never throws. */
export function isId<P extends IdPrefix>(value: unknown, expected?: P): value is Id<P> {
  if (typeof value !== "string") return false;
  try {
    parseId(value, expected);
    return true;
  } catch {
    return false;
  }
}

/** Creation time of an id, as a `Date`. */
export function idTime(id: string): Date {
  return new Date(parseId(id).timeMs);
}

/* ── on-chain form ───────────────────────────────────────────────────────── */

/**
 * `bytes32` form: the ULID's 128 bits left-padded with 16 zero bytes.
 *
 * The prefix is deliberately **not** encoded. It is a display concern; on-chain
 * the object's type is implied by which mapping holds it. Round-tripping
 * therefore requires naming the prefix, which `fromBytes32` enforces.
 */
export function toBytes32(id: string): `0x${string}` {
  const { value } = parseId(id);
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Inverse of `toBytes32`. Rejects anything whose high 16 bytes are non-zero. */
export function fromBytes32<P extends IdPrefix>(hex: string, prefix: P): Id<P> {
  assertPrefix(prefix);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    fail("ID_BAD_BYTES32", `expected 0x followed by 64 hex digits, got ${describe(hex)}`);
  }
  const body = hex.slice(2);
  const high = body.slice(0, 32);
  if (/[^0]/.test(high)) {
    fail(
      "ID_BAD_BYTES32",
      `high 16 bytes must be zero for an id-shaped bytes32, got 0x${high}`,
      { high },
    );
  }
  const value = BigInt(`0x${body.slice(32)}`);
  return `${prefix}_${encodeUlid(value)}` as Id<P>;
}
