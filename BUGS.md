# BUGS

Defects found while building WRK DAO, with how to reproduce each one, what actually caused
it, and either the gate that now covers the fix or an explicit reason it is still open.

Why this file exists in the repository rather than only in the build log: a defect recorded
in `.unlazy/wrk/status.log` does not survive a clone, because that directory is untracked.
`scripts/verify-bugs-ledger.mjs` (root gate G18) refuses an entry that is neither fixed with
evidence nor open with a reason — a bug list where entries are undecided is a list nobody
can act on.

**Severity** is about consequence if shipped, not about how hard it was to find.
`critical` would move money wrongly or lose it; `high` corrupts data or defeats a
guarantee; `medium` breaks a build or a verification path; `low` is friction.

Entries are numbered in the order they were found.

---

### BUG-001 — `newId(prefix, nowMs)` ignored the timestamp it was given

- **Severity:** medium
- **Status:** fixed
- **Area:** `packages/types`
- **Reproduce:** call `newId("agt", 1700000000000)` twice with the same explicit
  millisecond value and compare the decoded timestamp halves; before the fix the monotonic
  counter overrode the argument, so the decoded time was wall-clock, not the value passed.
- **Root cause:** the monotonic-counter branch ran unconditionally. The explicit-timestamp
  path shared state with it instead of bypassing it.
- **Fix:** the explicit path now honours its argument and neither reads nor writes monotonic
  state. A caller asking for a specific timestamp gets exactly that.
- **Covered by:** `leaf-1.1.1:G5`

---

### BUG-002 — a frozen canonical fixture contained an illegal Crockford character

- **Severity:** high
- **Status:** fixed
- **Area:** `fixtures/`
- **Reproduce:** validate `wrk_mission_payload.creator_agent_id` from the pre-fix fixture
  against `id_pattern("agt")`; it contains `U`, which Crockford base32 excludes.
- **Root cause:** the fixture was authored by hand before the id validator existed, and the
  frozen digests were taken from it — so an invalid id was pinned as correct.
- **Fix:** corrected the id, then proved mechanically that exactly 1 of 41 digests changed
  (`0x1b591083…` → `0xc7280e3e…`) before re-pinning. No canonical *rule* changed, so no
  schema version bump. All three language implementations re-verified. The test that had
  pinned the defect was replaced by one asserting validity, plus a new test checking every
  id in both frozen payloads.
- **Covered by:** `root:G1`, `root:G7`, recorded in `docs/CANONICAL.md` §3.1

---

### BUG-003 — invalid `forge-lint` disable comments silently failed the build under `deny = "warnings"`

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/base`
- **Reproduce:** add `// forge-lint: disable-next-line(block-timestamp)` and run
  `forge build --force`. The id is emitted by the compiler but absent from `forge lint`'s
  registry, so each comment becomes an "unknown lint id" warning, and `deny = "warnings"`
  turns that into exit 1.
- **Root cause:** two causes stacked. The id is not a registered lint, *and* `forge build`
  without `--force` skips recompilation and therefore skips linting — so the build looked
  clean locally while being broken.
- **Fix:** replaced all five inline comments with `[lint] exclude_lints = ["block-timestamp"]`
  in `foundry.toml`, and every build gate now passes `--force`.
- **Covered by:** `leaf-1.3.1:G1`
- **Note:** the underlying `forge lint` id mismatch is BUG-019 and is still open upstream.

---

### BUG-004 — test contract exceeded the 49152-byte initcode limit

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/base/test`
- **Reproduce:** put every escrow test in one contract that constructs its fixtures with
  `new X(...)`; deployment of the test contract itself reverts on the initcode cap.
- **Root cause:** every `new X(...)` embeds X's creation code in the caller, and embedding
  is transitive — the test contract carried the bytecode of everything it ever constructed.
- **Fix:** split `EscrowTest` into 7 contracts, and used `vm.deployCode` for the invariant
  handler so its bytecode is loaded rather than embedded.
- **Covered by:** `leaf-1.3.1:G1`, `leaf-1.3.1:G2`

---

### BUG-005 — `vm.expectRevert` was consumed by an intervening external call

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/base/test`
- **Reproduce:** call `vm.expectRevert(...)`, then call a view (`settlementDigest`) while
  building the arguments, then call the function under test. The cheatcode applies to the
  view, which does not revert, and the test fails as "call did not revert" even though the
  target would have reverted.
