# WRK Canonical Hashing Contract

**Status:** normative. **Version:** `wrk/canonical-json/v1`.

SPEC §101 requires that everything important stored off-chain carry a hash, and
§40 requires a settlement id derived from `(mandate_id, decision_hash, nonce)`.
It does not say how to compute either. This document does, because the protocol
has three languages that must agree on every byte:

| Language   | Where                                         | Role                                  |
|------------|-----------------------------------------------|---------------------------------------|
| Python     | GenLayer Intelligent Contracts                | produces and verifies decision hashes |
| TypeScript | SDK, API, indexer, settlement adapter         | produces content hashes, signs        |
| Solidity   | Base escrow and settlement                    | verifies hashes, enforces replay       |

If they disagree on one byte, a decision that GenLayer finalised will not match
the decision the escrow was asked to settle, and the money stops moving. Worse,
a near-miss can be engineered: an attacker who finds two payloads that hash the
same in one language but not another gets to show the adjudicator one thing and
the escrow another. Everything below exists to close that gap.

There are exactly **two** hash constructions. Using the wrong one is a bug even
when the digest "looks fine".

---

## 1. Content hash — `keccak256` over canonical JSON

Used for anything whose content lives off-chain and whose integrity must be
provable later: DAO metadata and rules, mission metadata, proposals,
deliverables, evidence bundles, adjudication reports, settlement decisions.

```
content_hash = keccak256( ascii_bytes( canonical_json(value) ) )
```

`canonical_json` is a total function from a restricted JSON value space to a
pure-ASCII string. The restriction is the point: every place where two JSON
encoders could legitimately differ has been removed from the input space rather
than negotiated.

### 1.1 Rules

1. **Object keys are sorted ascending.** JavaScript sorts by UTF-16 code unit;
   Python sorts by code point. Rule 4 makes those the same ordering.
2. **No insignificant whitespace.** Separators are exactly `,` and `:`.
3. **Output is pure ASCII.** Only `0x20`–`0x7E` appear literally. Every code
   unit below `0x20` or above `0x7E` is escaped as `\uXXXX` with **lowercase**
   hex, except `\b \t \n \f \r \" \\`, which are always used where they apply.
   Non-BMP characters are escaped as their UTF-16 surrogate pair (`U+1F600`
   becomes `😀`). Lone surrogates are escaped as themselves and are
   legal — they never reach the byte stream.

   **`0x7F` (DEL) is escaped.** It is the single code point in `U+0000`–`U+10FFF`
   where a plausible "printable ASCII" boundary (`> 0x7E` vs `> 0x7F`) changes
   the answer, and it was found by exhaustive probe, not by reading either
   language's documentation. `scripts/verify-hash-parity.mjs` and the exhaustive
   probe in `pnpm verify:hash-parity:probe` both pin it.

4. **Object keys must match `^[A-Za-z0-9_]+$`.** Anything else is rejected.
   Restricting keys to ASCII is what makes rules 1's two sort orders identical.
   Without it, a key `U+1F600` sorts *before* `U+FFFD` in JavaScript (its lead
   surrogate `0xD83D` < `0xFFFD`) and *after* it in Python (`0x1F600` >
   `0xFFFD`), silently forking every hash containing both keys. Empty keys are
   also rejected.
5. **Numbers must be safe integers**, i.e. in `[-(2^53-1), 2^53-1]`. Floats,
   `NaN`, `Infinity`, and out-of-range integers are rejected. `-0` normalises
   to `0`. **Token amounts, timestamps and ids that can exceed 2^53 travel as
   decimal strings**, never as numbers — a `uint256` USDC amount is a string.
6. **`undefined` is rejected; `null` is allowed.** Arrays preserve their order.

### 1.2 The one accepted asymmetry

JavaScript has a single number type, so by the time `JSON.parse` finishes, the
spelling `2.0` has become the safe integer `2` and the encoder emits `2`. Python
keeps the distinction and **rejects** the float.

This is deliberate and tested (`reject_python_only` in
`fixtures/canonical-inputs.json`). It is safe in the only direction that
matters: a producer that emits `2.0` causes Python to refuse the payload, so the
mission or decision is never created. It can never cause Python to emit `2.0`
where JavaScript emits `2`. Fail-closed on one side beats agreement on a wrong
byte.

Producers must emit integer spellings. Python enforces it.

### 1.3 Why `keccak256` and not SHA-256

Solidity verifies these hashes. `keccak256` is a single EVM opcode; SHA-256 is a
precompile call with a different cost profile, and mixing the two across layers
invites exactly the confusion this document exists to prevent. One digest
function everywhere.

