/**
 * The run transcript.
 *
 * leaf-1.6.4:G8 asks for a record naming every API call, its status, and the on-chain id
 * it affected — not a console log that says it worked. The difference matters: a demo
 * nobody can audit is a claim, and the whole point of these two agents is to show the
 * product is usable rather than to assert it.
 *
 * Entries are append-only and carry no wall-clock time, so two runs of the same scenario
 * produce comparable transcripts. `verify/reactive.mjs` compares two runs and requires
 * them to differ only where the inputs differed, which a timestamp would make impossible.
 */

export interface TranscriptEntry {
  readonly step: number;
  readonly agent: string;
  /** The SDK method, which is also the API endpoint it wraps. */
  readonly action: string;
  readonly status: "ok" | "refused" | "failed" | "skipped";
  /** The on-chain id this step affected, when it affected one. */
  readonly subject?: string;
  /** What the agent learned, when the step was a read that changed its plan. */
  readonly observed?: Record<string, unknown>;
  readonly detail?: string;
}

export class Transcript {
  private readonly entries: TranscriptEntry[] = [];

  constructor(readonly agent: string) {}

  record(entry: Omit<TranscriptEntry, "step" | "agent">): TranscriptEntry {
    const recorded = { step: this.entries.length + 1, agent: this.agent, ...entry };
    this.entries.push(recorded);
    return recorded;
  }

  get all(): readonly TranscriptEntry[] {
    return this.entries;
  }

  get failures(): readonly TranscriptEntry[] {
    return this.entries.filter((entry) => entry.status === "failed");
  }

  /** A stable, comparable rendering. No timestamps, so two runs can be diffed. */
  render(): string {
    return this.entries
      .map((entry) => {
        const subject = entry.subject ? ` ${entry.subject}` : "";
        const detail = entry.detail ? ` — ${entry.detail}` : "";
        return `${String(entry.step).padStart(2, "0")} ${entry.agent} ${entry.action} ${entry.status}${subject}${detail}`;
      })
      .join("\n");
  }

  toJSON(): readonly TranscriptEntry[] {
    return this.entries;
  }
}

/**
 * Runs one step, recording it either way.
 *
 * Every API error either stops the agent with a reported reason or is retried under a
 * stated policy (G7). A failed call is never silently skipped, because an agent that
 * swallows a 500 and carries on reports success for a mandate that was never funded.
 */
export async function step<T>(
  transcript: Transcript,
  action: string,
  options: {
    readonly subject?: string;
    /** Retries for a transport or 5xx failure. A 4xx is the agent's fault and is not retried. */
    readonly retries?: number;
    readonly onRetry?: (attempt: number, error: unknown) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  const retries = options.retries ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await run();
      transcript.record({
        action,
        status: "ok",
        ...(options.subject ? { subject: options.subject } : {}),
        ...(attempt > 0 ? { detail: `succeeded on attempt ${attempt + 1}` } : {}),
      });
      return result;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      // A 4xx says the request was wrong; repeating it cannot help and would be a loop.
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt === retries) break;
      options.onRetry?.(attempt + 1, error);
    }
  }

  const status = (lastError as { status?: number }).status;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  transcript.record({
    action,
    status: status !== undefined && status < 500 ? "refused" : "failed",
    ...(options.subject ? { subject: options.subject } : {}),
    detail: message,
  });
  throw lastError;
}