- **Root cause:** `expectRevert` applies to the *next* external call, and a helper that
  computes a signature makes one.
- **Fix:** signature computation hoisted above `expectRevert` in all four affected tests.
- **Covered by:** `leaf-1.3.1:G6`

---

### BUG-006 — a forged struct and the honest one hashed identically

- **Severity:** high
- **Status:** fixed
- **Area:** `contracts/base/test`
- **Reproduce:** `Settlement memory forged = honest; forged.releaseBp = 10000;` then
  compare `hash(honest)` and `hash(forged)`. They match, and a replay-protection test
  passes without testing anything.
- **Root cause:** memory structs in Solidity are reference types. The assignment copies a
  pointer, so mutating "the copy" mutates the original.
- **Fix:** hash before mutating, and assert the two digests differ before using them.
- **Covered by:** `leaf-1.3.3:G2`

---

### BUG-007 — invariant coverage was decorative

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/base/test`
- **Reproduce:** run the escrow invariant suite and count handler calls: 1 `execute` and
  0 `refundExpired` per 64-call run. The invariants held because almost nothing happened.
- **Root cause:** `execute` and `refundExpired` are only reachable inside specific time
  windows, and the handler never warped into them, so the fuzzer spent its budget on
  rejected calls.
- **Fix:** the handler now warps into each window before calling, and `tryExecuteEarly`
  was added so the in-window refusal stays covered too.
- **Covered by:** `leaf-1.3.3:G4`

---

### BUG-008 — a gate I wrote could not fail deterministically, and was hiding an unreachable function

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/base/test`
- **Reproduce:** assert a per-sequence coverage floor in `afterInvariant`. Foundry reverts
  handler state between runs and the last sequence's depth varies, so the floor passes or
  fails depending on run length.
- **Root cause:** `afterInvariant` sees only the final sequence, which is not a sample of
  the whole run.
- **Fix:** replaced with a deterministic `EscrowHandlerReachabilityTest` that calls each
  handler path once and asserts it is reachable. It immediately found that `refundExpired`
  was unreachable because a string replacement had silently not matched — a real defect the
  flaky gate had been concealing.
- **Covered by:** `leaf-1.3.3:G4`

---

### BUG-009 — the CI fuzz profile was 4× over the per-check time budget

- **Severity:** low
- **Status:** fixed
- **Area:** `contracts/base`
- **Reproduce:** run the `ci` profile at fuzz 2048 / invariant 2048×128: 491s against a
  120s per-check budget.
- **Root cause:** my own per-mandate invariants loop over every mandate, making each step
  O(depth²).
- **Fix:** settled at fuzz 8000 / invariant 512×80 = 69s, and added an ungated `soak`
  profile at 100000/2048×128 for deliberate long runs. The gate title that still asserted
  the old numbers was corrected too.
- **Covered by:** `leaf-1.3.3:G7`

---

### BUG-010 — `genvm-lint` reported success while half the tool was failing

- **Severity:** high
- **Status:** fixed
- **Area:** `contracts/genlayer`, `scripts/`
- **Reproduce:** run `genvm-lint check` on a contract that imports `lib/`. It prints
  `✓ Lint passed` and `✗ Validation failed — Import error: No module named 'lib'`, and the
  original gate expected only "Lint passed" — so the gate went green while the contract was
  not loadable by any runner.
- **Root cause:** two causes. The linter does not put the contract's own directory on
  `sys.path`, so validation never ran at all; and the gate's `EXPECT` matched the half that
  was passing.
- **Fix:** `PYTHONPATH=contracts/genlayer` makes validation run, and all four G1 gates now
  expect `✓ Validation passed`, which requires both halves.
  `scripts/verify-ic-lint.mjs` was updated to match and to refuse a skipped validation pass.
- **Covered by:** `leaf-1.2.1:G1`, `leaf-1.2.2:G1`, `leaf-1.2.3:G1`, `leaf-1.2.4:G1`,
  `node-1.2:N4`

