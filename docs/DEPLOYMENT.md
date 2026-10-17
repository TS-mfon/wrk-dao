# WRK DAO deployment guide

WRK DAO is a multi-service product, not a single Vercel application. The frontend, API, MongoDB, chain indexer, GenLayer contracts, Base settlement contracts, and optional keeper each have independent runtime and configuration. A green frontend deployment does not prove the protocol backend is connected.

## Deployment topology

```text
Browser/agent ──HTTPS──> Next.js + Vercel API ──> MongoDB read model
                                  │                    ▲
                                  ├── GenLayer RPC ─────┤ bounded on-demand event indexing
                                  └── Base RPC ─────────┘
GenLayer/Base chain events ────────────────────────────┘
Base custody/settlement contracts <── authorized observer/attestor and keeper
```

MongoDB is a projection; chain events are canonical. The Vercel API advances the projection directly from chain RPC on network-scoped GET requests, using a MongoDB checkpoint and a distributed lock. This request-driven indexer does not need a separate VPS or always-on worker. Each read advances at most 2,000 blocks per enabled chain; the checkpoint retains only the most recent 64 block hashes for bounded reorg checks. If a chain is farther behind, repeated API traffic gradually catches it up. Health and freshness expose the last indexed block, so consumers should interpret counts as the records indexed through that checkpoint while it is stale. Use a managed MongoDB replica set with authentication, TLS, backups, least-privilege credentials, and network allowlists. A standalone worker can be added later for continuous catch-up but is optional.

## 1. Choose and verify target networks

Use `studionet` for development and `bradbury` for GenLayer test deployments. Use Base Sepolia for the custody/settlement contracts. Confirm chain IDs, RPC endpoints, available test funds where required, and whether the target network is intended for public visitors. Never point production variables at a local-only RPC.

The protocol’s configured IDs are Studionet 61999, Bradbury 4221, and Base Sepolia 84532. Only the API’s GenLayer deployments are writable. Do not reuse addresses between networks.

## 2. Deploy contracts and record addresses

Deploy the GenLayer ICs in dependency order: registry, work, adjudicator, reputation. Configure the cross-contract addresses and authorized roles according to the contract constructors and [protocol specification](SPEC.md). Verify each deployment transaction and contract interface, then exercise read-only registry and state reads. Deploy Base settlement/escrow/verifier contracts with the exact expected chain ID, USDC address, attestor threshold, signer set, and challenge window. Verify owner/role configuration and byte-level settlement encoder parity before enabling funds.

The API requires a JSON object of four GenLayer addresses in `WRK_STUDIONET_CONTRACTS` or `WRK_BRADBURY_CONTRACTS`:

```json
{"registry":"0x…40 hex…","work":"0x…","adjudicator":"0x…","reputation":"0x…"}
```

The indexer uses `WRK_STUDIONET_ADDRESSES` / `WRK_BRADBURY_ADDRESSES` and Base source configuration using the variable names documented by `packages/indexer/src/config.ts` and `.env.example`. Use the exact schema and address set for that network. Check the code’s source configuration before adding a new chain; the indexer must know event ABIs and deployment block numbers. Save a deployment manifest with chain IDs, addresses, transaction hashes, block numbers, compiler/runner versions, and ownership/attestor configuration. Never put deployer private keys in that manifest.

GenLayer deployment should use the supported GenLayer CLI and the selected built-in network configuration. Follow `genlayer network set`, inspect the selected network, deploy one contract at a time, and verify the transaction receipt/execution result before proceeding. StudioNet may be rate-limited; avoid parallel deployment bursts. Bradbury/Base Sepolia deployments require the relevant test assets. Treat contract deployment and role changes as irreversible chain operations; review exact addresses and authorities before submitting them.

## 3. Configure and run MongoDB/indexer

Set `MONGODB_URI` and `MONGODB_DB` in the API runtime. Use separate least-privilege credentials per environment. Initialize indexes through the store initialization path. Configure the RPC URLs and comma-separated event-contract addresses. Set each `WRK_*_START_BLOCK` to the earliest deployment block for its configured addresses; the API uses these values when creating its first checkpoint. For local operations, the standalone indexer CLI remains available:

```sh
pnpm --filter @wrk/indexer build
pnpm --filter @wrk/indexer exec wrk-indexer index
```

Use the package’s actual CLI and environment names from its config; ensure the supervisor restarts on failure, logs checkpoint advancement, and alerts on a stalled head. Do not share production secrets with preview deployments. A fresh database can correctly show zero records only after the indexer has established an observed head/checkpoint; otherwise freshness should show unknown/stale.

## 4. Configure and run the API

Set `PORT`, MongoDB variables, `WRK_STUDIONET_CONTRACTS` / `WRK_BRADBURY_CONTRACTS`, and the supported GenLayer RPC variables. `WRK_WRITE_MODE=prepare` is the default: writes produce a call for an agent-controlled signer and do not broadcast. `relay` requires a deliberately configured signer/keystore and creates API key custody. Keep RPC endpoints private where possible, add timeouts/rate limits and request logging that redacts signatures, never request bodies containing sensitive operator data, and never log environment variables.

```sh
pnpm --filter @wrk/api build
pnpm --filter @wrk/api start
```

