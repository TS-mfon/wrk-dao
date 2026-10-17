import Link from "next/link";
import type { ReactNode } from "react";
import type { ReadResult } from "../lib/api";
import { chainName, formatInteger, formatUtc, shortHash, type ChainRef, type Freshness, type Health } from "../lib/model";
import { explorerTransaction, withNetwork, type Network } from "../lib/networks";
import { Arrow, Mark, Signal } from "./icons";
import { Refresh } from "./refresh";

export function Eyebrow({ children, number }: { children: ReactNode; number?: string }) {
  return <div className="eyebrow"><span className="eyebrow-square" aria-hidden="true" />{children}{number && <span className="eyebrow-number">{number}</span>}</div>;
}

export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: ReactNode; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div><Eyebrow>{eyebrow}</Eyebrow><h1>{title}</h1><p className="page-description">{description}</p></div>{children}</div>;
}

export function ApiError({ result, compact = false }: { result: { reason: string; message: string }; compact?: boolean }) {
  return <div role="alert" className={`api-error ${compact ? "compact" : ""}`} data-api-state="unavailable"><Signal /><div><strong>{result.reason === "not-found" ? "Record not found" : result.reason === "invalid" ? "Unverified API response" : "API unavailable"}</strong><p>{result.message}</p>{!compact && <span className="small muted">No cached or example records are being shown. Refresh to try the API again.</span>}</div></div>;
}

export function FreshnessLine({ freshness, observedAt }: { freshness: Freshness; observedAt?: number }) {
  return <div className={`freshness-line ${freshness.stale ? "stale" : ""}`} data-freshness={freshness.stale ? "stale" : "indexed"}><span className="status-dot" aria-hidden="true" /><span>{freshness.stale ? "Read model stale / not indexed" : "Indexed read model"}</span><span className="mono">{chainName(freshness.chain)} · {freshness.chain} · block {formatInteger(freshness.indexed_block)}</span>{observedAt && <span className="freshness-time">Fetched {formatUtc(observedAt)}</span>}</div>;
}

export function ChainProvenance({ reference, expanded = false }: { reference: ChainRef; expanded?: boolean }) {
  const href = explorerTransaction(reference.chain, reference.tx_hash);
  return <div className={`provenance ${expanded ? "expanded" : ""}`} data-chain-ref={reference.chain}>
    <span className="provenance-chain">{chainName(reference.chain)} <span className="mono">{reference.chain}</span></span>
    <span className="mono provenance-block">Block {formatInteger(reference.block)} · log {reference.log_index}</span>
    {href ? <a className="transaction-link mono" href={href} target="_blank" rel="noreferrer" aria-label={`Transaction ${reference.tx_hash} on ${chainName(reference.chain)} (opens new tab)`}>{expanded ? reference.tx_hash : shortHash(reference.tx_hash)}<Arrow diagonal /></a> : <span className={`mono transaction-hash ${expanded ? "" : "short"}`} title={reference.tx_hash}>{expanded ? reference.tx_hash : shortHash(reference.tx_hash)}</span>}
    {!expanded && <span className="sr-only">Transaction {reference.tx_hash}</span>}
    {expanded && reference.block_hash && <span className="block-hash mono"><span className="field-kicker">Block hash</span>{reference.block_hash}</span>}
  </div>;
}

export function SourceNote({ network, result, automatic = false }: { network: Network; result: ReadResult<Health>; automatic?: boolean }) {
  return <section className="source-note" aria-label="Data source"><div className="source-note-main"><span className="source-label mono">READ MODEL</span>{result.ok ? <FreshnessLine freshness={result.data.freshness} observedAt={result.observedAt} /> : <span className="source-unavailable">API unavailable · {network.name} · {network.chainId}</span>}</div><Refresh automatic={automatic} /></section>;
}

export function Footer({ network }: { network: Network }) {
  return <footer className="site-footer"><div className="footer-top"><Link className="footer-wordmark" href={withNetwork("/", network.slug)}><Mark /><span>Make work<br />accountable.</span></Link><div className="footer-links"><Link href={withNetwork("/docs", network.slug)}>Protocol reference <Arrow diagonal /></Link><Link href={withNetwork("/docs/api", network.slug)}>Agent API <Arrow diagonal /></Link><Link href={withNetwork("/monitoring", network.slug)}>Network monitor <Arrow diagonal /></Link></div></div><div className="footer-bottom"><span>WRK DAO <span className="muted">/ Autonomous work protocol</span></span><span className="mono">{network.name} · CHAIN {network.chainId}</span><span>Agents operate. Humans inspect.</span></div></footer>;
}

export function AuthorityDiagram({ compact = false }: { compact?: boolean }) {
  return <div className={`authority-diagram ${compact ? "diagram-compact" : ""}`} role="img" aria-label="Agents organize and submit work on GenLayer. GenLayer judges. A finalized decision crosses the attestation and one-hour challenge window before Base settles USDC. The database only mirrors chain records.">
    <div className="diagram-topline mono"><span>PROTOCOL ARCHITECTURE</span><span>FIG. 01</span></div>
    <svg className="diagram-orbit" viewBox="0 0 440 440" aria-hidden="true"><circle cx="220" cy="220" r="180" /><circle cx="220" cy="220" r="142" /><path d="M40 220h360M220 40v360" /><path className="orbit-accent" d="M220 40a180 180 0 0 1 180 180" /><circle className="orbit-point" cx="220" cy="40" r="5" /></svg>
    <div className="diagram-flow">
      <div className="diagram-node genlayer-node"><span className="node-symbol">G<span>↗</span></span><div><span className="mono node-kicker">ORGANIZATION + JUDGMENT</span><strong>GenLayer</strong><span>Define. Execute. Adjudicate.</span></div><span className="node-number mono">01</span></div>
      <div className="diagram-connector"><span className="travel-dot" /><span className="mono">FINALIZED DECISION</span><span className="connector-arrow">↓</span></div>
      <div className="attestation-node"><span className="attestation-symbol">≋</span><div><strong>Bounded attestation</strong><span className="mono">M-OF-N · 1H CHALLENGE WINDOW</span></div></div>
      <div className="diagram-connector lower"><span className="travel-dot" /><span className="mono">FAITHFUL TRANSCRIPTION</span><span className="connector-arrow">↓</span></div>
      <div className="diagram-node base-node"><span className="node-symbol base-symbol">—</span><div><span className="mono node-kicker">CUSTODY + EXECUTION</span><strong>Base</strong><span>USDC held in on-chain escrow.</span></div><span className="node-number mono">02</span></div>
    </div>
    <div className="diagram-caption"><span className="caption-bracket">↳</span><span>Every transition leaves a record.<br /><strong>The database observes. The chain decides.</strong></span></div>
  </div>;
}
