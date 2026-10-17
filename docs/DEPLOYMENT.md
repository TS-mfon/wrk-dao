# WRK DAO deployment guide

WRK DAO is a multi-service product, not a single Vercel application. The frontend, API, MongoDB, chain indexer, GenLayer contracts, Base settlement contracts, and optional keeper each have independent runtime and configuration. A green frontend deployment does not prove the protocol backend is connected.

## Deployment topology

```text
Browser ──HTTPS──> Next.js frontend ──HTTPS──> Hono API ──> MongoDB read model
                                              │                  ▲
                                              ├── GenLayer RPC   │
                                              └── registry views │
GenLayer events ──> durable indexer process ──────────────────────┘
Base custody/settlement contracts <── authorized observer/attestor and keeper
```

MongoDB is a projection; chain events are canonical. Keep API and indexer near the same database. Use a managed MongoDB replica set with authentication, TLS, backups, least-privilege credentials, and network allowlists. The indexer must be a persistent process with restart supervision; a request-scoped/serverless function is not a substitute for its polling/checkpoint loop.

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

Set `MONGODB_URI` and `MONGODB_DB` in the API/indexer runtime. Use separate least-privilege credentials per environment. Initialize indexes through the store initialization path. Configure `GENLAYER_STUDIONET_RPC_URL`, `GENLAYER_BRADBURY_RPC_URL`, and `BASE_SEPOLIA_RPC_URL`; provide comma-separated contract addresses in `WRK_STUDIONET_ADDRESSES`, `WRK_BRADBURY_ADDRESSES`, and `WRK_BASE_ADDRESSES`. Use the deployed event-emitting contracts and start indexing at the appropriate configured deployment blocks. Then start the indexer as a persistent supervised process:

```sh
pnpm --filter @wrk/indexer build
pnpm --filter @wrk/indexer start
```

Use the package’s actual CLI and environment names from its config; ensure the supervisor restarts on failure, logs checkpoint advancement, and alerts on a stalled head. Do not share production secrets with preview deployments. A fresh database can correctly show zero records only after the indexer has established an observed head/checkpoint; otherwise freshness should show unknown/stale.

## 4. Configure and run the API

Set `PORT`, MongoDB variables, `WRK_STUDIONET_CONTRACTS` / `WRK_BRADBURY_CONTRACTS`, and the supported GenLayer RPC variables. `WRK_WRITE_MODE=prepare` is the default: writes produce a call for an agent-controlled signer and do not broadcast. `relay` requires a deliberately configured signer/keystore and creates API key custody. Keep RPC endpoints private where possible, add timeouts/rate limits and request logging that redacts signatures, never request bodies containing sensitive operator data, and never log environment variables.

```sh
pnpm --filter @wrk/api build
pnpm --filter @wrk/api start
```

Check `GET /v1/health`, `GET /v1/meta`, and each `GET /v1/{network}/health`. Verify a known registry view, inspect a known indexed record, and submit a non-economic write on a disposable test agent. Confirm chain transaction finality and that the indexer observes its event. The API’s `health` endpoint means only that the process responds; network health and freshness are separate.

The API now includes a GenLayerJS adapter for built-in StudioNet and Bradbury networks. Registry reads work once those addresses are configured. Prepare mode is operational only when the API can reach MongoDB and the GenLayer contracts. Relay mode additionally needs `WRK_RELAY_KEYS`, a JSON map of lowercase operator addresses to matching private keys; this grants the API custody authority for those agents and should only be enabled intentionally. The live Vercel frontend remains disconnected until a separately hosted API and indexer have been provisioned, contract addresses supplied, and the production `WRK_API_URL` set.

## 5. Deploy the frontend to Vercel

Create/choose a Vercel project for `apps/web` with the repository root configured as appropriate for the monorepo (the deployed project currently builds at repository root). Build command: `pnpm --filter @wrk/web build`; output is managed by Next.js. Set `WRK_API_URL` to the public HTTPS API origin for production and redeploy after the API health checks pass. Keep API secrets out of frontend variables: Next.js server-side `WRK_API_URL` is an origin, not a credential. Apply production domain, HTTPS, and deployment access settings intentionally. Verify `/`, `/docs`, `/inspect`, `/inspect/lookup`, and `/monitoring` over the public domain and confirm the network selector remains scoped.

Do not point the production frontend at an API until the API’s chain-specific health, freshness, and read-only verification work. A missing URL should remain a visible unavailable state; do not set it to a placeholder to make the screen appear connected.

## 6. Keeper and settlement operations

Configure the observer/attestor only after verifying the GenLayer finality source, Base verifier address, EIP-712 domain, sorted signer set, threshold, and one-hour challenge window. The keeper should be permissionless with respect to execution, idempotent, and monitored. Alert on posted-but-overdue settlements and on stale indexer checkpoints. Reconcile on-chain settlement execution against indexed payments. Never give the general REST API authority to fabricate a decision or bypass verifier checks.

## Environment configuration checklist

| Variable / configuration | Service | Notes |
| --- | --- | --- |
| `WRK_API_URL` | Next.js server runtime, agents, MCP | Public HTTPS origin of the API; no trailing slash required |
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
- [ ] Production Vercel `WRK_API_URL` points to the verified HTTPS API; public pages render real counts with freshness.
- [ ] Backups, monitoring, key rotation, incident response, and rate limits are configured.

See [API](API.md), [integration](INTEGRATION.md), [architecture](ARCHITECTURE.md), and [specification](SPEC.md) for operational semantics.
