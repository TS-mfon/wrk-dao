// leaf-1.6.4:G5 — neither agent can bypass the API.
//
//   node scripts/verify-agents-api-only.mjs
//
// Success prints exactly one line: AGENTS-API-ONLY OK <n> file(s), <m> control(s) tripped
//
// What this enforces, and why
// ---------------------------
// The two agents exist to show the public API is *sufficient* — that an agent with nothing
// but an HTTP endpoint and its own signing key can participate. An agent that read MongoDB
// directly, or signed a GenLayer or Base transaction itself, would show something much
// weaker: that a privileged script can drive the contracts. `tests/e2e` already covers
// that, and it is not the claim leaf-1.6.4 makes.
//
// So this walks every import in `agents/src`, every dependency the package declares, and
// the transitive import surface of the one package it is allowed to use, and refuses:
//
//   - any module specifier that is not a relative path or `@wrk/sdk`
//   - any database client, chain transport, or key-derivation import
//   - a private key written into the source, or read from the environment
//
// `@wrk/sdk` is permitted because it is what signs API requests: an EIP-191 signature over
// the request envelope. It is not a chain client, and this checker proves that rather than
// assuming it — if the SDK ever grows a transport, this gate fails and the agents' claim
// has to be re-argued.
//
// This is an absence assertion, which is the kind most likely to pass because it never
// looked. It therefore runs against four fixture agents that each do something forbidden,
// and fails if any of them is not caught.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");

/** Packages that would let an agent reach past the API, and what each one would mean. */
const FORBIDDEN_PACKAGES = new Map([
  ["mongodb", "a database client: the agent would read the read model directly instead of through the API"],
  ["mongoose", "a database client: see mongodb"],
  ["mongodb-memory-server", "a database server: an agent does not provision storage"],
  ["pg", "a database client: the agent would read a database directly"],
  ["redis", "a cache client: state an agent holds outside the API is state the API cannot be held to"],
  ["ioredis", "a cache client: see redis"],
  ["ethers", "a chain client: the agent would sign and send its own transactions"],
  ["web3", "a chain client: see ethers"],
  ["@genlayer/js", "a GenLayer client: the agent would call the contracts directly, bypassing the API's authorization"],
  ["genlayer-js", "a GenLayer client: see @genlayer/js"],
  ["@wrk/indexer", "the indexer: an agent that indexes is not a participant, it is infrastructure"],
  ["@wrk/api", "the API's own internals: an agent must be a client of the API, not a part of it"],
  ["@wrk/settlement", "the settlement keeper: an agent that can settle does not need an adjudicator"],
]);

/**
 * Identifiers that mean a chain transport or a key, wherever they appear.
 *
 * Matched as source text rather than as imports, because `viem` reaches the agents
 * transitively through the SDK: an agent could in principle write
 * `createWalletClient` without importing anything new.
 */
