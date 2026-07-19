/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { Forbidden, NotAuthenticated, OsError, UnsupportedQuery } from './errors.ts';
import type {
  ContextItem,
  DatasetQuery,
  KnowledgeHit,
  MetricQuery,
  OsClientOptions,
  OsContext,
  WhoAmI,
} from './types.ts';

/**
 * `createOsClient` — the primitive that lets a governed app call BACK into the
 * Sovereign OS. It is a thin, dependency-free (native `fetch`) typed wrapper over
 * the SAME governed OS routes the OS UI itself uses. There is no new governance and
 * no bypass here: every method hits an OPA-checked, RLS/DLS-filtered route, so a
 * call only ever returns what the signed-in user is allowed to see.
 *
 * Auth is the AMBIENT OS session: requests are sent with `credentials:'include'`
 * so the `soa_session` cookie flows on same-origin (the preview case). For a
 * standalone deployed app, pass `baseUrl` to the remote OS (which must permit the
 * origin + credentialed CORS). The SDK never handles secrets or tokens itself.
 *
 * Errors are mapped honestly (see ./errors): 401 → NotAuthenticated, a governed
 * 403 → Forbidden carrying the server's reason, other non-2xx → OsError. Nothing
 * is ever faked into a success.
 */

/** Join a base URL and a route path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path; // same-origin: use the path as-is
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Append query params to a path, dropping undefined/empty values. */
export function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

export interface OsClient {
  whoami(): Promise<WhoAmI>;
  context(): Promise<OsContext>;
  datasets: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    query(id: string, q?: DatasetQuery): Promise<unknown>;
  };
  metrics: {
    list(): Promise<unknown>;
    query(id: string, q?: MetricQuery): Promise<unknown>;
  };
  knowledge: {
    search(q: string): Promise<KnowledgeHit[]>;
  };
  files: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
}

/** The five context kinds the governed available-context feed exposes. */
const CONTEXT_KINDS = ['connections', 'data', 'knowledge', 'files', 'metrics'] as const;

export function createOsClient(opts: OsClientOptions = {}): OsClient {
  const baseUrl = opts.baseUrl ?? '';
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new OsError('No fetch available: pass one via createOsClient({ fetch })', 0);
  }

  /** One governed request. Sends the ambient session cookie, maps failures to
   *  typed errors, and returns parsed JSON on success. */
  async function request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = joinUrl(baseUrl, path);
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await doFetch(url, {
        method: init?.method ?? 'GET',
        headers,
        body,
        // AMBIENT SESSION: carry the soa_session cookie (same-origin preview; and
        // cross-origin when the remote OS opts the app's origin into credentialed CORS).
        credentials: 'include',
        cache: 'no-store',
      });
    } catch (e) {
      // Network/transport failure — honest, not a fabricated empty result.
      throw new OsError(`Request to ${url} failed: ${(e as Error).message}`, 0, url);
    }

    if (!res.ok) {
      const reason = await readError(res);
      if (res.status === 401) throw new NotAuthenticated(reason || undefined, url);
      if (res.status === 403) throw new Forbidden(reason || 'access denied by policy', url);
      throw new OsError(reason || `OS request failed (${res.status})`, res.status, url);
    }

    // 2xx — parse JSON (empty body tolerated as null).
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Pull the server's `{ error }` reason out of a failed response, best-effort. */
  async function readError(res: Response): Promise<string> {
    try {
      const text = await res.text();
      if (!text) return '';
      try {
        const j = JSON.parse(text) as { error?: string; reason?: string };
        return j.error ?? j.reason ?? text;
      } catch {
        return text;
      }
    } catch {
      return '';
    }
  }

  return {
    // ── identity ──────────────────────────────────────────────────────────────
    // The OS session route. Returns { user, … } — user is null when unauthenticated
    // (this route answers 200 with user:null rather than 401, so surface it as-is).
    whoami: () => request<WhoAmI>('/api/auth/me'),

    // The app's granted/grantable context, composed CLIENT-SIDE from the existing
    // governed per-kind feed. No new route: each kind is one canView/RLS-scoped GET.
    async context(): Promise<OsContext> {
      const entries = await Promise.all(
        CONTEXT_KINDS.map(async (kind) => {
          const r = await request<{ items?: ContextItem[] }>(
            withQuery('/api/context/available', { kind }),
          );
          return [kind, r?.items ?? []] as const;
        }),
      );
      return Object.fromEntries(entries) as unknown as OsContext;
    },

    // ── datasets ──────────────────────────────────────────────────────────────
    datasets: {
      list: () => request('/api/data/datasets'),
      get: (id: string) => request(`/api/data/datasets/${encodeURIComponent(id)}`),
      /**
       * Query a dataset through the governed path:
       *  • { nl } → the governed NL→SQL surface (`/api/data/ask`) — one read-only
       *    SELECT generated + validated + run server-side under the caller's RLS.
       *  • { sql } → REFUSED locally (UnsupportedQuery): the OS never trusts raw
       *    client SQL; it recompiles SQL from validated ops server-side.
       *  • neither → a governed row preview (`SELECT * LIMIT n`) for that dataset.
       */
      async query(id: string, q: DatasetQuery = {}) {
        if (q.sql !== undefined) {
          throw new UnsupportedQuery(
            'Raw SQL is not accepted over the governed path. Use { nl } for a ' +
              'natural-language query, or omit both for a governed row preview.',
          );
        }
        if (q.nl !== undefined) {
          return request('/api/data/ask', { method: 'POST', body: { question: q.nl } });
        }
        return request(
          withQuery(
            `/api/data/datasets/${encodeURIComponent(id)}/preview`,
            { limit: q.limit },
          ),
        );
      },
    },

    // ── metrics ───────────────────────────────────────────────────────────────
    metrics: {
      list: () => request('/api/metrics'),
      /** Slice a metric via the governed explorer (per-viewer Cube RLS applies). */
      query(id: string, q: MetricQuery = {}) {
        return request('/api/metrics/explore', {
          method: 'POST',
          body: {
            metricId: id,
            dimensions: q.dimensions,
            timeDimension: q.timeDimension,
            granularity: q.granularity,
            ...(q.filters ? { filters: q.filters } : {}),
          },
        });
      },
    },

    // ── knowledge ─────────────────────────────────────────────────────────────
    knowledge: {
      /**
       * Search the governed, DLS-scoped knowledge index. The OS exposes a
       * document feed (`/api/knowledge/docs`) filtered to what the caller may see;
       * we rank it by the query client-side (the feed carries no ?q param). Every
       * doc returned is already access-checked server-side — the ranking only
       * orders what the user was allowed to receive.
       */
      async search(q: string): Promise<KnowledgeHit[]> {
        const r = await request<{ docs?: KnowledgeHit[] }>('/api/knowledge/docs');
        const docs = r?.docs ?? [];
        const query = q.trim().toLowerCase();
        if (!query) return docs;
        const terms = query.split(/\s+/).filter(Boolean);
        return docs
          .map((d) => {
            const hay = `${d.title} ${d.excerpt}`.toLowerCase();
            const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
            return { d, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.d);
      },
    },

    // ── files ─────────────────────────────────────────────────────────────────
    files: {
      list: () => request('/api/files'),
      get: (id: string) => request(`/api/files/${encodeURIComponent(id)}`),
    },
  };
}
