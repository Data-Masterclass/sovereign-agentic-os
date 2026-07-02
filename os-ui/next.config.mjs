import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained production server for the Docker image (copies only the
  // runtime files + traced node_modules into .next/standalone).
  output: 'standalone',
  // Pin the file-tracing root to this app so `standalone` traces the right
  // node_modules (the repo has other lockfiles further up the tree).
  outputFileTracingRoot: __dirname,
  // The per-tab CONTEXT.md files are read at RUNTIME via fs (lib/tabs/context.ts)
  // to ground the MCP endpoints + the agentic assistant harness. Next only traces
  // files it sees statically imported, so without this the `standalone` output
  // omits them and every runtime read returns the empty-string fallback — leaving
  // assistants ungrounded (no tools/golden-path in their system prompt). Include
  // the whole folder for the routes that read it.
  outputFileTracingIncludes: {
    '/api/**/*': ['./lib/tabs/*.context.md'],
  },
  reactStrictMode: true,
  // The UI never exposes backend URLs/keys to the browser; all calls go through
  // server-side API routes. Nothing here is a NEXT_PUBLIC_* var by design.
};

export default nextConfig;
