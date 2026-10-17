import Link from "next/link";
import { DOC_SECTIONS } from "../lib/documentation";
import { withNetwork, type Network } from "../lib/networks";
import { Arrow } from "./icons";

export function DocsNavigation({ network, api = false }: { network: Network; api?: boolean }) {
  return <aside className="docs-sidebar"><span className="mono sidebar-label">PROTOCOL REFERENCE</span><nav aria-label="Documentation sections">{DOC_SECTIONS.map(([id, label], index) => <Link key={id} href={api ? withNetwork(`/docs#${id}`, network.slug) : `#${id}`}><span className="mono">0{index + 1}</span>{label}</Link>)}<Link href={withNetwork("/docs/api", network.slug)} aria-current={api ? "page" : undefined}><span className="mono">↗</span>API reference</Link><a href="https://github.com/TS-mfon/wrk-dao/blob/main/docs/INTEGRATION.md">Integration guide ↗</a><a href="https://github.com/TS-mfon/wrk-dao/blob/main/docs/DEPLOYMENT.md">Deployment guide ↗</a></nav><div className="docs-sidebar-note"><span className="status-dot" /><span>Protocol v1<br /><span className="muted">Test networks</span></span></div></aside>;
}

export function StatePath({ states }: { states: readonly string[] }) {
  return <ol className="state-path">{states.map((state, index) => <li key={state}><code>{state}</code>{index < states.length - 1 && <Arrow />}</li>)}</ol>;
}
