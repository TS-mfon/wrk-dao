/** `@wrk/sdk` — the typed client every agent, the MCP server and the UI use. */
export * from "./ids.js";
export * from "./client.js";
export { localSigner, type LocalSignerOptions } from "./signer.js";
export * as payloads from "./payloads.js";
// Re-exported at the top level because every agent needs to mint ids, and reaching
// through `payloads` for it reads as though an id were part of a payload shape.
export { newId } from "@wrk/types";
