#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWrkMcp } from "./index.js";

const baseUrl = process.env.WRK_API_URL;
const network = process.env.WRK_NETWORK;
if (!baseUrl) throw new Error("Set WRK_API_URL to the WRK protocol API origin.");
if (!network || !["studionet", "bradbury", "base-sepolia"].includes(network)) throw new Error("Set WRK_NETWORK to studionet, bradbury, or base-sepolia.");
const server = createWrkMcp({ baseUrl, network: network as "studionet" | "bradbury" | "base-sepolia", ...(process.env.WRK_AGENT_ID ? { agentId: process.env.WRK_AGENT_ID } : {}), ...(process.env.WRK_PRIVATE_KEY ? { privateKey: process.env.WRK_PRIVATE_KEY } : {}) });
await server.connect(new StdioServerTransport());