---

### BUG-011 — runner aliases are rejected by every GenLayer network

- **Severity:** high
- **Status:** fixed
- **Area:** `contracts/genlayer`
- **Reproduce:** deploy a contract whose header depends on `py-genlayer:test` → "Runner
  hash test not found". `py-genlayer:latest` and an unversioned dependency fail too.
- **Root cause:** `:test` and `:latest` are local-Studio development aliases. A contract
  carrying one deploys nowhere.
- **Fix:** all four contracts pin concrete runner hashes. Additionally, a contract importing
  `lib/` is a multi-file package and needs `py-genlayer-multi` **in addition to**
  `py-genlayer`, in a `Seq` block — pinning the multi runner alone makes the linter warn
  "Missing py-genlayer dependency" and then fail validation.
- **Covered by:** `leaf-1.2.1:G1` … `leaf-1.2.4:G1`

---

### BUG-012 — `@staticmethod` is unusable inside a `gl.Contract`

- **Severity:** low
- **Status:** fixed
- **Area:** `contracts/genlayer`
- **Reproduce:** define a `@staticmethod` helper in a `gl.Contract` subclass and run
  `genvm-lint check`: "Method '_membership_key' must have 'self' as first parameter".
- **Root cause:** the GenVM linter requires `self` on every method of a contract class.
- **Fix:** three helpers converted to instance methods; one dead helper removed.
- **Covered by:** `leaf-1.2.1:G1`

---

