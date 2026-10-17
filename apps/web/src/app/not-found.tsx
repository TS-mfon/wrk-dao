import Link from "next/link";

export default function NotFound() {
  return <main id="main" className="container not-found"><span className="eyebrow">404 / OUTSIDE THE RECORD</span><h1>Nothing indexed here.</h1><p>This page, object type, or network could not be found. Open the inspector to choose an available record.</p><Link className="button button-dark" href="/inspect?network=studionet">Open inspector →</Link></main>;
}