const FORBIDDEN_IDENTIFIERS = [
  [/\bcreateWalletClient\b/, "a wallet client writes transactions; writes belong to the API"],
  [/\bcreatePublicClient\b/, "a public client reads chain state; reads belong to the API's read model"],
  [/\bwriteContract\b/, "a direct contract write bypasses every check the API makes"],
  [/\bsendTransaction\b/, "an agent that sends its own transactions is not using the product"],
  [/\breadContract\b/, "a direct contract read bypasses the read model the product serves"],
  [/\bprivateKeyToAccount\b/, "deriving an account from a key means the agent holds one"],
  [/\bgeneratePrivateKey\b/, "an agent that mints keys can mint identities"],
  [/\bfrom\s+["']viem\/chains["']/, "chain definitions are only needed by something that talks to a chain"],
  [/\bMongoClient\b/, "a database handle"],
  [/\bprocess\.env\.PRIVATE_KEY\b/, "a key read from the environment is still a key the agent holds"],
  [/\bprocess\.env\.[A-Z_]*SECRET\b/, "a secret read from the environment"],
  [/\bprocess\.env\.MONGODB_URI\b/, "a database URI: the agent would connect to storage"],
  [/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/, "a 32-byte hex literal, which is the shape of a private key"],
];

/** Specifiers an agent may import. Everything else is a finding. */
const ALLOWED_SPECIFIERS = new Set(["@wrk/sdk"]);

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s+(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function sourceFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(path);
        continue;
      }
      if (/\.(ts|mts|js|mjs)$/.test(entry)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

function specifiersIn(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

/**
 * Audits one agent source tree.
 *
 * Returns a list of problems. Empty means every module the tree reaches is either its own
 * code or the SDK, and nothing in it names a transport or a key.
 */
function audit(dir, { label, packageJson, allowed = ALLOWED_SPECIFIERS } = {}) {
  const problems = [];
  const files = sourceFiles(dir);
  if (files.length === 0) problems.push(`${label}: no source files found, so this proves nothing`);

  for (const file of files) {
    const where = relative(dir, file);
    const source = readFileSync(file, "utf8");

    for (const specifier of specifiersIn(source)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
      if (allowed.has(specifier)) continue;

      // A bare node builtin is fine for an agent (timers, assert); a node builtin that
      // reaches storage or the network is not — those are how an agent bypasses the API.
      if (specifier.startsWith("node:")) {
        const builtin = specifier.slice(5).split("/")[0];
        if (["net", "http", "https", "http2", "dgram", "tls", "child_process", "worker_threads"].includes(builtin)) {
          problems.push(`${where}: imports node:${builtin}, which is a transport the API does not mediate`);
        }
        continue;
      }

      const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const reason = FORBIDDEN_PACKAGES.get(base);
      problems.push(
        reason
          ? `${where}: imports ${specifier} — ${reason}`
          : `${where}: imports ${specifier}, which is not the API client; an agent may use @wrk/sdk and its own modules only`,
      );
    }

    for (const [pattern, reason] of FORBIDDEN_IDENTIFIERS) {
      const match = pattern.exec(source);
      if (match) problems.push(`${where}: contains ${JSON.stringify(match[0].slice(0, 24))} — ${reason}`);
    }
  }

  if (packageJson) {
    const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const dependency of declared) {
      if (allowed.has(dependency)) continue;
      const reason = FORBIDDEN_PACKAGES.get(dependency);
      problems.push(
        reason
          ? `package.json: depends on ${dependency} — ${reason}`
          : `package.json: depends on ${dependency}; a runtime dependency other than @wrk/sdk widens what the agents can reach`,
      );
    }
    if (declared.length === 0) {
      problems.push("package.json: declares no runtime dependency, so the agents cannot be using the SDK");
    }
  }

  return { problems, files };
}

// ── the positive controls ───────────────────────────────────────────────────
//
// Each of these is an agent that cheats in a different way. A checker that does not catch
// all four has not demonstrated it can catch anything.

const CONTROLS = [
  {
    name: "reads the database directly",
    source: `import { MongoClient } from "mongodb";
export async function run() {
  const client = new MongoClient("mongodb://localhost:27017");
  return client.db("wrk").collection("missions").find({}).toArray();
}
`,
    expect: /imports mongodb/,
  },
  {
    name: "signs its own chain transaction",
    source: `import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
export const wallet = createWalletClient({ chain: baseSepolia, transport: http("https://rpc.example") });
`,
    expect: /createWalletClient|viem\/chains/,
  },
  {
    name: "holds a hardcoded private key",
    source: `export const KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
export function sign() { return KEY; }
`,
    expect: /hex literal/,
  },
  {
    name: "takes a key from the environment",
    source: `export function key() { return process.env.PRIVATE_KEY; }
`,
    expect: /PRIVATE_KEY/,
  },
];

let tripped = 0;
const fixtureRoot = mkdtempSync(join(tmpdir(), "wrk-api-only-"));
try {
  for (const control of CONTROLS) {
    const dir = mkdtempSync(join(fixtureRoot, "ctl-"));
    writeFileSync(join(dir, "agent.ts"), control.source);
    const { problems } = audit(dir, { label: control.name });
    if (!problems.some((problem) => control.expect.test(problem))) {
      console.error(`AGENTS-API-ONLY FAILED: the checker did not catch the control "${control.name}"`);
      console.error(`  expected a problem matching ${control.expect}`);
      console.error(`  got: ${problems.length ? problems.join("; ") : "(no problems at all)"}`);
      process.exit(1);
    }
    tripped += 1;
  }

  // A control that must PASS, so the checker is not simply rejecting every file.
  const clean = mkdtempSync(join(fixtureRoot, "ok-"));
  writeFileSync(
    join(clean, "agent.ts"),
    `import { payloads, type WrkClient } from "@wrk/sdk";
import { helper } from "./helper.js";
export async function run(client: WrkClient) { return helper(await client.openMissions(), payloads); }
`,
  );
  writeFileSync(join(clean, "helper.ts"), `export const helper = (page: unknown, _p: unknown) => page;\n`);
  const { problems: cleanProblems } = audit(clean, { label: "a well-behaved agent" });
  if (cleanProblems.length > 0) {
    console.error("AGENTS-API-ONLY FAILED: the checker rejected a well-behaved control");
    for (const problem of cleanProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// ── the real agents ─────────────────────────────────────────────────────────

const problems = [];
const { problems: agentProblems, files } = audit(resolve(ROOT, "agents/src"), {
  label: "agents/src",
  packageJson: resolve(ROOT, "agents/package.json"),
});
problems.push(...agentProblems);

// The one package the agents may use has to be what it claims: a request signer, not a
// chain client. If the SDK ever grows a transport this fails, which is the point — the
// agents' "API only" claim rests on it.
const sdkFiles = sourceFiles(resolve(ROOT, "packages/sdk/src"));
const sdkSpecifiers = new Set();
for (const file of sdkFiles) for (const specifier of specifiersIn(readFileSync(file, "utf8"))) sdkSpecifiers.add(specifier);
for (const specifier of sdkSpecifiers) {
  const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (FORBIDDEN_PACKAGES.has(base)) {
    problems.push(`packages/sdk/src: imports ${specifier} — ${FORBIDDEN_PACKAGES.get(base)}, so "@wrk/sdk only" no longer bounds the agents`);
  }
  if (specifier === "viem" || (specifier.startsWith("viem/") && specifier !== "viem/accounts")) {
    problems.push(
      `packages/sdk/src: imports ${specifier}; the SDK may use viem/accounts to sign a request envelope, but a broader viem import is a chain transport`,
    );
  }
}

if (problems.length > 0) {
  console.error(`AGENTS-API-ONLY FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `AGENTS-API-ONLY OK ${files.length} file(s), ${CONTROLS.length} control(s) tripped — the agents reach @wrk/sdk and their own modules only, and the SDK signs requests without a chain or database transport`,
);