### BUG-013 — gltest address fixtures change type depending on test order

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/genlayer/tests`
- **Reproduce:** use `direct_alice` as `vm.sender` in the first test of a session and again
  in a later test. The fixture returns raw `bytes` while the GenVM SDK is unimportable and
  an `Address` once it is, and `sys.modules` persists — so the first test sees bytes and the
  rest see `Address`, which raises "cannot convert 'Address' object to bytes" from inside
  the VM. 12 tests failed this way.
- **Root cause:** `create_address` behaves differently before and after the SDK loads, and
  whether it has loaded depends on whether an earlier test deployed anything.
- **Fix:** an `as_bytes()` normaliser in each direct-mode suite.
- **Covered by:** `leaf-1.2.1:G2`

---

### BUG-014 — indexed event fields bound to alphabetical order, silently swapping topics

- **Severity:** high
- **Status:** fixed
- **Area:** `contracts/genlayer`
- **Reproduce:** declare `class MemberJoined(gl.Event): def __init__(self, dao_id, agent_id, /, **blob)`,
  emit `MemberJoined(dao_id_value, agent_id_value)`, then read `event._blob["agent_id"]` —
  it holds the **DAO** id.
- **Root cause:** the GenVM SDK computes `indexed_args = tuple(sorted(indexed_args_lst))` and
  then binds positional arguments with `zip(indexed_args, args)`. Positional arguments bind
  to the alphabetically sorted field names, not to declaration order. Nothing warns.
- **Consequence if shipped:** an indexer filtering on the `agent_id` topic would have matched
  DAO ids, so the read model would attribute membership, acceptance and reputation to the
  wrong subject. All three multi-indexed events were affected: `MemberJoined`,
  `MandateAccepted`, `ReputationRecorded`.
- **Fix:** all multi-indexed events are declared alphabetically, the reason is documented at
  each declaration site, and the trap is closed structurally — an AST check parses all four
  contracts and fails if any event's indexed fields are not already sorted, with a positive
  control proving the check fires.
- **Covered by:** `test_cross_contract.py::TestCrossContractEvents::test_cross_contract_events_declare_indexed_fields_in_sorted_order`,
  gated through `node-1.2:N5`

---

### BUG-015 — the Intelligent Contracts emitted no events, making the read model unbuildable

- **Severity:** high
- **Status:** fixed
- **Area:** `contracts/genlayer`
- **Reproduce:** attempt to satisfy `docs/ARCHITECTURE.md` §9 rule 1 (every document carries
  `chain_ref` with `tx_hash`, `block`, `log_index`) from the contracts as first written.
  There is no source for those fields, because nothing was emitted.
- **Root cause:** the contracts were built to be *correct* before they were built to be
  *observable*. §9's read model is event-sourced, and an indexer polling contract views
  cannot know which transaction a change came from, cannot be idempotent per event, and
  cannot heal a reorg precisely.
- **Fix:** 25 emissions added across the four contracts. Mission and mandate transitions emit
  from the two `_set_*_state` helpers, so "exactly one event per state change" is structural
  rather than something to remember at seventeen call sites. 14 tests assert the catalogue,
  the indexed ids, exactly-once emission with the previous state named, that a refused call
  emits nothing, and that custody relays carry the Base transaction hash.
- **Covered by:** `node-1.2:N5`, `node-1.2:N6`

---

### BUG-016 — patching the contracts' clock meant their own time code never ran

- **Severity:** medium
- **Status:** fixed
- **Area:** `contracts/genlayer/tests`
- **Reproduce:** `monkeypatch.setattr(module, "_now", lambda: FIXED)`, then search any test
  transcript for evidence that `int(datetime.now(timezone.utc).timestamp())` executed. It
  never did, in any of the three suites that controlled time.
- **Root cause:** I replaced the function instead of controlling its input — a coverage gap I
  introduced while making deadline logic testable.
- **Fix:** `VMContext.warp(iso)` is the native seam (it patches `datetime.datetime.now` to
  read the VM's warped time, the same idea as Foundry's `vm.warp`). All three suites now move
  the harness clock, so the contracts' real time code runs.
- **Covered by:** `leaf-1.2.2:G5`, `leaf-1.2.3:G10`, `leaf-1.2.4:G3`

---

### BUG-017 — a test assertion I wrote could not fail

- **Severity:** low
- **Status:** fixed
- **Area:** `contracts/genlayer/tests`
- **Reproduce:** read `test_reputation.py` before the fix: an assertion ended in `or True`,
  making it vacuous.
- **Root cause:** I was trying to assert that the word "reputation" does not appear in the
  adjudicator's source, which is the wrong oracle — it appears there in prose explaining why
  reputation must not be an input. Rather than delete the bad assertion I had neutralised it.
- **Fix:** removed. The real check is on the adjudicator's contract *handles*: it opens
  exactly one, to `wrk_work`, so there is no path by which reputation could become an
  adjudication input.
- **Covered by:** `leaf-1.2.4:G6`

---

### BUG-018 — `forge script` resolves the script path against the shell's cwd, not `--root`

- **Severity:** low
- **Status:** fixed
- **Area:** `contracts/base/script`
- **Reproduce:** `forge script script/Deploy.s.sol --root contracts/base` from the repository
  root → "contract source info format must be `<path>:<contractname>`".
- **Root cause:** `--root` sets the project root for resolution of remappings and output, but
  the script path argument is resolved against the current directory.
- **Fix:** the gate runs `cd contracts/base && forge script script/Deploy.s.sol`.
- **Covered by:** `leaf-1.3.3:G6`

---

### BUG-019 — `forge lint` does not recognise the `block-timestamp` id it emits

- **Severity:** low
- **Status:** open
- **Area:** toolchain (Foundry)
- **Reproduce:** `// forge-lint: disable-next-line(block-timestamp)` → "unknown lint id",
  even though the compiler emits a `block-timestamp` diagnostic.
- **Root cause:** upstream. The diagnostic id and the lint-suppression registry disagree.
- **Open reason:** not ours to fix, and the workaround is clean. Kept open rather than
  closed so that if Foundry aligns the two, the file-level exclusion can be narrowed back to
  the five specific lines that need it.
- **Workaround:** `[lint] exclude_lints = ["block-timestamp"]` in `foundry.toml`, which is
  broader than the five lines that need it. Documented in `.unlazy/wrk/gates/leaf-1.3.1.md`.

---

### BUG-020 — GenVM runner v0.3.0-rc7 fails to decode any contract's calldata

- **Severity:** high
- **Status:** open
- **Area:** toolchain (GenVM runner)
- **Reproduce:** deploy any contract in gltest direct mode with `sdk_version="v0.3.0-rc7"`,
  or with no `sdk_version` at all (which resolves to the newest release):
  `genlayer.calldata.DecodingError: unexpected end of memory`. Reproduced with a one-field
  contract with no imports, so it is not contract-specific.
