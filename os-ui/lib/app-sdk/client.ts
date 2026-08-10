/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { Forbidden, NotAuthenticated, OsError, UnsupportedQuery } from './errors.ts';
import type {
  AppRecord,
  ContextItem,
  DatasetQuery,
  KnowledgeHit,
  MetricQuery,
  OsClientOptions,
  OsContext,
  QueryResult,
  RecordResult,
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

/** Stringify one cell for the uniform `string[][]` grid — null/undefined → ''. */
function cell(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Normalize the `/api/data/ask` (NL) or dataset-preview response into a
 * {@link QueryResult}. BOTH already carry `columns:string[]` + `rows:string[][]`
 * at the top level on success — we forward them as-is (never reshaping the cells).
 * A failure / not-materialized answer legitimately has no rows: it becomes an
 * empty table (`[] / [] / 0`), never a fabricated one. `answer`/`sql` ride along
 * when the route returned them (the NL path does; a plain preview does not).
 */
export function normalizeGridResult(raw: unknown): QueryResult {
  const r = (raw ?? {}) as {
    columns?: unknown;
    rows?: unknown;
    rowCount?: unknown;
    answer?: unknown;
    sql?: unknown;
  };
  const columns = Array.isArray(r.columns) ? r.columns.map(cell) : [];
  const rows = Array.isArray(r.rows)
    ? r.rows.map((row) => (Array.isArray(row) ? row.map(cell) : [cell(row)]))
    : [];
  const rowCount = typeof r.rowCount === 'number' ? r.rowCount : rows.length;
  const out: QueryResult = { columns, rows, rowCount };
  if (typeof r.answer === 'string') out.answer = r.answer;
  if (typeof r.sql === 'string') out.sql = r.sql;
  return out;
}

/**
 * Normalize the `/api/metrics/explore` response into a {@link QueryResult}. The
 * explorer returns member-KEYED row OBJECTS (`rows: Record<string, unknown>[]`)
 * with NO `columns` array — so we DERIVE `columns` from the union of the rows'
 * keys (first-seen order) and flatten each object into a cell array in that order.
 * This is a lossless tabularization of the SAME values the route returned — the
 * `{ columns, rows }` claim is made TRUE, not asserted over a shape that lacks it.
 * `sql` (the drop-to SQL the route always includes) rides along.
 */
export function normalizeMetricResult(raw: unknown): QueryResult {
  const r = (raw ?? {}) as { rows?: unknown; sql?: unknown };
  const objRows: Record<string, unknown>[] = Array.isArray(r.rows)
    ? r.rows.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    : [];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of objRows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const rows = objRows.map((row) => columns.map((c) => cell(row[c])));
  const out: QueryResult = { columns, rows, rowCount: rows.length };
  if (typeof r.sql === 'string') out.sql = r.sql;
  return out;
}

export interface OsClient {
  whoami(): Promise<WhoAmI>;
  context(): Promise<OsContext>;
  datasets: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    /** Resolve to a normalized {@link QueryResult} table (`{ columns, rows, rowCount }`),
     *  whichever governed route answered — see the NORMALIZE note on the impl. */
    query(id: string, q?: DatasetQuery): Promise<QueryResult>;
  };
  metrics: {
    list(): Promise<unknown>;
    /** Resolve to a normalized {@link QueryResult} table — the explorer's member-keyed
     *  row objects are flattened into `{ columns, rows, rowCount }` honestly. */
    query(id: string, q?: MetricQuery): Promise<QueryResult>;
  };
  knowledge: {
    search(q: string): Promise<KnowledgeHit[]>;
  };
  files: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
  /**
   * The app's OWN records — the governed WRITE surface (plus reads of the same
   * store). Reads (`list`/`get`) are always-on; writes (`add`/`export`) run live
   * only when the app's Builder-APPROVED deploy envelope permits them (else the OS
   * answers 403 → `Forbidden` carrying the honest governance reason). Requires
   * `appSlug` on `createOsClient` (the scaffold sets it); without it these throw a
   * clear local error, never a mystery 404.
   */
  records: {
    list(): Promise<RecordResult>;
    add(record: AppRecord): Promise<RecordResult>;
    get(id: string): Promise<RecordResult>;
    export(): Promise<RecordResult>;
  };
}

/** The five context kinds the governed available-context feed exposes. */
const CONTEXT_KINDS = ['connections', 'data', 'knowledge', 'files', 'metrics'] as const;

export function createOsClient(opts: OsClientOptions = {}): OsClient {
  const baseUrl = opts.baseUrl ?? '';
  const appSlug = opts.appSlug ?? '';
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new OsError('No fetch available: pass one via createOsClient({ fetch })', 0);
  }

  /** The app's own records base path — requires the baked-in app slug. */
  function recordsBase(): string {
    if (!appSlug) {
      throw new OsError(
        'os.records needs the app slug: create the client with createOsClient({ appSlug }). ' +
          'The scaffold sets this from APP_SLUG; records routes are keyed by slug.',
        0,
      );
    }
    return `/api/apps/by-slug/${encodeURIComponent(appSlug)}/records`;
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

    // 2xx — parse JSON HONESTLY. When the OS base URL is empty/misconfigured the
    // request hits the app's OWN origin and nginx serves the SPA index.html (200
    // text/html) — blindly JSON.parsing that yields "Unrecognized token '<'". So
    // reject a non-JSON content-type (or an HTML-looking body) with a clear error
    // instead of a raw parse crash; the app then shows its honest signed-out /
    // "OS not configured" screen. Empty body is still tolerated as null.
    const ctype = res.headers?.get?.('content-type') ?? '';
    const text = await res.text();
    if (!text) return null as T;
    const looksHtml = /^\s*</.test(text);
    if ((ctype && !/json/i.test(ctype)) || looksHtml) {
      throw new OsError(
        'The OS returned a non-JSON response — the app is likely not pointed at the ' +
          'Sovereign OS (OS_API_URL not configured), or the OS URL is wrong. Sign in to ' +
          'the OS and check the app\'s OS base URL.',
        res.status,
        url,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OsError(`The OS returned malformed JSON from ${url}.`, res.status, url);
    }
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

    // The context this app can reach.
    //
    // • WITH an `appSlug` (the scaffold sets it) — the app's ACTUAL grants, from the
    //   app-scoped endpoint. This is the HONEST "Granted context": only what the app
    //   was granted, NOT everything the signed-in user can see. One GET, grouped by kind.
    // • WITHOUT an `appSlug` (e.g. the OS UI using the SDK) — the legacy behavior: the
    //   generic per-kind available-context feed (five canView/RLS-scoped GETs).
    async context(): Promise<OsContext> {
      const empty = (): OsContext => ({ connections: [], data: [], knowledge: [], files: [], metrics: [] });

      if (appSlug) {
        const r = await request<{
          items?: { kind: (typeof CONTEXT_KINDS)[number]; id: string; name: string; access?: string }[];
        }>(`/api/apps/by-slug/${encodeURIComponent(appSlug)}/context`);
        const out = empty();
        for (const it of r?.items ?? []) {
          if (it && (CONTEXT_KINDS as readonly string[]).includes(it.kind)) {
            out[it.kind].push({ id: it.id, name: it.name, scope: it.access });
          }
        }
        return out;
      }

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
      async query(id: string, q: DatasetQuery = {}): Promise<QueryResult> {
        if (q.sql !== undefined) {
          throw new UnsupportedQuery(
            'Raw SQL is not accepted over the governed path. Use { nl } for a ' +
              'natural-language query, or omit both for a governed row preview.',
          );
        }
        // BOTH governed dataset routes already answer with top-level columns/rows —
        // normalize (fill the empty/failed cases, carry answer/sql) into QueryResult.
        if (q.nl !== undefined) {
          return normalizeGridResult(
            await request('/api/data/ask', { method: 'POST', body: { question: q.nl } }),
          );
        }
        return normalizeGridResult(
          await request(
            withQuery(
              `/api/data/datasets/${encodeURIComponent(id)}/preview`,
              { limit: q.limit },
            ),
          ),
        );
      },
    },

    // ── metrics ───────────────────────────────────────────────────────────────
    metrics: {
      list: () => request('/api/metrics'),
      /** Slice a metric via the governed explorer (per-viewer Cube RLS applies).
       *  The explorer's member-keyed row objects are normalized into a QueryResult
       *  table (columns derived from the row keys) — see normalizeMetricResult. */
      async query(id: string, q: MetricQuery = {}): Promise<QueryResult> {
        return normalizeMetricResult(
          await request('/api/metrics/explore', {
            method: 'POST',
            body: {
              metricId: id,
              dimensions: q.dimensions,
              timeDimension: q.timeDimension,
              granularity: q.granularity,
              ...(q.filters ? { filters: q.filters } : {}),
            },
          }),
        );
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

    // ── records (the app's OWN data — the governed WRITE surface) ───────────────
    // Second door onto the SAME governed store the app's MCP tools reach. The OS
    // executes AS the signed-in user; writes are held to the app's approved deploy
    // envelope server-side (a refusal surfaces as Forbidden with the reason). Each
    // route answers `{ result }`; we return the result payload directly.
    records: {
      async list(): Promise<RecordResult> {
        const r = await request<{ result: RecordResult }>(recordsBase());
        return r.result;
      },
      async add(record: AppRecord): Promise<RecordResult> {
        const r = await request<{ result: RecordResult }>(recordsBase(), {
          method: 'POST',
          body: { record },
        });
        return r.result;
      },
      async get(id: string): Promise<RecordResult> {
        const r = await request<{ result: RecordResult }>(
          `${recordsBase()}/${encodeURIComponent(id)}`,
        );
        return r.result;
      },
      async export(): Promise<RecordResult> {
        const r = await request<{ result: RecordResult }>(`${recordsBase()}/export`, {
          method: 'POST',
          body: {},
        });
        return r.result;
      },
    },
  };
}
