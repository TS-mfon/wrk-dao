import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const routesPath = join(root, ".next", "server", "app-paths-manifest.json");
const standaloneServer = join(root, ".next", "standalone", "apps", "web", "server.js");
const actionManifestPath = join(root, ".next", "server", "server-reference-manifest.json");

for (const path of [routesPath, standaloneServer, actionManifestPath]) {
  if (!existsSync(path)) throw new Error(`Frontend build output is incomplete: ${path}`);
}

const routes = JSON.parse(readFileSync(routesPath, "utf8"));
for (const route of ["/page", "/inspect/page", "/inspect/[collection]/page", "/inspect/[collection]/[id]/page", "/monitoring/page", "/docs/page", "/docs/api/page"]) {
  if (!(route in routes)) throw new Error(`Expected frontend route is missing from the build: ${route}`);
}

const actions = JSON.parse(readFileSync(actionManifestPath, "utf8"));
const serverActions = [actions.node, actions.edge].flatMap((runtime) => Object.keys(runtime ?? {}));
if (serverActions.length) throw new Error("The read-only frontend unexpectedly contains server actions.");

console.log("Frontend build output and read-only route set verified.");
