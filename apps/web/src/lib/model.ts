import { NETWORKS } from "./networks";

export const COLLECTIONS = [
  { slug: "agents", label: "Agents", singular: "Agent", idKey: "agent_id", description: "Registered identities, capabilities, and their controlling operator." },
  { slug: "daos", label: "DAOs", singular: "DAO", idKey: "dao_id", description: "Work organizations with explicit membership rules and a shared purpose." },
  { slug: "missions", label: "Missions", singular: "Mission", idKey: "mission_id", description: "Defined outcomes, acceptance criteria, budgets, and deadlines." },
  { slug: "proposals", label: "Proposals", singular: "Proposal", idKey: "proposal_id", description: "An agent’s approach to a mission, including its plan and requested budget." },
  { slug: "mandates", label: "Mandates", singular: "Mandate", idKey: "mandate_id", description: "The accepted agreement that binds workers, terms, criteria, and custody." },
  { slug: "deliverables", label: "Deliverables", singular: "Deliverable", idKey: "deliverable_id", description: "Submitted work linked to a mandate and the agent responsible for it." },
  { slug: "evidence", label: "Evidence", singular: "Evidence bundle", idKey: "evidence_id", description: "Content-addressed references that support assessment of the work." },
  { slug: "decisions", label: "Decisions", singular: "Decision", idKey: "decision_id", description: "GenLayer judgments, their finality state, and the release / refund split." },
  { slug: "settlements", label: "Settlements", singular: "Settlement", idKey: "settlement_id", description: "Base custody records, challenge windows, and executed distributions." },
  { slug: "reputation", label: "Reputation", singular: "Reputation record", idKey: "_id", description: "DAO-scoped history recorded after settlement; never an input to judgment." },
] as const;

export type Collection = (typeof COLLECTIONS)[number];
export type CollectionSlug = Collection["slug"];
export interface ChainRef { chain: number; tx_hash: string; block: number; log_index: number; block_hash?: string }
export interface ProtocolObject extends Record<string, unknown> { _id: string; chain_ref: ChainRef }
export interface Freshness { network: string; chain: number; indexed_block: number | null; stale: boolean }
export interface ObjectPage { network: string; freshness: Freshness; items: ProtocolObject[]; total: number; limit: number; offset: number }
export interface ObjectResult { network: string; freshness: Freshness; item: ProtocolObject }
export interface Health {
  freshness: Freshness;
  agents: number;
  daos: number;
  missions?: number;
  requests?: number;
  mandates?: number;
  proposals?: number;
  adjudications?: number;
  settlements_executed?: number;
  missions_open: number;
  mandates_in_flight: number;
  mandates_awaiting_settlement: number;
  settlements_posted: number;
  settlements_in_window?: number;
  settlements_overdue?: number;
  now_unix?: number;
  checkpoint?: { chain: number; indexed_block: number | null; observed_head: number | null; lag_blocks: number | null; observed_at_unix: number | null; block_hash: string | null };
  keeper?: { last_success_unix: number | null; stale_after_seconds: number; stale: boolean | null; source: string | null };
}
export interface SettlementWindows { network: string; now_unix: number; items: ProtocolObject[] }

export function collectionOf(slug: string): Collection | undefined {
  return COLLECTIONS.find((entry) => entry.slug === slug);
}

export function objectId(object: ProtocolObject, collection: Collection): string {
  return typeof object[collection.idKey] === "string" ? String(object[collection.idKey]) : object._id;
}

export function objectState(object: ProtocolObject, collection: Collection): { label: string; derived: boolean } {
  if (typeof object.state === "string") return { label: object.state, derived: false };
  const labels: Record<string, string> = {
    agents: "REGISTERED", daos: "REGISTERED", proposals: object.selected === true ? "SELECTED" : "SUBMITTED",
    deliverables: "SUBMITTED", evidence: "RECORDED", reputation: "SETTLEMENT RECORDED",
  };
  return { label: labels[collection.slug] ?? "UNKNOWN", derived: true };
}

export function objectPayload(object: ProtocolObject): Record<string, unknown> | null {
  const raw = object.payload ?? object.profile ?? object.metadata;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function objectTitle(object: ProtocolObject, collection: Collection): string {
  const payload = objectPayload(object);
  for (const value of [payload?.title, payload?.name, payload?.objective, payload?.proposed_strategy, object.evidence_type]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return collection.singular;
}

export function humanize(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function formatAtomic(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return "Unknown";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

export function formatInteger(value: number | undefined | null): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "Unknown";
}

export function formatUtc(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return "Not observed";
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "Unknown" : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function shortHash(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function chainName(chain: number): string {
  return NETWORKS.find((entry) => entry.chainId === chain)?.name ?? `Chain ${chain}`;
}

export function settlementClock(state: unknown, executableAt: unknown, nowUnix: number): { kind: "window" | "overdue" | "done" | "challenged" | "unknown"; label: string; seconds: number | null } {
  if (state === "EXECUTED") return { kind: "done", label: "Executed", seconds: null };
  if (state === "CHALLENGED") return { kind: "challenged", label: "Challenged · awaiting a valid post", seconds: null };
  if (state !== "POSTED" || typeof executableAt !== "number" || !Number.isSafeInteger(executableAt) || executableAt <= 0 || !Number.isFinite(nowUnix)) {
    return { kind: "unknown", label: "Challenge window unknown", seconds: null };
  }
  const seconds = executableAt - Math.floor(nowUnix);
  if (seconds <= 0) return { kind: "overdue", label: seconds === 0 ? "Window elapsed · awaiting execution" : `Overdue by ${duration(-seconds)}`, seconds };
  return { kind: "window", label: `${duration(seconds)} remaining`, seconds };
}

export function duration(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${days ? `${days}d ` : ""}${days || hours ? `${hours}h ` : ""}${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validObject(value: unknown, chainId: number): value is ProtocolObject {
  if (!isRecord(value) || typeof value._id !== "string" || !value._id) return false;
  const ref = value.chain_ref;
  return isRecord(ref) && ref.chain === chainId && typeof ref.tx_hash === "string" && /^0x[0-9a-f]{64}$/i.test(ref.tx_hash)
    && Number.isSafeInteger(ref.block) && Number(ref.block) >= 0 && Number.isSafeInteger(ref.log_index) && Number(ref.log_index) >= 0;
}
