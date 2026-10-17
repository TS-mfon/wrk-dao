export default function Loading() {
  return <main id="main" className="container page-loading" aria-busy="true"><span className="eyebrow">READING THE PROTOCOL</span><div className="loading-rule" /><p role="status">Loading this network’s latest indexed state…</p></main>;
}
