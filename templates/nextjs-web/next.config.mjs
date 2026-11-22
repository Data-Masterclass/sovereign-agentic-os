/**
 * Platform-owned build settings. `standalone` is what the platform Dockerfile runs; do not change it.
 * `images.unoptimized` keeps Next.js from using sharp (and its LGPL libvips): nothing in the app needs the
 * image optimiser, so the lockfile carries neither.
 */
const nextConfig = { output: 'standalone', poweredByHeader: false, reactStrictMode: true, images: { unoptimized: true } };
export default nextConfig;
