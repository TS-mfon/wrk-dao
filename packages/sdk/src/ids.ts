/**
 * Identifier conversion, in one place.
 *
 * On GenLayer an id is a prefixed ULID (`msn_01JQ8Z…`); on Base it is a `bytes32`. Two
 * representations of one identity means somewhere has to convert, and leaf-1.4.4:G3 says
 * that somewhere is the SDK — because the alternative is every caller doing it slightly
 * differently and one of them getting the padding wrong.
 *
 * The conversion is deliberately lossless and checked both ways: `fromBytes32(toBytes32(id))`
 * must return the id for every prefix, or an on-chain settlement would be keyed to
 * something nobody can map back.
 */

import { fromBytes32 as typesFrom, toBytes32 as typesTo, ID_PREFIXES, idPattern } from "@wrk/types";

export type IdPrefix = (typeof ID_PREFIXES)[number];

export { ID_PREFIXES };

export class IdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdError";
  }
}

/** A prefixed ULID as the `bytes32` the Base contracts use. */
export function toBytes32(id: string): string {
  try {
    return typesTo(id);
  } catch (error) {
    throw new IdError(error instanceof Error ? error.message : String(error));
  }
}

/** A `bytes32` back to its prefixed ULID. The prefix is not in the bytes, so it is named. */
export function fromBytes32(value: string, prefix: IdPrefix): string {
  try {
    return typesFrom(value, prefix);
  } catch (error) {
    throw new IdError(error instanceof Error ? error.message : String(error));
  }
}

/** Whether `value` is a well-formed id of `prefix`. */
export function isId(value: unknown, prefix: IdPrefix): boolean {
  return typeof value === "string" && new RegExp(idPattern(prefix)).test(value);
}

/** Throws unless `value` is an id of `prefix`. Used at every SDK entry point. */
export function assertId(value: unknown, prefix: IdPrefix, label = "id"): string {
  if (!isId(value, prefix)) {
    throw new IdError(`${label} must be a ${prefix}_ prefixed ULID, got ${JSON.stringify(value)}`);
  }
  return value as string;
}
