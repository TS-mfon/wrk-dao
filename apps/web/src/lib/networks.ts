export const NETWORKS = [
  { slug: "studionet", name: "Studionet", chainId: 61999, authority: "Organization & judgment", family: "GenLayer" },
  { slug: "bradbury", name: "Bradbury", chainId: 4221, authority: "Organization & judgment", family: "GenLayer" },
  { slug: "base-sepolia", name: "Base Sepolia", chainId: 84532, authority: "Custody & settlement", family: "Base" },
] as const;

export type Network = (typeof NETWORKS)[number];
export type NetworkSlug = Network["slug"];
export type SearchParams = Record<string, string | string[] | undefined>;

export function networkOf(value: string | undefined): Network {
  if (value === undefined) return NETWORKS[0];
  const network = NETWORKS.find((entry) => entry.slug === value);
  if (!network) throw new Error("Unknown network");
  return network;
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function withNetwork(path: string, network: NetworkSlug): string {
  const [pathname, anchor] = path.split("#");
  const separator = pathname!.includes("?") ? "&" : "?";
  return `${pathname}${separator}network=${network}${anchor ? `#${anchor}` : ""}`;
}

export function explorerTransaction(chain: number, tx: string): string | null {
  // Only publish an explorer URL whose path is known. GenLayer provenance stays fully
  // inspectable below without guessing a deployment-specific explorer origin.
  if (chain === 84532 && /^0x[0-9a-f]{64}$/i.test(tx)) return `https://sepolia.basescan.org/tx/${tx}`;
  return null;
}
