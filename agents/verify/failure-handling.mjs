// leaf-1.6.4:G7 — every API error either stops the agent with a reported reason or is
// retried under a stated policy. A failed call is never silently skipped.
//
// This is the gate most likely to be skipped and the one that decides whether the agents
// are usable or merely lucky: an agent that swallows a 500 and carries on reports success
// for a mandate that was never funded.
//
// It is proven by injection, not by reading the code. For EVERY write the two agents make,
// three scenarios run:
//
//   transient  one failure, then the call succeeds. The policy is to retry a 5xx, so the
//              run must still settle and the transcript must say it retried.
//   permanent  the call fails every time. Retries are finite, so the agent must STOP, and
//              the transcript's last word on that step must be a failure with a reason.
//   refusal    the contract refuses. A refusal is deterministic, so it must NOT be retried
//              -- repeating it cannot help, and in relay mode each attempt is a
//              transaction. The step is recorded `refused`, which is a different word from
//              `failed` on purpose.
//
// The enumeration is derived from the agents' own source, so a new write added to either
// agent without a story for its failure fails this gate rather than slipping past it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runScenario, WRITES } from "./_scenario.mjs";
import { stopAll, AGENTS_DIR, BRIEF, fail } from "./_world.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

/** Tight, because 39 scenarios each wait out a poll budget. See `runScenario`. */
const POLL = { attempts: 40, intervalMs: 10 };

// Reads are not injected: a read that fails is handled by the same `step()` policy, and a
// read is idempotent so there is nothing to prove about a retry that a write does not
// already prove. Writes are where a silent skip costs a mandate.
const READ_ONLY = new Set([
  "one", "list", "proposals", "mandates", "missions", "memberships", "openMissions",
  "evidence", "decisions", "reputation", "deliverables", "daos", "agents", "settlements", "payments",
]);

// ── the enumeration must cover what the agents actually call ────────────────

const sources = ["src/commissioner/agent.ts", "src/worker/agent.ts"].map((path) => ({
  path,
  text: readFileSync(resolve(AGENTS_DIR, path), "utf8"),
}));

