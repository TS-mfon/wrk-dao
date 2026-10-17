import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient, chains } from "genlayer-js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const contractRoot = join(root, "contracts/genlayer");
const expected = {
  registry: { file: "wrk_registry.py", className: "WrkRegistry", methods: 25 },
  work: { file: "wrk_work.py", className: "WrkWork", methods: 56 },
  adjudicator: { file: "wrk_adjudicator.py", className: "WrkAdjudicator", methods: 17 },
  reputation: { file: "wrk_reputation.py", className: "WrkReputation", methods: 13 },
};

const env = Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)
  .filter((line) => line && !line.trim().startsWith("#"))
  .map((line) => {
    const split = line.indexOf("=");
    const value = line.slice(split + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    return [line.slice(0, split).trim(), value];
  }));
if (!env.GENLAYER_PRIVATE_KEY) throw new Error("GENLAYER_PRIVATE_KEY is missing from .env");

const account = createAccount(env.GENLAYER_PRIVATE_KEY);
const deployer = account.address.toLowerCase();
const observer = "0xed9edd8586b20524cafa4f568413c504c9b03172";
if (deployer !== observer) throw new Error("The configured deployer does not match the Base settlement observer/attestor");
const client = createClient({ chain: chains.studionet, account });

const tempDir = join(tmpdir(), `wrk-dao-studionet-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });
const code = {};
for (const [name, spec] of Object.entries(expected)) {
  if (name === "registry") continue;
  const artifact = join(tempDir, `${name}.py`);
  const build = spawnSync("python3", [join(contractRoot, "build_deployable.py"), name, artifact], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`Could not build ${name}: ${build.stderr || build.stdout}`);
  const text = readFileSync(artifact, "utf8");
  const schema = await client.getContractSchemaForCode(text);
  const methodCount = Object.keys(schema.functions ?? schema.methods ?? {}).length;
  if (methodCount !== spec.methods) throw new Error(`${name} schema preflight returned ${methodCount} methods; expected ${spec.methods}`);
  code[name] = text;
  console.log(`preflight ${name}: ${methodCount} methods`);
}

const manifestPath = join(contractRoot, "deployments/studionet.json");
if (!existsSync(manifestPath)) throw new Error("the already-deployed registry manifest is missing; refusing to deploy dependent contracts");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.network !== "studionet" || manifest.chain_id !== 61999 || !manifest.contracts?.registry) {
  throw new Error("existing deployment manifest is not a Studionet registry deployment");
}
const registryAddress = manifest.contracts.registry;
const registrySchema = await client.getContractSchema(registryAddress);
if (Object.keys(registrySchema.functions ?? registrySchema.methods ?? {}).length !== expected.registry.methods) {
  throw new Error("the recorded registry address does not expose the WRK registry schema");
}
const deployed = {
  registry: { address: registryAddress, transaction_hash: manifest.transactions.registry },
};

async function deployOne(name, args) {
  if (manifest.contracts?.[name] && manifest.transactions?.[name]) {
    const address = manifest.contracts[name];
    const schema = await client.getContractSchema(address);
    const methodCount = Object.keys(schema.functions ?? schema.methods ?? {}).length;
    if (methodCount !== expected[name].methods) throw new Error(`recorded ${name} at ${address} has ${methodCount} methods; expected ${expected[name].methods}`);
    deployed[name] = { address, transaction_hash: manifest.transactions[name] };
    console.log(`verified existing ${name}: ${address}`);
    return address;
  }
  const hash = await client.deployContract({ code: code[name], args, leaderOnly: false });
  console.log(`submitted ${name}: ${hash}`);
  const transaction = await waitUntilFinalized(hash, name);
  const address = (transaction.data?.contract_address ?? transaction.txDataDecoded?.contractAddress)?.toLowerCase();
  if (!address) throw new Error(`${name} finalized without a contract address; inspect ${hash} before continuing`);
  let schema;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { schema = await client.getContractSchema(address); break; }
    catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  const methodCount = Object.keys(schema.functions ?? schema.methods ?? {}).length;
  if (methodCount !== expected[name].methods) throw new Error(`${name} at ${address} has ${methodCount} methods; expected ${expected[name].methods}`);
  deployed[name] = { address, transaction_hash: hash };
  console.log(`verified ${name}: ${address}`);
  return address;
}

async function waitUntilFinalized(hash, label) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const transaction = await client.getTransaction({ hash });
    if (transaction.statusName === "FINALIZED") return transaction;
    if (["CANCELED", "UNDETERMINED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(transaction.statusName)) {
      throw new Error(`${label} ended in ${transaction.statusName} (${transaction.result_name ?? "no result"}); inspect ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`${label} did not finalize before timeout; resume after inspecting ${hash}`);
}

const work = await deployOne("work", [registryAddress, "0x" + "0".repeat(40), observer]);
const adjudicator = await deployOne("adjudicator", [work]);
let wiring = await client.readContract({ address: work, functionName: "wiring", args: [], jsonSafeReturn: true });
if (Array.isArray(wiring) && String(wiring[1]).toLowerCase() !== adjudicator.toLowerCase()) {
  const zero = "0x" + "0".repeat(40);
  if (String(wiring[1]).toLowerCase() !== zero) throw new Error(`work is already wired to unexpected adjudicator ${wiring[1]}`);
  const wireHash = await client.writeContract({ address: work, functionName: "configure_adjudicator", args: [adjudicator], value: 0n });
  console.log(`submitted adjudicator wiring: ${wireHash}`);
  await waitUntilFinalized(wireHash, "adjudicator wiring");
  wiring = await client.readContract({ address: work, functionName: "wiring", args: [], jsonSafeReturn: true });
}
if (!Array.isArray(wiring) || String(wiring[1]).toLowerCase() !== adjudicator.toLowerCase()) {
  throw new Error("work.adjudicator did not match the finalized adjudicator after one-time wiring");
}
console.log(`verified adjudicator wiring: ${adjudicator}`);
await deployOne("reputation", [work, adjudicator]);

const startBlock = Number(await client.getBlockNumber());
const completeManifest = {
  ...manifest,
  network: "studionet",
  chain_id: 61999,
  deployer: account.address,
  settlement_observer: observer,
  deployed_at_block: manifest.deployed_at_block ?? startBlock,
  index_start_block: manifest.index_start_block ?? startBlock,
  contracts: Object.fromEntries(Object.entries(deployed).map(([key, value]) => [key, value.address])),
  transactions: Object.fromEntries(Object.entries(deployed).map(([key, value]) => [key, value.transaction_hash])),
};
mkdirSync(resolve(manifestPath, ".."), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(completeManifest, null, 2)}\n`);
console.log(JSON.stringify(completeManifest, null, 2));
