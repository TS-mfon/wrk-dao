/**
 * The write endpoint table.
 *
 * Declared as data rather than as a pile of route handlers so that the properties the
 * gates care about can be checked over the whole set instead of per route:
 *
 *   * G2 — every write has a Zod schema;
 *   * G3 — every write produces a chain call, and this module imports no Store;
 *   * G4 — every write authenticates, and `actsFor` names the agent whose authority the
 *     call uses, so I7 is checked on all of them rather than on a sample;
 *   * G7 — nothing here touches money or reputation. `wrk_reputation.record_outcome` is
 *     deliberately absent: it is permissionless on chain and belongs to the keeper, and an
 *     API endpoint for it would be a way to write standing through this surface.
 */

import { z } from "zod";
import type { PreparedCall } from "./chain.js";

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$`), {
    message: `must be a ${prefix}_ prefixed ULID`,
  });

const jsonPayload = z.string().min(2).max(60_000);

export interface WriteEndpoint<S extends z.ZodType = z.ZodType> {
  readonly method: "POST";
  /** Path after `/v1/:network`. */
  readonly path: string;
  readonly schema: S;
  /**
   * Which agent's authority this call uses, read out of the validated body.
   *
   * Every write names one. A write that could not say whose authority it uses could not
   * be checked against I7, which is why this is required rather than optional.
   */
  readonly actsFor: (body: z.infer<S>) => string;
  readonly call: (body: z.infer<S>) => PreparedCall;
}

const endpoint = <S extends z.ZodType>(spec: WriteEndpoint<S>): WriteEndpoint => spec as WriteEndpoint;

export const WRITE_ENDPOINTS: readonly WriteEndpoint[] = [
  endpoint({
    method: "POST",
    path: "/agents",
    schema: z.object({ agent_id: id("agt"), profile: jsonPayload }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "registry", method: "register_agent", args: [body.agent_id, body.profile] }),
  }),
  endpoint({
    method: "POST",
    path: "/agents/:agentId/profile",
    schema: z.object({ agent_id: id("agt"), profile: jsonPayload }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "registry", method: "update_agent_profile", args: [body.agent_id, body.profile] }),
  }),
  endpoint({
    method: "POST",
    path: "/daos",
    schema: z
      .object({ dao_id: id("dao"), creator_agent_id: id("agt"), metadata: jsonPayload, rules: jsonPayload })
      .strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({
      contract: "registry",
      method: "create_dao",
      args: [body.dao_id, body.creator_agent_id, body.metadata, body.rules],
    }),
  }),
  endpoint({
    method: "POST",
    path: "/daos/:daoId/rules",
    schema: z.object({ dao_id: id("dao"), creator_agent_id: id("agt"), rules: jsonPayload }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "registry", method: "update_dao_rules", args: [body.dao_id, body.rules] }),
  }),
  endpoint({
    method: "POST",
    path: "/daos/:daoId/members",
    schema: z.object({ dao_id: id("dao"), agent_id: id("agt") }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "registry", method: "join_dao", args: [body.dao_id, body.agent_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/daos/:daoId/invites",
    schema: z.object({ dao_id: id("dao"), creator_agent_id: id("agt"), agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "registry", method: "invite_agent", args: [body.dao_id, body.agent_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/missions",
    schema: z
      .object({ mission_id: id("msn"), dao_id: id("dao"), creator_agent_id: id("agt"), payload: jsonPayload })
      .strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({
      contract: "work",
      method: "create_mission",
      args: [body.mission_id, body.dao_id, body.creator_agent_id, body.payload],
    }),
  }),
  endpoint({
    method: "POST",
    path: "/missions/:missionId/update",
    schema: z.object({ mission_id: id("msn"), creator_agent_id: id("agt"), payload: jsonPayload }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "update_mission", args: [body.mission_id, body.payload] }),
  }),
  endpoint({
    method: "POST",
    path: "/missions/:missionId/open",
    schema: z.object({ mission_id: id("msn"), creator_agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "open_mission", args: [body.mission_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/missions/:missionId/close-proposals",
    schema: z.object({ mission_id: id("msn"), creator_agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "close_proposals", args: [body.mission_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/missions/:missionId/start-selection",
    schema: z.object({ mission_id: id("msn"), creator_agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "start_selection", args: [body.mission_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/missions/:missionId/cancel",
    schema: z.object({ mission_id: id("msn"), creator_agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "cancel_mission", args: [body.mission_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/proposals",
    schema: z
      .object({ proposal_id: id("prp"), mission_id: id("msn"), agent_id: id("agt"), payload: jsonPayload })
      .strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({
      contract: "work",
      method: "submit_proposal",
      args: [body.proposal_id, body.mission_id, body.agent_id, body.payload],
    }),
  }),
  endpoint({
    method: "POST",
    path: "/mandates",
    schema: z
      .object({ mandate_id: id("mnd"), mission_id: id("msn"), creator_agent_id: id("agt"), payload: jsonPayload })
      .strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({
      contract: "work",
      method: "create_mandate",
      args: [body.mandate_id, body.mission_id, body.payload],
    }),
  }),
  endpoint({
    method: "POST",
    path: "/mandates/:mandateId/accept",
    schema: z.object({ mandate_id: id("mnd"), agent_id: id("agt") }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "work", method: "accept_mandate", args: [body.mandate_id, body.agent_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/mandates/:mandateId/start-work",
    schema: z.object({ mandate_id: id("mnd"), agent_id: id("agt") }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "work", method: "start_work", args: [body.mandate_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/deliverables",
    schema: z
      .object({ deliverable_id: id("dlv"), mandate_id: id("mnd"), agent_id: id("agt"), payload: jsonPayload })
      .strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({
      contract: "work",
      method: "submit_deliverable",
      args: [body.deliverable_id, body.mandate_id, body.agent_id, body.payload],
    }),
  }),
  endpoint({
    method: "POST",
    path: "/mandates/:mandateId/submit-work",
    schema: z.object({ mandate_id: id("mnd"), agent_id: id("agt") }).strict(),
    actsFor: (body) => body.agent_id,
    call: (body) => ({ contract: "work", method: "submit_work", args: [body.mandate_id] }),
  }),
  endpoint({
    method: "POST",
    path: "/mandates/:mandateId/cancel",
    schema: z.object({ mandate_id: id("mnd"), creator_agent_id: id("agt") }).strict(),
    actsFor: (body) => body.creator_agent_id,
    call: (body) => ({ contract: "work", method: "cancel_mandate", args: [body.mandate_id] }),
  }),
];

/** Paths that must never exist on this API (G7), with why. */
export const FORBIDDEN_WRITE_PATHS: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "/settlements", reason: "the escrow on Base is the custody authority; the API cannot post a settlement" },
  { path: "/settlements/:id/execute", reason: "execution is the keeper's job against chain, not an API call" },
  { path: "/reputation", reason: "reputation is written only after final settlement, by the keeper" },
  { path: "/mandates/:mandateId/fund", reason: "funding moves USDC and belongs to the DAO's own wallet" },
  { path: "/mandates/:mandateId/settle", reason: "settlement is relayed from Base by the observer, not requested" },
  { path: "/decisions", reason: "judgment is the adjudicator's; an API that could post one would bypass consensus" },
];
