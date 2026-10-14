# WRK DAO — Architecture

**Status:** normative for this build. Derived from `docs/SPEC.md` (118 sections).
Where this document and the spec disagree, the disagreement is called out
explicitly and justified. Silent deviation is not permitted.

---

## 1. The one idea

SPEC §118 separates four authorities. Every design decision below is downstream
of keeping them separate:

| Authority | Holder | May decide |
|---|---|---|
| Organizational | WRK DAO (GenLayer) | who may work, what the rules are |
| Judgment | GenLayer adjudicator | whether the work met the criteria |
| Economic | Settlement adapter | when a finalized decision is executed |
| Custody | Base escrow (USDC) | where the money physically is |

The failure mode this guards against is one component acquiring two authorities.
An adapter that can decide *whether* work was good has taken judgment authority.
An indexer whose database row can authorize a release has taken economic
authority. Both are catastrophic and both are easy to build by accident, so they
are named as invariants (§4) and tested as must-fails (§112).

**No payment occurs at any step before GenLayer finality.** Not on proposal, not
on selection, not on mandate acceptance, not on deliverable submission. This is
the single most important sentence in the spec (§35–37) and it is the thing the
security matrix exists to prove.

---

## 2. Component map

```
                    ┌─────────────────────────────────────────┐
   agents ─────────▶│ API / SDK / MCP / agent-skill           │
   (API-first)      └───────────────┬─────────────────────────┘
                                    │ writes go to chain, never to Mongo
                                    ▼
   ┌────────────────────────────────────────────────────────────┐
   │ GenLayer (judgment + organizational authority)             │
   │   wrk_registry   agents, DAOs, rules, membership           │
   │   wrk_work       missions, proposals, mandates, evidence   │
   │   wrk_adjudicator  selection + adjudication (nondet)       │
   │   wrk_reputation   DAO-scoped reputation                   │
   └───────────────┬────────────────────────────────────────────┘
                   │ finalized decision (read-only)
                   ▼
   ┌────────────────────────────────────────────────────────────┐
   │ Settlement adapter (economic authority — executor only)    │
   │   watch → verify finality → attest (M-of-N) → post →       │
   │   challenge window (1h) → execute                          │
   └───────────────┬────────────────────────────────────────────┘
                   │ bounded transaction
                   ▼
   ┌────────────────────────────────────────────────────────────┐
   │ Base (custody)  WRKEscrow.sol + WRKSettlementVerifier.sol  │
   └────────────────────────────────────────────────────────────┘

   ┌────────────────────────────────────────────────────────────┐
   │ Indexer → MongoDB → Inspection UI   (READ MODEL ONLY)      │
   │ Never an input to settlement. Rebuildable from chain.      │
   └────────────────────────────────────────────────────────────┘
```

---

## 3. Decisions that deviate from the spec, and why

Three deviations. Each was chosen by the project owner and is recorded here so a
reviewer can find them without diffing against the spec.

### 3.1 Four consolidated Intelligent Contracts (SPEC §70, §96)

§96 sketches seven contracts (`dao_registry`, `work_dao`, `mission_engine`,
`proposal_engine`, `mandate_engine`, `adjudication_engine`, `reputation_engine`).
This build ships **four**:

| IC | Absorbs | Why grouped |
|---|---|---|
| `wrk_registry` | dao_registry, work_dao | Identity and organization are one lifecycle; splitting them means a cross-contract call on every permission check. |
| `wrk_work` | mission_engine, proposal_engine, mandate_engine | Mission → proposal → mandate is one state machine over one object graph. Splitting it puts the state machine's transitions behind three contracts and makes atomic transitions impossible. |
| `wrk_adjudicator` | adjudication_engine, + selection | The only IC containing non-deterministic blocks. Isolating *all* LLM calls in one contract means the consensus-sensitive surface is one file to audit. |
| `wrk_reputation` | reputation_engine | Unchanged. Kept separate because it is write-only post-settlement and must never be readable as an input to adjudication. |

The consolidation is not a simplification of behaviour — every §96 responsibility
still exists. It reduces cross-contract calls, which on GenLayer are a consensus
and latency cost, not just a code-organization cost.

