"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main id="main" className="container not-found"><span className="eyebrow">VIEW UNAVAILABLE</span><h1>This view couldn’t load.</h1><p>The request failed before current protocol state could be verified.</p><button type="button" className="button button-dark" onClick={reset}>Try again →</button></main>;
}
