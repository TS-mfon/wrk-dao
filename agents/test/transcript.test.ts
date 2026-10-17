/**
 * Unit tests for the retry policy and the transcript.
 *
 * `verify/failure-handling.mjs` proves the policy holds for all thirteen call sites through
 * a whole protocol, which is the claim that matters. These tests pin the decision itself:
 * which status codes are retried, how many times, and what gets recorded either way. The
 * gate would catch a change to the policy's effect; these say what the policy IS, so a
 * future edit that makes 4xx retryable fails here with the reason rather than failing a
 * 39-scenario gate somewhere further out.
 */

import { describe, expect, it } from "vitest";
import { Transcript, step } from "../src/transcript.js";

/** An error carrying an HTTP status, as `SdkError` does. */
const withStatus = (status: number, message = `status ${status}`) =>
  Object.assign(new Error(message), { status });

describe("the transcript", () => {
  it("numbers entries contiguously from 1 and is append-only", () => {
    const transcript = new Transcript("agent:test");
    transcript.record({ action: "a", status: "ok" });
    transcript.record({ action: "b", status: "ok" });
    transcript.record({ action: "c", status: "failed", detail: "why" });

    expect(transcript.all.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(transcript.all.every((entry) => entry.agent === "agent:test")).toBe(true);
  });

  it("renders one line per entry with no wall-clock time, so two runs can be diffed", () => {
    const transcript = new Transcript("agent:test");
    transcript.record({ action: "createMission", status: "ok", subject: "msn_01JQ8Z000000000000000000M1" });
    transcript.record({ action: "openMission", status: "refused", subject: "msn_01JQ8Z000000000000000000M1", detail: "already open" });

    const rendered = transcript.render();
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).toContain("msn_01JQ8Z000000000000000000M1");
    expect(rendered).toContain("already open");
    // A ten-digit run of digits is what a unix timestamp looks like.
    expect(rendered).not.toMatch(/\b\d{10,}\b/);
  });

  it("collects only the failures", () => {
    const transcript = new Transcript("agent:test");
    transcript.record({ action: "a", status: "ok" });
    transcript.record({ action: "b", status: "refused", detail: "4xx" });
    transcript.record({ action: "c", status: "failed", detail: "5xx" });
    transcript.record({ action: "d", status: "skipped", detail: "already done" });

    // A refusal is not a failure: the request was answered, and the answer was no.
    expect(transcript.failures.map((entry) => entry.action)).toEqual(["c"]);
  });

  it("round-trips through JSON", () => {
    const transcript = new Transcript("agent:test");
    transcript.record({ action: "a", status: "ok", observed: { state: "OPEN" } });
    expect(JSON.parse(JSON.stringify(transcript))).toEqual([
      { step: 1, agent: "agent:test", action: "a", status: "ok", observed: { state: "OPEN" } },
    ]);
  });
});

describe("the retry policy", () => {
  it("records a success and returns its value", async () => {
    const transcript = new Transcript("agent:test");
    const result = await step(transcript, "readAgent", { subject: "agt_01JQ8Z000000000000000000A1" }, async () => 42);

    expect(result).toBe(42);
    expect(transcript.all).toHaveLength(1);
    expect(transcript.all[0]).toMatchObject({ action: "readAgent", status: "ok", subject: "agt_01JQ8Z000000000000000000A1" });
    // No "succeeded on attempt" noise when nothing was retried, so a retry is visible.
    expect(transcript.all[0].detail).toBeUndefined();
  });

  it("retries a 5xx and says which attempt succeeded", async () => {
    const transcript = new Transcript("agent:test");
    let calls = 0;
    const result = await step(transcript, "createMission", { retries: 2 }, async () => {
      calls += 1;
      if (calls < 3) throw withStatus(503, "upstream_failed");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(transcript.all).toHaveLength(1);
    expect(transcript.all[0].status).toBe("ok");
    expect(transcript.all[0].detail).toBe("succeeded on attempt 3");
  });

  it("retries a transport failure that carries no status", async () => {
    const transcript = new Transcript("agent:test");
    let calls = 0;
    await step(transcript, "createDao", { retries: 1 }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return "ok";
    });
    expect(calls).toBe(2);
  });

  it("does NOT retry a 4xx, because repeating a refused request cannot help", async () => {
    const transcript = new Transcript("agent:test");
    let calls = 0;
    await expect(
      step(transcript, "createMission", { retries: 5 }, async () => {
        calls += 1;
        throw withStatus(422, "[EXPECTED] budget exceeds the DAO's cap");
      }),
    ).rejects.toThrow(/budget exceeds/);

    // One attempt. In relay mode each attempt is a transaction, so retrying a
    // deterministic refusal spends money on a call that can never land.
    expect(calls).toBe(1);
    expect(transcript.all).toHaveLength(1);
    expect(transcript.all[0].status).toBe("refused");
    expect(transcript.all[0].detail).toContain("budget exceeds the DAO's cap");
  });

  it.each([400, 403, 404, 409, 422])("treats %i as refused rather than failed", async (status) => {
    const transcript = new Transcript("agent:test");
    await expect(
      step(transcript, "write", { retries: 3 }, async () => { throw withStatus(status); }),
    ).rejects.toThrow();
    expect(transcript.all[0].status).toBe("refused");
  });

  it.each([500, 502, 503, 504])("treats %i as failed after exhausting retries", async (status) => {
    const transcript = new Transcript("agent:test");
    let calls = 0;
    await expect(
      step(transcript, "write", { retries: 2 }, async () => { calls += 1; throw withStatus(status); }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
    expect(transcript.all[0].status).toBe("failed");
  });

  it("records a failure with its reason and rethrows, never swallowing it", async () => {
    const transcript = new Transcript("agent:test");
    await expect(
      step(transcript, "submitWork", { subject: "mnd_01JQ8Z000000000000000000N1", retries: 1 }, async () => {
        throw withStatus(500, "the indexer is behind");
      }),
    ).rejects.toThrow("the indexer is behind");

    // Rethrowing is the load-bearing part: an agent that swallowed this would carry on and
    // report success for work that was never submitted.
    expect(transcript.all).toHaveLength(1);
    expect(transcript.all[0]).toMatchObject({
      action: "submitWork",
      status: "failed",
      subject: "mnd_01JQ8Z000000000000000000N1",
      detail: "the indexer is behind",
    });
  });

  it("reports each retry as it happens", async () => {
    const transcript = new Transcript("agent:test");
    const seen: number[] = [];
    let calls = 0;
    await step(transcript, "write", { retries: 3, onRetry: (attempt) => seen.push(attempt) }, async () => {
      calls += 1;
      if (calls < 3) throw withStatus(503);
      return "ok";
    });
    expect(seen).toEqual([1, 2]);
  });

  it("does not retry at all when no retry budget is given", async () => {
    const transcript = new Transcript("agent:test");
    let calls = 0;
    await expect(
      step(transcript, "read", {}, async () => { calls += 1; throw withStatus(503); }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