### 1.4 Why ASCII output makes Solidity safe

Because canonical output contains no byte above `0x7E`, its UTF-8 encoding is
byte-identical to its ASCII encoding. Solidity's `keccak256(bytes(s))` on a
string literal therefore hashes the same bytes that Python and TypeScript hash,
with no UTF-8 encoder in the contract and no lone-surrogate edge case to handle
on-chain.

---

## 2. Struct hash — `abi.encode`, never `abi.encodePacked`

Used for on-chain identifiers and signed messages built from a **fixed set of
typed fields**, not from off-chain content. Per SPEC §40:

```solidity
settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce));
```

**`abi.encodePacked` is forbidden for any hash over more than one dynamic
field.** Packed encoding concatenates without length prefixes, so
`("ab", "c")` and `("a", "bc")` produce identical bytes and therefore identical
settlement ids. `abi.encode` pads every field to 32 bytes and length-prefixes
dynamic types, making the encoding injective. A lint gate enforces this.

Attestor signatures use **EIP-712** typed data, which is a struct hash with a
domain separator binding `chainId` and `verifyingContract`, so a signature
gathered for Base Sepolia cannot be replayed against Base mainnet or against a
different escrow deployment.

### 2.1 Where the two constructions meet

`decisionHash` is a **content hash** (§1) of the GenLayer decision payload. It is
then consumed as an opaque `bytes32` field inside a **struct hash** (§2). The
content hash is computed once, off-chain and in the IC; Solidity never
re-serialises JSON. That boundary is deliberate: no JSON parser runs on-chain.

---

## 3. What is frozen, and what breaks if it changes

`fixtures/canonical-vectors.json` holds 41 vectors: input, exact canonical text,
exact `keccak256`. It is the cross-language contract. Every implementation must
reproduce it:

- `packages/types` — production TypeScript encoder
- `contracts/genlayer/lib/canonical.py` — production Python encoder
- `contracts/base` — Solidity tests assert the frozen digests for the struct
  constructions and for a sample of content hashes

Verification is three-way and independent:

```bash
pnpm verify:hash-parity        # JS vs Python, byte for byte, + frozen vectors
pnpm verify:hash-parity:probe  # exhaustive escape probe, U+0000-U+10FFF
forge test --root contracts/base --match-contract CanonicalVectors
```

The digests were cross-checked against **three** independent implementations:
this repo's encoder via viem, Python's `json.dumps`, and Foundry's `cast keccak`
(the EVM's own keccak). Agreement between two implementations that share a
lineage proves nothing; these three do not.

### 3.1 One correction, recorded

`fixtures/canonical-inputs.json`'s `wrk_mission_payload.creator_agent_id` was
`agt_01JQ8Z0Q1R2S3T4U5V6W7X8Y9Z`. That string contains `U`, which Crockford base32 —
and therefore ULID — excludes, so it was not a valid identifier. It was found by
`packages/types`' schema refusing it, and pinned by a test rather than fixed silently.

It has now been corrected to `agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A`, which re-derived **exactly
one** of the 41 frozen digests:

```
wrk_mission_payload  0x1b591083…db0ac30f  ->  0xc7280e3e…786df456
```

That scope was verified mechanically before re-pinning: the other 40 vectors are
byte-identical. **No rule in §1 changed**, so this is not a version bump — the algorithm
is untouched and a malformed *sample input* was replaced. All three implementations were
re-verified against the corrected set, and `fixtures/FIXTURES.lock.json` re-pinned.

**Changing any rule in §1 changes every hash in the protocol.** It is a breaking
protocol change, not a refactor. It requires a new version string
(`wrk/canonical-json/v2`), a migration for every stored hash, and re-freezing the
vectors with `node scripts/verify-hash-parity.mjs --write`. The harness refuses
to re-freeze while parity is broken, so a green re-freeze cannot launder a
divergence.

---

## 4. Implementer's checklist

- [ ] Sort keys; do not rely on insertion order or on `JSON.stringify` defaults.
- [ ] Reject non-conforming keys loudly. A silently dropped key is a silent fork.
- [ ] Never send a `uint256` as a JSON number. Decimal string.
- [ ] Never hash a JSON string where §2 calls for `abi.encode`, or the reverse.
- [ ] Never use `abi.encodePacked` for a multi-field hash.
- [ ] Re-run `pnpm verify:hash-parity` after touching any encoder. It is a gate.
