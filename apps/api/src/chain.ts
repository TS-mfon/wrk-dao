/**
 * The write path. Writes go to chain, never to MongoDB (leaf-1.4.3:G3).
 *
 * This module deliberately does not import `Store`. That is the enforcement: a write
 * handler cannot touch the read model because the module it lives in has no way to.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The trust boundary, stated rather than buried
 * ──────────────────────────────────────────────────────────────────────────────
 * The Intelligent Contracts authorize on `gl.message.sender_address`, so the transaction
 * that creates a mission must be *sent* by that agent's operator. The API therefore needs
 * a signer for the agent it is acting for, and there are only two honest ways to get one:
 *
 *   **relay** (`WRK_WRITE_MODE=relay`) — the operator provisions its key into the API's
 *   keystore. The API signs and submits. This is real key custody: whoever runs the API
 *   can act as that agent. It is what makes an agent usable through a plain HTTP call, and
 *   it is appropriate for a testnet and for an agent operator running their own API.
 *
 *   **prepare** (`WRK_WRITE_MODE=prepare`, the default) — the API returns the exact
 *   calldata and target for the agent to sign and submit itself. No custody. The agent
 *   needs a GenLayer client, which is more to carry but keeps the key where it belongs.
 *
 * The mode is explicit because the difference is who can spend an agent's authority, and
 * a default that quietly took custody would be the wrong default.
 */

import { z } from "zod";

export type WriteMode = "relay" | "prepare";

export interface PreparedCall {
  readonly contract: "registry" | "work" | "adjudicator" | "reputation";
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface SubmittedWrite {
  readonly mode: WriteMode;
  /** Present in relay mode: the transaction the API submitted. */
  readonly tx_hash?: string;
  /** Present in prepare mode: what the agent must sign and send. */
  readonly prepared?: PreparedCall & { readonly address: string; readonly network: string };
}

export class ChainWriteFailed extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ChainWriteFailed";
  }
}

/**
 * The contract refused the call, deliberately.
 *
 * GenLayer's convention is that a `gl.vm.UserError` prefixed `[EXPECTED]` is a deterministic
 * refusal the contract author intended — a budget over the DAO's cap, a transition the
 * state machine does not have, a mandate whose workers are not the ones selected. It is
 * separate from `ChainWriteFailed` because the two deserve opposite advice: a failed write
 * might land on a retry, and a refusal never will. Collapsing them into one 502 tells every
 * client to retry a permanent refusal.
 */
export class ChainRefused extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ChainRefused";
  }
}

/** The marker GenVM puts on a deliberate, deterministic refusal. */
const REFUSAL_MARKER = "[EXPECTED]";

/**
 * Whether a writer's error was the contract refusing rather than the write failing.
 *
 * Reads the marker, and also an `expected` flag, so a writer that classifies for itself
 * does not have to round-trip through a string.
 */
export function isRefusal(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { expected?: unknown }).expected === true) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(REFUSAL_MARKER);
}

/** The addresses of the four ICs on one network. */
export const deploymentSchema = z
  .object({
    registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    work: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    adjudicator: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    reputation: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();

export type Deployment = z.infer<typeof deploymentSchema>;

/**
 * What the API needs in order to send a GenLayer transaction as a given operator.
 *
 * An interface rather than a concrete client so the write path can be driven in tests
 * without a chain, and so `relay` and `prepare` are the same code path up to the last step.
 */
export interface GenLayerWriter {
  /** Submits `call` as `operator` and returns the transaction hash. */
  send(input: {
    readonly network: string;
    readonly address: string;
    readonly operator: string;
    readonly call: PreparedCall;
  }): Promise<string>;

  /** Reads a view method. Used by the agent directory, which must read chain not Mongo. */
  view(input: {
    readonly network: string;
    readonly address: string;
    readonly method: string;
    readonly args: readonly unknown[];
  }): Promise<unknown>;
}

export interface WriterOptions {
  readonly mode: WriteMode;
  readonly deployments: Readonly<Record<string, Deployment>>;
  readonly writer: GenLayerWriter;
}

export class ChainWrites {
  constructor(private readonly options: WriterOptions) {}

  get mode(): WriteMode {
    return this.options.mode;
  }

  addressOf(network: string, contract: PreparedCall["contract"]): string {
    const deployment = this.options.deployments[network];
    if (!deployment) {
      throw new ChainWriteFailed(`no contract addresses are configured for ${network}`);
    }
    return deployment[contract];
  }

  /**
   * Executes or prepares one call.
   *
   * In `prepare` mode nothing is sent, which is why the response says so explicitly rather
   * than returning an empty `tx_hash` a caller might read as success.
   */
  async submit(input: {
    readonly network: string;
    readonly operator: string;
    readonly call: PreparedCall;
  }): Promise<SubmittedWrite> {
    const address = this.addressOf(input.network, input.call.contract);
    if (this.options.mode === "prepare") {
      return {
        mode: "prepare",
        prepared: { ...input.call, address, network: input.network },
      };
    }
    try {
      const txHash = await this.options.writer.send({
        network: input.network,
        address,
        operator: input.operator,
        call: input.call,
      });
      return { mode: "relay", tx_hash: txHash };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A refusal and a failure are not the same event and must not become the same
      // response: see `ChainRefused`.
      if (isRefusal(error)) throw new ChainRefused(detail);
      throw new ChainWriteFailed(detail);
    }
  }

  /** The registry-backed agent directory I7 depends on. Chain, never the database. */
  agentDirectory(): { agentOfAddress(network: string, address: string): Promise<string> } {
    const options = this.options;
    return {
      async agentOfAddress(network: string, address: string): Promise<string> {
        const deployment = options.deployments[network];
        if (!deployment) return "";
        const found = await options.writer.view({
          network,
          address: deployment.registry,
          method: "agent_of_address",
          args: [address],
        });
        return typeof found === "string" ? found : "";
      },
    };
  }
}