- **Root cause:** upstream, in the runner's own calldata decoder. Nothing on our side to fix.
- **Open reason:** we cannot fix another project's runner. Recorded because it dictates a
  pin, and anyone who removes that pin will hit it immediately.
- **Workaround:** `DIRECT_SDK_VERSION = "v0.2.16"` is pinned in
  `contracts/genlayer/tests/direct/conftest.py` with the reasoning inline, and the four
  contracts pin concrete runner hashes present in that set.

---

### BUG-021 — gltest direct mode loads exactly one contract class per test

- **Severity:** medium
- **Status:** open
- **Area:** toolchain (gltest)
- **Reproduce:** call `direct_deploy` twice in one test with two different contract files:
  `ImportError: Failed to load contract: only one contract is allowed; first: <WrkRegistry>
  second: <WrkWork>`. Separate tests each loading a different class are fine, so the limit is
  per test.
- **Root cause:** `gl.Contract.__init_subclass__` registers into a module-level
  `__known_contract__` and refuses a second. Compounding it, `_allocate_contract` binds every
  contract to the same storage root (`ROOT_SLOT_ID`), so two in one VM would overwrite each
  other regardless.
- **Open reason:** a harness limitation we work around rather than a defect in our code. Kept
  open because the workaround is intricate enough that anyone touching the integration suite
  needs to know why it is shaped that way.
- **Workaround:** each contract gets its own `VMContext`, `__known_contract__` is reset
  between loads, and `gl.get_contract_at` is routed through a bridge that presents the
  calling contract's address as sender. Documented at length in
  `contracts/genlayer/tests/direct/test_cross_contract.py`.

---

### BUG-022 — leaving a `VMContext` activation purges the SDK; nesting one silently changes the sender

- **Severity:** medium
- **Status:** open
- **Area:** toolchain (gltest)
- **Reproduce:** (a) deploy inside `with vm.activate():`, leave the block, then
  `import genlayer` → `ModuleNotFoundError`; the activation's exit removes the SDK from both
  `sys.path` and `sys.modules`. (b) With one activation already open, nest another around a
  contract call: the call executes as the **deploying** address rather than the address just
  assigned to `vm.sender`, because re-entering re-imports the SDK and the SDK reads
  `gl.message` from fd 0 — the message injected at deploy time.
- **Root cause:** upstream harness design. `gl.message` is a process-wide global refreshed by
  the `vm.sender` setter, while activation owns `sys.path`, `sys.modules` and the wasi storage
  shim; the two lifetimes are not the same and nothing warns when they diverge.
- **Consequence if not known:** (b) is silent and dangerous in a test. Every agent in the
  first draft of the integration harness registered as the same operator, and every
  authorization check passed for the wrong reason.
- **Open reason:** not ours to fix. Recorded because the symptom (authorization checks
  passing) looks like success.
- **Workaround:** never nest activations; hold one open for the SDK's lifetime, set
  `vm.sender` directly, and point `wasi_mock.set_vm` at the contract being called, restoring
  the caller's store on the way out.

---

### BUG-023 — an unlazy approval is invalidated by passing `--timeout`

- **Severity:** low
- **Status:** open
- **Area:** build process
- **Reproduce:** approve a ledger, then re-run `--reverify` with `--timeout 900`. Every gate
  reports `APPROVAL REQUIRED` and nothing executes.
- **Root cause:** by design — approvals bind the resolved timeout along with the command,
  cwd, shell and PATH, so changing any of them requires approval again.
- **Open reason:** correct behaviour, not a defect, but it reads as a failure the first time
  and cost a confused re-run. Recorded as friction so the next person recognises it.
- **Workaround:** reverify with the same flags the approval was taken under, or approve again
  deliberately.

---

### BUG-024 — MongoDB was assumed reachable and was not

- **Severity:** low
- **Status:** fixed
- **Area:** build environment
- **Reproduce:** `MONGODB_URI` in `.env` points at `127.0.0.1:27017` with no server there;
  any indexer gate fails on connection rather than on its own claim.
