import Link from "next/link";
import { ApiError, ChainProvenance, Footer, PageHeading, SourceNote } from "../../../../components/protocol";
import { readHealth, readObject } from "../../../../lib/api";
import { collectionOf, objectId, objectPayload, objectState, objectTitle } from "../../../../lib/model";
import { withNetwork, type SearchParams } from "../../../../lib/networks";
import { pageNetwork } from "../../../../lib/page-network";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function RecordPage({ params, searchParams }: { params: Promise<{ collection: string; id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ collection: slug, id }, query] = await Promise.all([params, searchParams]);
  const collection = collectionOf(slug);
  if (!collection) return <main id="main" className="container not-found"><span className="eyebrow">UNKNOWN COLLECTION</span><h1>This collection isn’t available.</h1><Link href="/inspect">Return to Inspect →</Link></main>;
  const network = await pageNetwork(Promise.resolve(query));
  const [result, health] = await Promise.all([readObject(network, collection.slug, id), readHealth(network)]);
  return <><main id="main" className="container"><PageHeading eyebrow={`INSPECT / ${collection.label.toUpperCase()} / RECORD`} title={result.ok ? <>{objectTitle(result.data.item, collection)}<br /><em>source record.</em></> : <>Record<br /><em>inspection.</em></>} description={result.ok ? `A ${collection.singular.toLowerCase()} recorded on ${network.name}. Verify the source event and its individual chain provenance below.` : `Look up a ${collection.singular.toLowerCase()} on ${network.name}.`}><Link className="text-link" href={withNetwork(`/inspect/${collection.slug}`, network.slug)}>← All {collection.label.toLowerCase()}</Link></PageHeading>
    {!result.ok ? <ApiError result={result} /> : <article className="record-detail"><ChainProvenance reference={result.data.item.chain_ref} expanded /><dl className="detail-fields"><div className="detail-field"><dt>OBJECT ID</dt><dd>{objectId(result.data.item, collection)}</dd></div><div className="detail-field"><dt>STATE</dt><dd>{objectState(result.data.item, collection).label}</dd></div>{Object.entries(result.data.item).filter(([key]) => !["_id", "chain_ref", "payload", "profile", "metadata", "rules"].includes(key)).map(([key, value]) => <div className="detail-field" key={key}><dt>{key.replaceAll("_", " ").toUpperCase()}</dt><dd>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>{objectPayload(result.data.item) && <section className="monitor-section"><h2>Verified payload</h2><p className="muted">Payload content is carried by the indexed event and checked against its canonical hash.</p><div className="detail-payload"><pre>{JSON.stringify(objectPayload(result.data.item), null, 2)}</pre></div></section>}</article>}
    <SourceNote network={network} result={health} /></main><Footer network={network} /></>;
}