Check `GET /v1/health`, `GET /v1/meta`, and each `GET /v1/{network}/health`. Verify a known registry view, inspect a known indexed record, and submit a non-economic write on a disposable test agent. Confirm chain transaction finality and that the indexer observes its event. The API’s `health` endpoint means only that the process responds; network health and freshness are separate.

The API includes a GenLayerJS adapter for built-in StudioNet and Bradbury networks. Prepare mode is operational only when the API can reach MongoDB and the GenLayer contracts. Relay mode additionally needs `WRK_RELAY_KEYS`, a JSON map of lowercase operator addresses to matching private keys; this grants the API custody authority for those agents and should only be enabled intentionally. `GET /api` reports environment presence; network health reports actual projection freshness.

## 5. Deploy the frontend and API to Vercel

The existing Vercel project serves Next.js pages and the Hono API through the Node.js catch-all route `apps/web/src/app/api/[[...path]]/route.ts`. Public REST endpoints are under `/api/v1`; `GET /api` reports dependency readiness. The frontend defaults to its same-deployment API unless `WRK_API_URL` overrides it. The build runs `pnpm --filter @wrk/api build` before `next build` so the serverless route bundles the API.

Set Vercel production variables `MONGODB_URI`, `MONGODB_DB`, `WRK_STUDIONET_CONTRACTS`, `WRK_BRADBURY_CONTRACTS`, `WRK_STUDIONET_ADDRESSES`, `WRK_BRADBURY_ADDRESSES`, and `WRK_BASE_ADDRESSES` as those services are provisioned. Never expose these through `NEXT_PUBLIC_` variables. Verify `GET /api`, `/api/v1/meta`, `/api/v1/health`, `/`, `/docs`, `/inspect`, `/inspect/lookup`, and `/monitoring` on the public domain.

The API route is deployed with the frontend. Configure MongoDB, RPC endpoints, contract maps, and event-address maps in Vercel production variables. The repository `.env` may point MongoDB at localhost; never copy that local URL into production. Serverless functions are stateless, so MongoDB checkpoints and locks provide shared progress between requests. `GET /api` reports variable presence only; verify API network health and freshness to confirm live connectivity.

## 6. Keeper and settlement operations

Configure the observer/attestor only after verifying the GenLayer finality source, Base verifier address, EIP-712 domain, sorted signer set, threshold, and one-hour challenge window. The keeper should be permissionless with respect to execution, idempotent, and monitored. Alert on posted-but-overdue settlements and on stale indexer checkpoints. Reconcile on-chain settlement execution against indexed payments. Never give the general REST API authority to fabricate a decision or bypass verifier checks.

## Environment configuration checklist

| Variable / configuration | Service | Notes |
| --- | --- | --- |
| `WRK_API_URL` | Next.js server runtime, agents, MCP | Optional override; production default is `https://wrk-dao.vercel.app/api` |
| `PORT` | API | HTTP listen port; defaults to 8787 |
| `MONGODB_URI`, `MONGODB_DB` | API and indexer | TLS, least privilege, distinct environment database |
| `WRK_WRITE_MODE` | API | `prepare` or `relay`; prepare is default |
| `WRK_STUDIONET_CONTRACTS`, `WRK_BRADBURY_CONTRACTS` | API | JSON address object for four GenLayer contracts |
| `GENLAYER_STUDIONET_RPC_URL`, `GENLAYER_BRADBURY_RPC_URL`, `BASE_SEPOLIA_RPC_URL` | Indexer | RPC endpoints for the corresponding chain sources |
| `WRK_STUDIONET_ADDRESSES`, `WRK_BRADBURY_ADDRESSES`, `WRK_BASE_ADDRESSES` | Indexer | Comma-separated deployed event contract addresses per chain |
| `WRK_RELAY_KEYS` | API, relay mode only | JSON operator-address → private-key map; enables key custody |
| Agent `WRK_AGENT_ID`, `WRK_PRIVATE_KEY` | Agent/MCP host only | Private key stays in a local/host secret store; never in Vercel |
| Base USDC, verifier, escrow, attestor configuration | Settlement observer/keeper | Chain-specific and subject to independent verification |

Never paste `.env` values into issues, CI logs, deployment descriptions, or chat. Rotate any key that has been exposed.

## Operational readiness checklist

- [ ] Contract manifest matches selected chain IDs; deployment receipts and roles were reviewed.
- [ ] API uses a real GenLayerJS writer and registry reader; no unconfigured adapter remains.
- [ ] MongoDB is reachable and protected; indexer checkpoints advance for every enabled chain.
- [ ] API health, network health, read freshness, and known-record provenance are verified.
- [ ] Test agent signing, registry authorization, a low-risk write, transaction finality, and event indexing end to end.
- [ ] Settlement verifier, attestor threshold, exact payload, challenge window, and keeper alerting are verified independently.
- [ ] Vercel `GET /api` reports configured; public pages render real counts with current freshness.
- [ ] Backups, monitoring, key rotation, incident response, and rate limits are configured.

See [API](API.md), [integration](INTEGRATION.md), [architecture](ARCHITECTURE.md), and [specification](SPEC.md) for operational semantics.
