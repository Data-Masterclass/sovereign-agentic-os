/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Public shapes for the OS client. These are intentionally SHALLOW: the SDK
 * forwards the governed routes' JSON as-is (typed `unknown` payloads where the
 * server shape is rich and tab-specific), only naming the fields an app reliably
 * needs. This keeps the SDK a thin, honest pass-through — it never reshapes or
 * invents data — while staying tree-shakeable and dependency-free.
 */

/** Options for `createOsClient`. */
export interface OsClientOptions {
  /**
   * Base URL of the Sovereign OS. Defaults to same-origin (''), which is correct
   * inside the OS preview where the app is served from the OS itself and the
   * session cookie flows automatically. Set it for a standalone deployed app that
   * calls back into a remote OS (that OS must allow the origin + credentialed CORS).
   */
  baseUrl?: string;
  /**
   * The app's frozen slug (the `APP_SLUG` the scaffold bakes in). Required ONLY for
   * `os.records.*` — the app's own records routes are keyed by slug (the deployed app
   * never knows the OS app id). The scaffold passes it; omit it and `os.records.*`
   * throw a clear local error instead of hitting a mystery 404. Reads/knowledge/etc.
   * do not need it.
   */
  appSlug?: string;
  /**
   * fetch implementation. Defaults to the ambient global `fetch`. Injectable so the
   * SDK is testable (stub it) and portable (pass a polyfill in exotic runtimes).
   */
  fetch?: typeof fetch;
}

/**
 * One of the app's OWN records. The app defines its own schema (its committed
 * `/records` OpenAPI), so this is an open shape — the SDK is an honest pass-through,
 * never reshaping or inventing fields.
 */
export type AppRecord = Record<string, unknown>;

/**
 * A record-op result. The OS labels every result with its SOURCE so an app can be
 * honest in its UI: `'live-app'` (proxied to the deployed app's real service) or
 * `'demo-seed'` (deterministic seed with a `note`, when the app runner is not live).
 * The remaining fields are the app's own payload, passed through unchanged.
 */
export interface RecordResult {
  /** `'live-app'` when the deployed app answered; `'demo-seed'` when it is not live. */
  source: 'live-app' | 'demo-seed';
  /** Present on a demo-seed result — the honest "this is illustrative data" note. */
  note?: string;
  /** Anything else the app's endpoint returned (items/item/added/file/… ), unshaped. */
  [k: string]: unknown;
}

/** The signed-in principal, from the OS session route (`/api/auth/me`). */
export interface WhoAmI {
  user: {
    id: string;
    username?: string;
    role?: string;
    domains?: string[];
    [k: string]: unknown;
  } | null;
  [k: string]: unknown;
}

/** One artifact the app has been granted (or could be granted) in a context kind. */
export interface ContextItem {
  id: string;
  name: string;
  scope?: string;
  folder?: string;
}

/**
 * The app's granted/grantable context, composed from the governed per-kind feed
 * (`/api/context/available?kind=…`). Each kind lists only what the caller may see
 * under canView/RLS — so this is the honest "what this app can reach" surface.
 */
export interface OsContext {
  connections: ContextItem[];
  data: ContextItem[];
  knowledge: ContextItem[];
  files: ContextItem[];
  metrics: ContextItem[];
}

/** A knowledge search hit (from the DLS-scoped knowledge docs feed). */
export interface KnowledgeHit {
  id: string;
  title: string;
  excerpt: string;
  source: string;
  ingestedAt: string | null;
}

/**
 * A tabular query result — the ONE honest shape `os.datasets.query` and
 * `os.metrics.query` resolve to, regardless of which governed route answered.
 *
 * The three routes DIVERGE at the wire: `/api/data/ask` and the dataset preview
 * already carry `columns:string[]` + `rows:string[][]`; the metrics explorer
 * (`/api/metrics/explore`) returns member-KEYED row OBJECTS with no `columns`
 * array. So the SDK client NORMALIZES each response into this common table — a
 * lossless reshape of what the route actually returned, never a fabricated field:
 *   • `columns` — the column names, in order (for metrics, derived from the row
 *     objects' keys; an empty-row / not-materialized answer yields `[]`).
 *   • `rows` — the cell matrix, one array per row aligned to `columns` (metric row
 *     objects are flattened into this order; every cell stringified for a uniform grid).
 *   • `rowCount` — the row total the route reported (or `rows.length` when it did not).
 * The NL path additionally surfaces the grounded `answer` and the executed `sql`
 * when the route returned them (both optional — a preview/metric slice has no `answer`).
 *
 * Read a single scalar honestly with `Number(r.rows?.[0]?.[0] ?? 0)` — no cast needed.
 */
export interface QueryResult {
  /** Column names, in order. `[]` for a no-rows / not-yet-materialized answer. */
  columns: string[];
  /** The cell matrix — one array per row, aligned to `columns`. `[]` when empty. */
  rows: string[][];
  /** The row total (the route's `rowCount`, else `rows.length`). */
  rowCount: number;
  /** NL path only: the grounded natural-language answer, when the route returned one. */
  answer?: string;
  /** NL / metric paths: the SQL the OS actually executed, when the route returned it. */
  sql?: string;
}

/** How to query a dataset. Exactly one of `nl` (natural language → governed
 *  NL→SQL) — or neither, for a governed row preview. Raw `sql` is intentionally
 *  refused (the OS never trusts client SQL); see UnsupportedQuery. */
export interface DatasetQuery {
  /** A natural-language question — routed through the governed NL→SQL surface. */
  nl?: string;
  /** Raw SQL — NOT supported by the OS's governed path; throws UnsupportedQuery. */
  sql?: string;
  /** Optional row cap for the no-argument governed preview path. */
  limit?: number;
}

/** How to query a metric — a slice, no SQL (mirrors the governed explorer). */
export interface MetricQuery {
  dimensions?: string[];
  /** Reserved for parity with the spec; the governed explorer slices by dimension
   *  + time. Passed through when present so a future filter param is honoured. */
  filters?: Record<string, unknown>;
  timeDimension?: string;
  granularity?: string;
}
