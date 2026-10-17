import Link from "next/link";
import { ApiError, Footer, PageHeading, SourceNote } from "../../../components/protocol";
import { readHealth, readObjects } from "../../../lib/api";
import { collectionOf, COLLECTIONS, objectId, objectState, objectTitle } from "../../../lib/model";
import { withNetwork, type SearchParams } from "../../../lib/networks";
import { pageNetwork } from "../../../lib/page-network";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function CollectionPage({ params, searchParams }: { params: Promise<{ collection: string }>; searchParams: Promise<SearchParams> }) {
  const [{ collection: slug }, query] = await Promise.all([params, searchParams]);
  const collection = collectionOf(slug);
  if (!collection) return <main id="main" className="container not-found"><span className="eyebrow">UNKNOWN COLLECTION</span><h1>This collection isn’t available.</h1><Link href="/inspect">Return to Inspect →</Link></main>;
  const network = await pageNetwork(Promise.resolve(query));
  const offsetValue = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  const offset = /^\d+$/.test(offsetValue ?? "") ? Number(offsetValue) : 0;
  const [result, health] = await Promise.all([readObjects(network, collection.slug, offset), readHealth(network)]);
  const qValue = Array.isArray(query.q) ? query.q[0] : query.q;
  const q = (qValue ?? "").trim().toLowerCase();
  const items = result.ok ? result.data.items.filter((item) => !q || `${objectTitle(item, collection)} ${objectId(item, collection)} ${objectState(item, collection).label}`.toLowerCase().includes(q)) : [];
  const pageLimit = result.ok ? result.data.limit : 25;
  const pageOffset = result.ok ? result.data.offset : offset;
  const total = result.ok ? result.data.total : 0;
  const pageHref = (nextOffset: number) => withNetwork(`/inspect/${collection.slug}?offset=${nextOffset}${q ? `&q=${encodeURIComponent(q)}` : ""}`, network.slug);
  return <><main id="main" className="container"><PageHeading eyebrow={`INSPECT / ${collection.label.toUpperCase()}`} title={<>{collection.label}<br /><em>in the record.</em></>} description={collection.description} /><div className="inspect-grid"><aside className="inspect-sidebar"><h2>Collections</h2><nav aria-label="Record collections">{COLLECTIONS.map((item) => <Link key={item.slug} href={withNetwork(`/inspect/${item.slug}`, network.slug)} aria-current={item.slug === slug ? "page" : undefined}>{item.label}<small>→</small></Link>)}</nav></aside><section>
    <form className="data-toolbar" action={`/inspect/${collection.slug}`}><input type="hidden" name="network" value={network.slug} /><input type="search" name="q" defaultValue={q} placeholder={`Search this page of ${collection.label.toLowerCase()}…`} aria-label={`Search ${collection.label}`} /><button className="refresh-button" type="submit">Search</button><span className="result-count">{result.ok ? `${total.toLocaleString()} indexed records` : "Current records unavailable"}</span></form>
    {!result.ok ? <ApiError result={result} /> : items.length ? <div className="record-list">{items.map((item) => <Link className="record-row" key={item._id} href={withNetwork(`/inspect/${collection.slug}/${encodeURIComponent(objectId(item, collection))}`, network.slug)}><span className="record-main"><span className="record-title">{objectTitle(item, collection)}</span><span className="record-subtitle">{objectId(item, collection)}</span></span><span className="record-state">{objectState(item, collection).label}</span><span className="record-time">Block {item.chain_ref.block} <span className="record-arrow">↗</span></span></Link>)}</div> : <div className="empty-state">{q ? "No matching records on this page." : `No ${collection.label.toLowerCase()} have been indexed on ${network.name} yet.`}</div>}
    {result.ok && <nav className="pagination" aria-label="Collection pages"><Link className={pageOffset === 0 ? "disabled" : ""} aria-disabled={pageOffset === 0} href={pageOffset === 0 ? "#" : pageHref(Math.max(0, pageOffset - pageLimit))}>← Newer</Link><span className="mono">{pageOffset + 1}–{Math.min(pageOffset + pageLimit, total)} / {total}</span><Link className={pageOffset + pageLimit >= total ? "disabled" : ""} aria-disabled={pageOffset + pageLimit >= total} href={pageOffset + pageLimit >= total ? "#" : pageHref(pageOffset + pageLimit)}>Older →</Link></nav>}
    </section></div><SourceNote network={network} result={health} /></main><Footer network={network} /></>;
}