const called = new Set();
/** How many of the two agents call each method, which is how many attempts a refusal gets. */
const callers = new Map();
for (const source of sources) {
  const inThisAgent = new Set();
  for (const match of source.text.matchAll(/this\.client\.(\w+)\s*\(/g)) {
    called.add(match[1]);
    inThisAgent.add(match[1]);
  }
  for (const method of inThisAgent) callers.set(method, (callers.get(method) ?? 0) + 1);
}
const writesCalled = [...called].filter((method) => !READ_ONLY.has(method)).sort();

for (const method of writesCalled) {
  if (!WRITES[method]) {
    problems.push(
      `the agents call this.client.${method}() but no failure scenario is defined for it; add it to WRITES or to READ_ONLY with a reason`,
    );
  }
}
for (const method of Object.keys(WRITES)) {
  if (!called.has(method)) {
    problems.push(`a failure scenario is defined for ${method} but neither agent calls it, so the scenario tests nothing`);
  }
}

if (problems.length > 0) fail("AGENTS-FAILURE-HANDLING", problems);

// ── the injections ──────────────────────────────────────────────────────────

/** The transcript entries for one chain method, across both agents. */
const entriesFor = (run, sdkMethod) =>
  [...run.commissionerTranscript.all, ...run.workerTranscript.all].filter((entry) => entry.action === sdkMethod);

const results = [];

try {
  for (const [sdkMethod, chainMethod] of Object.entries(WRITES)) {
    // ── transient: one failure, retried, the run still completes ────────────
    const transient = await runScenario({ brief: BRIEF, poll: POLL, failAt: { method: chainMethod, times: 1, kind: "transport" } });
    const retried = entriesFor(transient, sdkMethod);

    check(
      retried.length > 0,
      `${sdkMethod}: a failure was injected at ${chainMethod} but the transcripts record no ${sdkMethod} step at all, so the call was skipped silently`,
    );
    // The injected failure hits whichever agent calls first; a method both agents call will
    // also have an un-retried success from the other one, so look for the retried entry
    // specifically rather than for any success.
    const succeeded = retried.find((entry) => entry.status === "ok" && entry.detail?.includes("attempt"));
    check(
      retried.some((entry) => entry.status === "ok"),
      `${sdkMethod}: one transient failure at ${chainMethod} was not recovered; the policy says a 5xx is retried. Entries: ${JSON.stringify(retried)}`,
    );
    check(
      succeeded !== undefined,
      `${sdkMethod}: the step recovered but the transcript does not say it retried, so a flaky endpoint is invisible to an auditor. Entries: ${JSON.stringify(retried)}`,
    );
    check(
      transient.commissioner?.settled === true,
      `${sdkMethod}: a single transient failure at ${chainMethod} stopped the whole run (${transient.mandate?.state ?? "no mandate"})`,
    );

    // ── permanent: retries exhausted, the agent stops and says why ──────────
    const permanent = await runScenario({ brief: BRIEF, poll: POLL, failAt: { method: chainMethod, times: 99, kind: "transport" } });
    const stopped = entriesFor(permanent, sdkMethod);

    check(
      stopped.length > 0,
      `${sdkMethod}: a permanent failure at ${chainMethod} produced no transcript entry; the call was skipped`,
    );
    const last = stopped[stopped.length - 1];
    check(
      last?.status === "failed",
      `${sdkMethod}: after every attempt failed the step is recorded "${last?.status}", not "failed"`,
    );
    check(
      typeof last?.detail === "string" && last.detail.length > 0,
      `${sdkMethod}: the failure carries no reason, so an operator cannot tell what broke`,
    );
    check(
      last?.detail?.includes(chainMethod) === true,
      `${sdkMethod}: the reported reason (${JSON.stringify(last?.detail)}) does not name the failing call`,
    );
    check(
      !stopped.some((entry) => entry.status === "ok"),
      `${sdkMethod}: a step recorded ok although every attempt at ${chainMethod} failed`,
    );
    // The run must not claim success. Whichever agent owned the failing call must report
    // not-done, and the mandate must not be SETTLED.
    check(
      permanent.mandate?.state !== "SETTLED",
      `${sdkMethod}: the mandate reached SETTLED although ${chainMethod} never succeeded — this is the silent-skip failure the gate exists for`,
    );

    // ── refusal: deterministic, so never retried ────────────────────────────
    const refusedRun = await runScenario({ brief: BRIEF, poll: POLL, failAt: { method: chainMethod, times: 99, kind: "refusal" } });
    const refusedEntries = entriesFor(refusedRun, sdkMethod);

    check(
      refusedEntries.length > 0,
      `${sdkMethod}: a refusal at ${chainMethod} produced no transcript entry`,
    );
    const verdict = refusedEntries[refusedEntries.length - 1];
    check(
      verdict?.status === "refused",
      `${sdkMethod}: a contract refusal is recorded "${verdict?.status}"; "refused" and "failed" must stay distinguishable because only one of them is worth retrying`,
    );
    // One attempt only. A refusal retried three times is three transactions spent on a
    // call that could never land.
    const attempts = refusedRun.requests.filter((method) => method === chainMethod).length;
    // One attempt per agent that makes the call. Both agents register; only one of them
    // creates a DAO.
    const expectedAttempts = callers.get(sdkMethod) ?? 1;
    check(
      attempts <= expectedAttempts,
      `${sdkMethod}: a refusal at ${chainMethod} was attempted ${attempts} times; a deterministic refusal must not be retried`,
    );
    check(
      refusedRun.mandate?.state !== "SETTLED",
      `${sdkMethod}: the mandate settled although ${chainMethod} was refused`,
    );

    results.push({ sdkMethod, chainMethod, retriedOnAttempt: succeeded?.detail ?? "", attempts });
  }

  if (problems.length === 0) {
    console.log(
      `AGENTS-FAILURE-HANDLING OK ${results.length} call site(s) × 3 scenarios — a transient failure at each of ` +
        `${results.map((result) => result.chainMethod).join(", ")} was retried and the run still settled; a permanent failure ` +
        `stopped the agent with a named reason and no mandate reached SETTLED; a contract refusal was recorded refused and never retried`,
    );
  }
} catch (error) {
  problems.push(`a failure scenario threw outside an agent: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await stopAll();
}

if (problems.length > 0) fail("AGENTS-FAILURE-HANDLING", problems);