**The adjudicator boundary is the one that matters.** Keeping every
`gl.nondet` block in a single contract means "which code can be
non-deterministic" is answerable by looking at one file, and `genvm-lint` has one
file to be strict about.

### 3.2 MongoDB, not PostgreSQL (SPEC §95)

§95 specifies PostgreSQL. **This build uses MongoDB**, at the project owner's
direction.

This is safe *here* specifically because of Invariant 10: the database is a read
model, never a source of truth and never an input to settlement. The properties
PostgreSQL would have bought — transactional integrity across related writes,
foreign-key enforcement, strong schema — are properties this build deliberately
does not depend on, because the chain already provides them and the indexer is
required to be rebuildable from chain state at any time.

What we give up and how it is covered:

| Lost | Mitigation |
|---|---|
| FK enforcement | Indexer writes are idempotent upserts keyed by on-chain id; orphans are a rebuild trigger, not a corruption. |
| Cross-row transactions | Each indexed document corresponds to one on-chain event. No write spans two documents. |
| Schema enforcement | Zod schemas validate on read *and* write; a schema-validation gate runs in CI. |
| Reproducible migrations | The read model is disposable. `indexer rebuild --from-block 0` is the migration. |

**The rebuild path is a tested gate, not a claim.** If it ever stops working, the
justification for this deviation collapses, so it is verified rather than
asserted.

### 3.3 Settlement gets a challenge window and a cron keeper

Chosen by the project owner: **M-of-N attestors bounded by the on-chain record,
plus a 1-hour challenge window, driven by a GitHub Actions cron keeper.**

This is an addition to §35–37, not a contradiction of it, but it needs care —
done naively, a challenge window *is* a second adjudication, which would hand
judgment authority to whoever can file a challenge. That would break §118.

**The rule that keeps it safe:** a challenge may assert exactly one thing —
*the posted settlement does not match the finalized GenLayer decision.* It is a
claim about **transcription**, never about **correctness**.

| Challenge says | Allowed? |
|---|---|
| "The posted `decisionHash` is not the finalized decision's hash." | Yes |
| "`releaseBp` posted is 7500, the decision says 5000." | Yes |
| "The payee address is not the mandate's accepted worker." | Yes |
| "The decision was finalized, but it was *wrong*." | **No** — rejected by the contract's shape; there is no field to express it. |

Disagreement with the decision itself belongs to GenLayer's appeal path, before
finality (§34). Once finalized, the decision is settled fact and the adapter's
only job is faithful transcription. The challenge window makes transcription
auditable; it does not reopen judgment.

Because a challenge is a mechanical claim, resolving it is mechanical: the
contract re-derives the settlement id from `(mandateId, decisionHash, nonce)` and
the attestation set, and either the signatures cover the posted parameters or
they do not. **No human and no LLM adjudicates a challenge.**

Flow:

```
1. fund      DAO deposits USDC into escrow for a mandate.            (any time after mandate accept)
2. post      Adapter submits (settlementId, decisionHash, splits,
             M-of-N attestor signatures). Starts a 1h timer.         (only after GenLayer finality)
   ── challenge window: 3600s ──
   2a. challenge   Anyone may submit a conflicting attestation set
                   for the same settlementId. Posted settlement is
                   voided; the adapter must re-post. Voiding is
                   cheap; wrongly releasing is not.
3. execute   After the window elapses with no challenge, the keeper
             calls execute(). Transfers USDC per the posted splits.
```

**Why `post` and `execute` are separate transactions:** it makes the window
observable on-chain rather than enforced by an off-chain delay. An adapter that
tried to fund-and-release in one transaction would make the window advisory.

**The keeper is not trusted.** A GitHub Actions cron runs every 10 minutes and
calls `execute()` on any settlement whose window has elapsed. `execute()` is
permissionless and fully validating: if the keeper is offline, compromised, or
malicious, the worst case is delayed settlement, and anyone may call `execute()`
instead. The keeper buys liveness, never authority.

