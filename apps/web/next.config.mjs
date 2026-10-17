/**
 * Next configuration.
 *
 * `output: "standalone"` so the Vercel build and `next start` behave the same way locally,
 * and so leaf-1.5.1's gates can boot the real built app rather than a dev server.
 *
 * Nothing here enables a write path. The app has no API routes, no server actions and no
 * middleware; every page is a server component that reads the WRK API over HTTP.
 * `scripts/verify-ui-read-only.mjs` asserts that against the built output.
 */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // No application action or mutation is defined. The build verifier checks the action
  // manifest; modern Next versions no longer accept serverActions: false.
  typescript: { tsconfigPath: "tsconfig.next.json" },
};

export default nextConfig;
