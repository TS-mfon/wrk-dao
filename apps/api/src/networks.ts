/**
 * Network resolution.
 *
 * Every request names its network in the path. There is no default, and that is the point
 * (leaf-1.4.3:G6): the moment one API serves two chains, "which chain is this row from?"
 * becomes a correctness question, and an endpoint that defaults silently will render
 * Bradbury data under a Studionet heading. An unknown network is a 400, not a guess.
 */

import { CHAINS, type ChainName } from "@wrk/indexer";

export const NETWORK_NAMES = Object.keys(CHAINS) as ChainName[];

/** GenLayer networks, where the protocol's organizational and judgment state lives. */
export const GENLAYER_NETWORKS = NETWORK_NAMES.filter((name) => CHAINS[name].kind === "genlayer");

export interface ResolvedNetwork {
  readonly name: ChainName;
  readonly chainId: number;
  readonly kind: "evm" | "genlayer";
}

export class UnknownNetwork extends Error {
  constructor(readonly requested: string) {
    super(
      `unknown network ${JSON.stringify(requested)}; this API serves ${NETWORK_NAMES.join(", ")}`,
    );
    this.name = "UnknownNetwork";
  }
}

export function resolveNetwork(requested: string | undefined): ResolvedNetwork {
  if (!requested) throw new UnknownNetwork("");
  if (!NETWORK_NAMES.includes(requested as ChainName)) throw new UnknownNetwork(requested);
  const name = requested as ChainName;
  return { name, chainId: CHAINS[name].chainId, kind: CHAINS[name].kind };
}

/** Writes only make sense against a GenLayer network: that is where the ICs live. */
export function resolveWritableNetwork(requested: string | undefined): ResolvedNetwork {
  const resolved = resolveNetwork(requested);
  if (resolved.kind !== "genlayer") {
    throw new UnknownNetwork(
      `${resolved.name} is a settlement chain; protocol writes go to a GenLayer network`,
    );
  }
  return resolved;
}