**Known operational risk, accepted:** GitHub Actions cron is best-effort and can
be delayed under load, and scheduled workflows are disabled after 60 days of
repository inactivity. Mitigation: `execute()` is permissionless (anyone can
settle), the settlement remains valid indefinitely once posted, and the UI
surfaces overdue settlements. Liveness degrades; safety does not.

---

## 4. Invariants

These are the statements the security suite (§112) and E2E negatives (§111) must
prove. Each maps to at least one must-fail test.

| # | Invariant |
|---|---|
| I1 | No USDC leaves escrow before the corresponding GenLayer decision is **finalized** (not merely accepted). |
| I2 | A `settlementId` can be executed at most once. |
| I3 | `settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce))`; changing any input changes the id. |
| I4 | The settlement adapter cannot alter a decision's outcome — it may only transcribe or fail. |
| I5 | `releaseBp + refundBp == 10000` exactly; allocation shares sum to `10000` exactly. |
| I6 | Only the mandate's accepted worker(s) can be payees. |
| I7 | Only an agent's own key may act for that agent (no acting-for-another). |
| I8 | A mandate cannot be modified after acceptance. |
| I9 | Reputation is written only after final settlement, and is never an adjudication input. |
| I10 | **MongoDB state can never authorize a settlement.** The adapter reads chain, not database. |
| I11 | A finalized decision is executed identically no matter how many times it is observed. |
| I12 | A challenge can only assert transcription mismatch, never decision correctness. |
| I13 | Canonical JSON produces identical bytes in Python, TypeScript and Solidity. *(proven — `pnpm verify:hash-parity`)* |

I10 is the one most likely to be violated by well-meaning code. The adapter must
never take a mandate id, amount, or payee from a database row. It takes them from
the chain. A lint gate greps the adapter package for database imports.

---

## 5. Identifiers

`<prefix>_<ULID>` — ULID for lexicographic time-ordering (free sort by creation
in the read model) and 128 bits of entropy.

| Prefix | Object |
|---|---|
| `agt_` | agent |
| `dao_` | work DAO |
| `msn_` | mission |
| `prp_` | proposal |
| `mnd_` | mandate |
| `dlv_` | deliverable |
| `evd_` | evidence bundle |
| `dec_` | decision (selection or adjudication) |
| `stl_` | settlement |

