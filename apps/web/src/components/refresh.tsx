"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

export function Refresh({ automatic = false }: { automatic?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [automatic, router]);
  return <button type="button" className="refresh-button" onClick={() => startTransition(() => router.refresh())} disabled={pending}><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M16.5 7a7 7 0 1 0 .3 5M17 2v5h-5" /></svg>{pending ? "Refreshing…" : "Refresh"}</button>;
}
