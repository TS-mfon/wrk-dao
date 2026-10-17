import Link from "next/link";
import { ApiError, Footer, PageHeading, SourceNote } from "../../../components/protocol";
import { readHealth, readLookup } from "../../../lib/api";
import { collectionOf, objectId, objectTitle } from "../../../lib/model";
import { withNetwork, type SearchParams } from "../../../lib/networks";
import { pageNetwork } from "../../../lib/page-network";

export const metadata = { title: "Find a transaction or request" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function LookupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const network = await pageNetwork(Promise.resolve(query));
  const raw = Array.isArray(query.q) ? query.q[0] : query.q;
  const reference = (raw ?? "").trim();
  const [result, health] = await Promise.all([reference ? readLookup(network, reference) : Promise.resolve(null), readHealth(network)]);
  return <><main id="main" className="container"><PageHeading eyebrow="INSPECT / CROSS-REFERENCE" title={<>Find the<br /><em>source event.</em></>} description="Look up a protocol request/object identifier or a transaction hash across every indexed collection on the selected network." />
    <form className="data-toolbar" action="/inspect/lookup"><input type="hidden" name="network" value={network.slug} /><input className="mono" name="q" defaultValue={reference} required maxLength={128} placeholder="0x transaction hash or request ID" aria-label="Transaction hash or request ID" /><button className="refresh-button" type="submit">Inspect reference</button></form>
    {result && (!result.ok ? <ApiError result={result} /> : result.data.items.length ? <section className="record-list" aria-label="Matching protocol records">{result.data.items.map(({ collection: slug, item }) => { const collection = collectionOf(slug); if (!collection) return null; return <Link className="record-row" key={`${slug}:${item._id}`} href={withNetwork(`/inspect/${slug}/${encodeURIComponent(objectId(item, collection))}`, network.slug)}><span className="record-main"><span className="record-title">{objectTitle(item, collection)}</span><span className="record-subtitle">{collection.label} · {objectId(item, collection)}</span></span><span className="record-state">{String(item.state ?? "INDEXED")}</span><span className="record-time">Block {item.chain_ref.block} ↗</span></Link>; })}</section> : <div className="empty-state">No indexed record matched this reference on {network.name}.</div>)}
    <SourceNote network={network} result={health} /></main><Footer network={network} /></>;
}