On-chain, ids are `bytes32` (the ULID's 128 bits, left-padded). Off-chain they
are the canonical string form. The SDK converts; nothing else does.

Per §358, the canonical DAO identity comes from on-chain registration. The
indexer mirrors it and never mints one.

---

## 6. State machines

Every transition is an on-chain event. The read model derives state; it never
decides it.

**Mission:** `DRAFT → OPEN → PROPOSALS_CLOSED → SELECTING → SELECTED → MANDATED`
with terminal `CANCELLED` and `EXPIRED`.
Per §102, a mission is editable (version increments) only in `DRAFT`/`OPEN` with
zero proposals; the first proposal freezes it.

**Mandate:** `CREATED → ACCEPTED → FUNDED → IN_PROGRESS → SUBMITTED → ADJUDICATING → ADJUDICATED → SETTLED`
with terminal `REFUNDED`, `EXPIRED`, `CANCELLED`.
`SETTLED` is reachable only from `ADJUDICATED` **and** only via Base.

**Settlement:** `NONE → POSTED → (CHALLENGED → NONE) | EXECUTED`.
`EXECUTED` is terminal and irreversible. `CHALLENGED` returns to `NONE` so the
adapter can re-post correctly; it never destroys the escrow balance.

---

## 7. The decision payload — the bridge between judgment and money

This is the only structure that crosses from GenLayer to Base, so it is pinned
exactly. It is hashed per `docs/CANONICAL.md` §1 and the resulting `decisionHash`
is consumed as an opaque `bytes32` on Base.

```jsonc
{
  "schema_version": 1,
  "decision_id": "dec_<ULID>",
  "mandate_id":  "mnd_<ULID>",
  "verdict": "FULL_ACCEPTANCE" | "PARTIAL_ACCEPTANCE" | "REJECTION",
  "criteria_findings": [
    { "criterion_id": "ac_1", "met": true, "confidence_bp": 9500, "rationale": "..." }
  ],
  "release_bp": 7500,           // to workers   ─┐ must sum to exactly 10000
  "refund_bp":  2500,           // to DAO       ─┘
  "allocations": [              // shares of release_bp; must sum to exactly 10000
    { "agent_id": "agt_<ULID>", "share_bp": 6000 }
  ],
  "adjudicated_at_unix": 1790001234,
  "notes": "..."
}
```

Basis points, never percentages or floats — floats are rejected by canonical JSON
(`docs/CANONICAL.md` §1.1 rule 5) precisely so that money cannot be represented
in a type that rounds.

`FULL_ACCEPTANCE` ⇒ `release_bp == 10000`. `REJECTION` ⇒ `release_bp == 0`.
`PARTIAL_ACCEPTANCE` ⇒ `0 < release_bp < 10000`. The escrow re-checks this;
it does not trust the verdict label to match the numbers.

**Rounding:** integer division on basis points leaves a remainder of at most
`n-1` atomic units across `n` payees. The remainder goes to the **refund** leg,
never to a payee — so rounding can never over-pay, and the escrow's balance
assertion (`sum(transfers) == deposited`) holds exactly.

---

## 8. Attestation (EIP-712)

```solidity
domain = {
  name: "WRK Settlement",
  version: "1",
  chainId: <84532 | 8453>,
  verifyingContract: <WRKSettlementVerifier address>
}

struct Settlement {
  bytes32 settlementId;
  bytes32 mandateId;
  bytes32 decisionHash;
  uint256 nonce;
  uint16  releaseBp;
  uint16  refundBp;
  address[] payees;
  uint16[]  shareBp;
  uint64  genlayerFinalizedAt;
}
```

The domain separator binds `chainId` and `verifyingContract`, so an attestation
gathered for Base Sepolia cannot be replayed on mainnet or against a different
escrow. Signatures must arrive with **strictly ascending signer addresses** —
this makes duplicate-signer detection O(n) and closes the "same attestor signs M
times" attack without a nested loop.

Attestors are an on-chain set with an on-chain threshold M. "Bounded by the
on-chain record" (the owner's requirement) means the verifier independently
re-derives `settlementId` from on-chain mandate data and rejects any attestation
whose parameters disagree — attestors cannot introduce facts, only co-sign facts
the chain already holds.

### 8.1 Reentrancy guard: storage, not transient

The escrow uses OpenZeppelin's storage-based `ReentrancyGuard`, **not**
`ReentrancyGuardTransient`. This is deliberate and a leaf must not "upgrade" it.

`contracts/base/foundry.toml` sets `deny = "warnings"`, because a warning in code
holding USDC is a finding rather than a style note. The transient variant pulls in
`TransientSlot`, whose EIP-1153 composability advisory solc emits as a warning —
so using it would require relaxing warnings-as-errors across the whole settlement
layer. The trade was a few thousand gas on a path that runs once per settlement
against strict warnings on every line of the money path. Strict warnings won.

---

## 9. Read model (MongoDB)

Collections mirror on-chain objects one-for-one: `agents`, `daos`, `missions`,
`proposals`, `mandates`, `deliverables`, `evidence`, `decisions`, `settlements`,
`reputation`, plus `indexer_checkpoints`.

Rules:
1. Every document carries `chain_ref` (`{ chain, tx_hash, block, log_index }`).
2. Every write is an idempotent upsert keyed by on-chain id — replaying a block
   is a no-op.
3. No document is ever created without a corresponding chain event.
4. `indexer rebuild --from-block 0` reproduces the collection set byte-for-byte.
5. **No service that can move money may import the database client.**

---

## 10. Agent surface

Per §117, agents are first-class and the UI is inspection-only. The same
operations are reachable four ways, all over one API:

- **REST API** — the only writer; everything else wraps it
- **TypeScript SDK** — typed client, id conversion, signing
- **MCP server** — tools for MCP-capable agents
- **Agent skill** — packaged instructions for Claude-style agents

The web UI reads the MongoDB read model and **has no write path at all**. Not a
disabled one — an absent one.
