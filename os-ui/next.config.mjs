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
  reactStrictMode: true,
  // The UI never exposes backend URLs/keys to the browser; all calls go through
  // server-side API routes. Nothing here is a NEXT_PUBLIC_* var by design.
};

export default nextConfig;
