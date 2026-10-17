"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { NETWORKS, withNetwork } from "../lib/networks";
import { Arrow, Mark } from "./icons";

export const NAVIGATION = [
  { href: "/", label: "Overview" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/docs", label: "Protocol" },
  { href: "/monitoring", label: "Monitor" },
  { href: "/inspect", label: "Inspect" },
] as const;

export function Navigation() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const selected = params.get("network") ?? "studionet";
  const network = NETWORKS.find((entry) => entry.slug === selected);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);

  function changeNetwork(slug: string) {
    const next = new URLSearchParams(params.toString());
    next.set("network", slug);
    next.delete("offset");
    next.delete("id");
    // An object id is scoped to its original chain. Changing chains opens its collection
    // rather than pretending the same record exists on the new chain.
    const segments = pathname.split("/").filter(Boolean);
    const destination = segments[0] === "inspect" && segments.length > 2 ? `/inspect/${segments[1]}` : pathname;
    startTransition(() => router.push(`${destination}?${next.toString()}`));
  }

  return <header className="site-header">
    <div className="header-inner">
      <Link href={withNetwork("/", network?.slug ?? "studionet")} className="wordmark" aria-label="WRK DAO overview"><Mark /><span>WRK<span className="wordmark-dao">DAO</span></span></Link>
      <nav className="desktop-nav" aria-label="Main navigation">{NAVIGATION.map((item) => <Link key={item.href} href={withNetwork(item.href, network?.slug ?? "studionet")} aria-current={active(item.href) ? "page" : undefined}>{item.label}</Link>)}</nav>
      <div className="header-tools">
        <div className={`network-control ${pending ? "is-pending" : ""}`}>
          <span className="network-dot" aria-hidden="true" />
          <label className="sr-only" htmlFor="network-selector">Network</label>
          <select id="network-selector" value={network?.slug ?? ""} onChange={(event) => changeNetwork(event.target.value)} disabled={pending} aria-describedby="selected-chain">
            {!network && <option value="">Unknown network</option>}
            {NETWORKS.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.name}</option>)}
          </select>
          <span className="network-chevron" aria-hidden="true">⌄</span>
          <span className="network-chain" id="selected-chain">{network?.chainId ?? "?"}</span>
        </div>
        <button className="menu-toggle" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}><span /><span /></button>
      </div>
    </div>
    {menuOpen && <nav id="mobile-navigation" className="mobile-nav" aria-label="Mobile navigation">{NAVIGATION.map((item) => <Link key={item.href} href={withNetwork(item.href, network?.slug ?? "studionet")} onClick={() => setMenuOpen(false)} aria-current={active(item.href) ? "page" : undefined}>{item.label}<Arrow /></Link>)}</nav>}
    <div className="network-pending sr-only" role="status">{pending ? "Loading the selected network…" : ""}</div>
  </header>;
}

export function NavigationFallback() {
  return <header className="site-header"><div className="header-inner"><Link href="/" className="wordmark"><Mark /><span>WRK<span className="wordmark-dao">DAO</span></span></Link><span className="mono">Loading network…</span></div></header>;
}
