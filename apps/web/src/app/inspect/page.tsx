import Link from "next/link";
import { Arrow } from "../../components/icons";
import { ApiError, Footer, PageHeading, SourceNote } from "../../components/protocol";
import { readObjects, readHealth } from "../../lib/api";
import { COLLECTIONS, objectId, objectState, objectTitle } from "../../lib/model";
import { withNetwork, type SearchParams } from "../../lib/networks";
import { pageNetwork } from "../../lib/page-network";

export const metadata = { title: "Inspect the record" };
export const dynamic = "force-dynamic";

export default async function Inspect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const network = await pageNetwork(Promise.resolve(query));
  const collection = COLLECTIONS[0];
  const offsetValue = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  const offset = /^\d+$/.test(offsetValue ?? "") ? Number(offsetValue) : 0;
  const [result, health] = await Promise.all([readObjects(network, collection.slug, offset), readHealth(network)]);
  return <><main id="main" className="container"><PageHeading eyebrow="OPEN RECORD / CHAIN DATA" title={<>Inspect the<br /><em>protocol record.</em></>} description="Browse indexed events and objects with their source chain, block, and transaction reference. Every value shown here comes from the selected network’s read model." />
    <div className="inspect-grid"><aside className="inspect-sidebar"><h2>Collections</h2><nav aria-label="Record collections">{COLLECTIONS.map((item) => <Link href={withNetwork(`/inspect/${item.slug}`, network.slug)} key={item.slug}>{item.label}<small>→</small></Link>)}</nav></aside><section><h2>Choose a collection</h2><p className="muted">Start with recent agent registrations, or select a collection to inspect its records.</p><div className="record-list">{result.ok && result.data.items.length ? result.data.items.map((item) => <Link className="record-row" key={item._id} href={withNetwork(`/inspect/agents/${encodeURIComponent(objectId(item, collection))}`, network.slug)}><span className="record-main"><span className="record-title">{objectTitle(item, collection)}</span><span className="record-subtitle">{objectId(item, collection)}</span></span><span className="record-state">{objectState(item, collection).label}</span><span className="record-time">Block {item.chain_ref.block}<span className="record-arrow"> ↗</span></span></Link>) : result.ok ? <div className="empty-state">No agent records have been indexed on {network.name} yet.</div> : <ApiError result={result} />}</div></section></div><SourceNote network={network} result={health} /></main><Footer network={network} /></>;
}
