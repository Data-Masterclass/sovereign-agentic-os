/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * FEATURE: the ONE OpenSearch client of os-ui.
 * USER STORY: an operator turns on OpenSearch authentication (WP-22) by setting credentials in
 *   exactly one place; every os-ui caller — the store mirror, Files and Knowledge indexing and
 *   retrieval, the re-index runner, the Admin health probe and the pod's `wait-for-opensearch`
 *   initContainer — then sends them, and none can be missed.
 * ARCHITECTURE: every HTTP call to OpenSearch goes through `opensearchFetch` (throws on a
 *   transport failure) or `opensearchTry` (returns `null` on a transport failure or timeout,
 *   the contract the existing callers already had). The base URL is read from `OPENSEARCH_URL`
 *   HERE and nowhere else (`scripts/check-opensearch-client.mjs` fails CI on any other reader).
 *   Optional basic auth comes from `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD`; when they are
 *   unset no header is sent (the security plugin is still off until WP-22). TLS trust for a
 *   private CA is Node's own `NODE_EXTRA_CA_CERTS`, so nothing TLS-specific lives in code.
 *
 * This file has NO imports on purpose: the `wait-for-opensearch` initContainer runs it with
 * plain `node --experimental-strip-types` from the os-ui image (no Next.js, no path aliases),
 * so the initContainer and the app share this exact code path. Keep it free of `@core/*`
 * imports, enums and other non-erasable TypeScript.
 */

const DEFAULT_URL = 'http://opensearch:9200';
const DEFAULT_TIMEOUT_MS = 6000;

/** The OpenSearch base URL (no trailing slash). Read at call time, so tests can set the env. */
export function opensearchBaseUrl(): string {
  const raw = process.env.OPENSEARCH_URL;
  return (raw && raw.length > 0 ? raw : DEFAULT_URL).replace(/\/+$/, '');
}

/** Full URL for a path (`/files/_search`, `files/_search` and `` all work). */
export function opensearchRequestUrl(path = ''): string {
  if (!path) return opensearchBaseUrl();
  return `${opensearchBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The auth header, or none when no credentials are configured. Never logged. */
export function opensearchAuthHeaders(): Record<string, string> {
  const user = process.env.OPENSEARCH_USERNAME;
  const pass = process.env.OPENSEARCH_PASSWORD;
  if (!user) return {};
  return { authorization: `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` };
}

export type OpenSearchInit = RequestInit & {
  /** Abort after this many ms (default 6000). */
  timeoutMs?: number;
};

function headersOf(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * One request to OpenSearch. Throws on a transport failure or timeout (an `AbortError` for
 * the timeout), exactly as `fetch` does; an HTTP error status is returned, not thrown.
 */
export async function opensearchFetch(path: string, init: OpenSearchInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, signal, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(opensearchRequestUrl(path), {
      cache: 'no-store',
      ...rest,
      headers: { ...headersOf(headers), ...opensearchAuthHeaders() },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Like `opensearchFetch`, but `null` means "unreachable or timed out" — never "empty". */
export async function opensearchTry(path: string, init: OpenSearchInit = {}): Promise<Response | null> {
  try {
    return await opensearchFetch(path, init);
  } catch {
    return null;
  }
}

/**
 * Wait until the cluster answers `_cluster/health` (yellow or better). Used by the os-ui
 * `wait-for-opensearch` initContainer. A 401/403 is reported as a credentials problem in
 * plain words instead of looping silently (the failure class of the September 2026 login
 * outage). Resolves true when ready, false when the deadline passes.
 */
export async function waitForOpenSearch(opts: { deadlineMs?: number; intervalMs?: number; log?: (s: string) => void } = {}): Promise<boolean> {
  const { deadlineMs = 10 * 60 * 1000, intervalMs = 3000, log = (s: string) => console.log(s) } = opts;
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const r = await opensearchFetch('/_cluster/health?wait_for_status=yellow&timeout=5s', { timeoutMs: 10_000 });
      if (r.ok) {
        log('opensearch ready');
        return true;
      }
      if (r.status === 401 || r.status === 403) {
        log(`${r.status} from OpenSearch: credentials missing or wrong (OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD)`);
      } else {
        log(`opensearch not ready: HTTP ${r.status}`);
      }
    } catch (e) {
      log(`opensearch unreachable: ${(e as Error).message}`);
    }
    if (Date.now() > until) {
      log('gave up waiting for opensearch');
      return false;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
