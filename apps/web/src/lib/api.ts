import { isRecord, validObject, type CollectionSlug, type Freshness, type Health, type ObjectPage, type ObjectResult, type SettlementWindows } from "./model";
import type { Network } from "./networks";

export type ReadResult<T> = { ok: true; data: T; observedAt: number } | { ok: false; reason: "unavailable" | "invalid" | "not-found"; message: string };

function validFreshness(value: unknown, network: Network): value is Freshness {
  return isRecord(value) && value.network === network.slug && value.chain === network.chainId && typeof value.stale === "boolean"
    && (value.indexed_block === null || (Number.isSafeInteger(value.indexed_block) && Number(value.indexed_block) >= 0));
}

async function read<T>(network: Network, path: string, validate: (value: unknown) => boolean): Promise<ReadResult<T>> {
  try {
    const configured = process.env.WRK_API_URL;
    if (!configured && process.env.NODE_ENV === "production") {
      return { ok: false, reason: "unavailable", message: "The protocol API has not been connected to this deployment." };
    }
    const origin = configured ?? "http://127.0.0.1:3000";
    const url = new URL(`${origin.replace(/\/+$/, "")}/v1/${network.slug}/${path}`);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid API origin");
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6500),
    });
    if (response.status === 404) return { ok: false, reason: "not-found", message: "This record is not present in the selected network’s read model." };
    if (!response.ok) return { ok: false, reason: "unavailable", message: `The protocol API returned HTTP ${response.status}. Current state cannot be verified.` };
    const payload: unknown = await response.json();
    if (!validate(payload)) return { ok: false, reason: "invalid", message: "The API response is incomplete or belongs to a different chain. It cannot be displayed as this network’s state." };
    return { ok: true, data: payload as T, observedAt: Math.floor(Date.now() / 1000) };
  } catch {
    return { ok: false, reason: "unavailable", message: "The protocol API could not be reached. Current state cannot be verified." };
  }
}

export function readHealth(network: Network): Promise<ReadResult<Health>> {
  return read(network, "health", (value) => isRecord(value) && validFreshness(value.freshness, network)
    && ["agents", "daos", "missions_open", "mandates_in_flight", "mandates_awaiting_settlement", "settlements_posted"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0));
}

export function readObjects(network: Network, collection: CollectionSlug, offset = 0): Promise<ReadResult<ObjectPage>> {
  return read(network, `${collection}?limit=25&offset=${Math.max(0, offset)}`, (value) => isRecord(value) && value.network === network.slug
    && validFreshness(value.freshness, network) && Array.isArray(value.items) && value.items.every((item) => validObject(item, network.chainId))
    && Number.isSafeInteger(value.total) && Number(value.total) >= 0 && Number.isSafeInteger(value.limit) && Number(value.limit) > 0
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0);
}

export function readObject(network: Network, collection: CollectionSlug, id: string): Promise<ReadResult<ObjectResult>> {
  return read(network, `${collection}/${encodeURIComponent(id)}`, (value) => isRecord(value) && value.network === network.slug
    && validFreshness(value.freshness, network) && validObject(value.item, network.chainId));
}

export function readWindows(network: Network): Promise<ReadResult<SettlementWindows>> {
  return read(network, "settlement-windows", (value) => isRecord(value) && value.network === network.slug
    && Number.isSafeInteger(value.now_unix) && Number(value.now_unix) > 0 && Array.isArray(value.items) && value.items.every((item) => validObject(item, network.chainId)));
}

export interface LookupResult { network: string; freshness: Freshness; reference: string; items: Array<{ collection: CollectionSlug; item: import("./model").ProtocolObject }> }

export function readLookup(network: Network, reference: string): Promise<ReadResult<LookupResult>> {
  return read(network, `lookup/${encodeURIComponent(reference)}`, (value) => isRecord(value) && value.network === network.slug
    && validFreshness(value.freshness, network) && value.reference === reference && Array.isArray(value.items)
    && value.items.every((entry) => isRecord(entry) && typeof entry.collection === "string" && validObject(entry.item, network.chainId)));
}
