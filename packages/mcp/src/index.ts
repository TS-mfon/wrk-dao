import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WrkClient, localSigner, type Network } from "@wrk/sdk";

export interface McpOptions { baseUrl: string; network: Network; agentId?: string; privateKey?: string }

export function createWrkMcp(options: McpOptions): McpServer {
  const signer = options.agentId && options.privateKey
    ? localSigner({ agentId: options.agentId, privateKey: options.privateKey })
    : undefined;
  const client = new WrkClient({ baseUrl: options.baseUrl, network: options.network, ...(signer ? { signer } : {}) });
  const server = new McpServer({ name: "wrk-dao", version: "0.1.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

  server.registerTool("wrk_protocol", { description: "Read API metadata and the selected network's protocol health." }, async () => result({ meta: await client.meta(), health: await client.health() }));
  server.registerTool("wrk_discover_work", { description: "Find open missions available for proposals on this network.", inputSchema: { dao_id: z.string().optional() } }, async ({ dao_id }) => result(await client.openMissions(dao_id)));
  server.registerTool("wrk_list_records", { description: "List indexed protocol records from a named collection.", inputSchema: { collection: z.enum(["agents", "daos", "memberships", "missions", "proposals", "mandates", "deliverables", "evidence", "decisions", "settlements", "payments", "reputation"]), limit: z.number().int().min(1).max(100).optional() } }, async ({ collection, limit }) => result(await client.list(collection, { limit: limit ?? 25 })));
  server.registerTool("wrk_inspect_reference", { description: "Find a record by transaction hash or request/object ID.", inputSchema: { reference: z.string().min(1).max(128) } }, async ({ reference }) => result(await client.lookup(reference)));
  server.registerTool("wrk_register_agent", { description: "Register this configured agent identity on the selected GenLayer network. Requires WRK_AGENT_ID and WRK_PRIVATE_KEY locally.", inputSchema: { profile: z.record(z.string(), z.unknown()) } }, async ({ profile }) => {
    if (!signer) throw new Error("Configure WRK_AGENT_ID and WRK_PRIVATE_KEY in the MCP host environment; never send private keys as tool arguments.");
    return result(await client.registerAgent({ agentId: signer.agentId, profile }));
  });
  server.registerTool("wrk_create_dao", { description: "Create a DAO for the configured agent. This is an authenticated on-chain write request.", inputSchema: { dao_id: z.string(), metadata: z.record(z.string(), z.unknown()), rules: z.record(z.string(), z.unknown()) } }, async ({ dao_id, metadata, rules }) => {
    if (!signer) throw new Error("This write requires WRK_AGENT_ID and WRK_PRIVATE_KEY configured in the MCP host.");
    return result(await client.createDao({ daoId: dao_id, creatorAgentId: signer.agentId, metadata, rules }));
  });
  server.registerTool("wrk_create_mission", { description: "Create a work request in a DAO for the configured agent.", inputSchema: { mission_id: z.string(), dao_id: z.string(), payload: z.record(z.string(), z.unknown()) } }, async ({ mission_id, dao_id, payload }) => {
    if (!signer) throw new Error("This write requires WRK_AGENT_ID and WRK_PRIVATE_KEY configured in the MCP host.");
    return result(await client.createMission({ missionId: mission_id, daoId: dao_id, creatorAgentId: signer.agentId, payload }));
  });
  server.registerTool("wrk_submit_proposal", { description: "Submit a proposal to an open work request as the configured agent.", inputSchema: { proposal_id: z.string(), mission_id: z.string(), payload: z.record(z.string(), z.unknown()) } }, async ({ proposal_id, mission_id, payload }) => {
    if (!signer) throw new Error("This write requires WRK_AGENT_ID and WRK_PRIVATE_KEY configured in the MCP host.");
    return result(await client.submitProposal({ proposalId: proposal_id, missionId: mission_id, agentId: signer.agentId, payload }));
  });
  server.registerTool("wrk_submit_deliverable", { description: "Submit a deliverable for a mandate as the configured worker agent.", inputSchema: { deliverable_id: z.string(), mandate_id: z.string(), payload: z.record(z.string(), z.unknown()) } }, async ({ deliverable_id, mandate_id, payload }) => {
    if (!signer) throw new Error("This write requires WRK_AGENT_ID and WRK_PRIVATE_KEY configured in the MCP host.");
    return result(await client.submitDeliverable({ deliverableId: deliverable_id, mandateId: mandate_id, agentId: signer.agentId, payload }));
  });
  return server;
}
