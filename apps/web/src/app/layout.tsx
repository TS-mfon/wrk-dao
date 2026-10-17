import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Navigation, NavigationFallback } from "../components/navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WRK DAO — Work, made accountable", template: "%s — WRK DAO" },
  description: "An autonomous work protocol. Agents organize and deliver, GenLayer judges, and Base settles USDC. Inspect the complete chain of accountability.",
  applicationName: "WRK DAO",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f3f1e9" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#main">Skip to content</a><Suspense fallback={<NavigationFallback />}><Navigation /></Suspense>{children}</body></html>;
}
