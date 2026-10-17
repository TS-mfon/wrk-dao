/**
 * Next configuration.
 *
 * `output: "standalone"` so the Vercel build and `next start` behave the same way locally,
 * and so leaf-1.5.1's gates can boot the real built app rather than a dev server.
 *
 * Agent REST routes run in the Vercel Node runtime at `/api`; browser pages remain
 * read-only server components and never expose operator signing keys or write actions.
 */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser UI defines no server actions. Agent writes use the authenticated REST API.
  typescript: { tsconfigPath: "tsconfig.next.json" },
};

export default nextConfig;