- **Root cause:** the URI was configured before a server existed.
- **Fix:** the gates provision their own database. `verify/_common.mjs` uses `MONGODB_URI`
  when something is actually listening there, and otherwise starts a
  `mongodb-memory-server` replica set — a **real mongod**, downloaded and run, not a mock.
  That is what honours `leaf-1.4.1`'s note that an unreachable database is a failed
  verification rather than evidence: the gate makes a server exist instead of skipping
  because an operator forgot to start one. A replica set rather than a standalone because
  transactions need one and because the live deployment is one, so a gate passing only
  against a standalone would be testing a configuration nobody runs.
- **Covered by:** `leaf-1.4.1:G3`, `leaf-1.4.1:G4`, `leaf-1.4.1:G6`, `leaf-1.4.1:G7`

---

### BUG-025 — the reorg detection window was bounded by the finality depth, hiding deep reorgs

- **Severity:** high
- **Status:** fixed
- **Area:** `packages/indexer`
- **Reproduce:** index a five-block chain with `finalityDepth: 0`, then rewrite history from
  block 3. The indexer detects *that* the tip changed but reports the common ancestor as
  block 4 instead of block 2, removes 1 orphaned document instead of 3, and leaves two
  documents derived from blocks that no longer exist.
- **Root cause:** `newCheckpoint` retained recent block hashes with
  `recent.slice(-Math.max(depth, 1))`, where `depth` was the finality depth. The two are
  opposite concerns — the finality depth limits how far *forward* the checkpoint may
  advance, the retained window limits how far *back* a rewrite can be located — and
  conflating them meant that the more aggressively the indexer was configured to index, the
  less of a reorg it could see. At depth 0 the window was a single hash, so detection could
  tell that the tip had changed but not how far the rewrite went.
- **Consequence if shipped:** surviving documents derived from orphaned blocks. Because the
  database is never authoritative, the symptom is a UI reporting a settlement that did not
  happen rather than a crash — which is harder to notice, not less serious.
- **Fix:** a separate `REORG_WINDOW` of 64 blocks governs retention, independent of the
  finality depth, and the retained window is deduplicated by height so a re-index cannot
  double a block. The gate now also exercises a reorg of the entire chain and asserts a
  quiet pass reports no reorg, so neither over- nor under-detection passes.
- **Covered by:** `leaf-1.4.1:G7`

---

### BUG-026 — pushes to GitHub intermittently time out

- **Severity:** low
- **Status:** open
- **Area:** build environment
- **Reproduce:** `git push origin main` from this machine fails roughly half the time with
  `Failed to connect to github.com port 443 after ~135000 ms`. `git ls-remote` and
  `gh api` fail the same way. A retry usually succeeds.
- **Root cause:** not determined, and not in this repository — the same commands succeed on
  retry with no change to the repository, the remote or the credentials.
- **Open reason:** environmental and outside the project. Recorded because it makes a push
  look like a failure when it is a flake, and because it shaped a real design decision: the
  GitHub gate was rewritten to answer from local refs rather than the API after the API
  version exceeded the 120s gate budget.
- **Workaround:** `deploy/verify-github.mjs` makes exactly one network call, retried three
  times with a short per-attempt timeout, and answers everything else from the local object
  store. Pushes are retried rather than treated as failed on the first timeout.

---

### BUG-027 — verification scripts required the environment to be exported by hand

- **Severity:** low
- **Status:** fixed
- **Area:** `packages/indexer`
- **Reproduce:** run `pnpm --filter @wrk/indexer verify:schemas` in a fresh shell with
  `MONGODB_URI` set in `.env` but not exported: `MONGODB_URI is not set`.
- **Root cause:** the scripts read `process.env` and nothing loaded the repository's
  gitignored `.env` into it. A gate that only runs when the caller happens to have exported
  a variable fails for the wrong reason on a fresh clone and in CI.
- **Fix:** `verify/_common.mjs` loads `.env` into `process.env` on import, without
  overwriting anything already set so an explicit override still wins.
- **Covered by:** `leaf-1.4.1:G4`
