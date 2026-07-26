/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session.ts';

/**
 * The `Principal` every tab store scopes on. Structurally identical across the
 * Data and Files stores (both `{ id; domains; role }`), so the shared server
 * boundary can produce it once and each tab re-exports its own alias.
 */
export type Principal = { id: string; domains: string[]; role: Role };

/**
 * Shared server boundary for tab routes: turn the signed-in user into the
 * `Principal` the (pure, testable) stores scope on, and fold any thrown
 * error — which carries an HTTP `status` — into a JSON response.
 *
 * The one thing tabs differ on is WHICH per-process `ensureHydrated()` runs
 * before the first read/write (Data hydrates the dataset cache, Files the file
 * cache). That is passed in as a `hydrate` hook so behavior stays EXACTLY per
 * tab while the boundary logic lives in one place.
 */
export function makeRequirePrincipal(hydrate: () => Promise<void>) {
  return async function requirePrincipal(): Promise<Principal> {
    const u = await requireUser();
    // Hydrate the tab's cache from the durable mirror once per process, before
    // any read/write — so a restarted os-ui serves the persisted records.
    // Idempotent + graceful when OpenSearch is off.
    await hydrate();
    return { id: u.id, domains: u.domains, role: u.role };
  };
}

export function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

// ---------------------------------------------------------------------------
// withRoute — the shared route wrapper (route-wrapper migration, wave 1).
// ---------------------------------------------------------------------------
//
// A tiny, non-framework boundary that hand-rolled route handlers repeated ~235×:
// (1) run the session gate, (2) optionally parse the JSON body, (3) fold any
// thrown error — which carries an HTTP `status` — into the existing JSON error
// envelope with a per-route DEFAULT status. It exists to REMOVE the duplicated
// try/catch + `fail(e)` boilerplate WITHOUT changing one byte of behavior:
// the success path is 100% the handler's; only the auth-throw and the
// unhandled-throw funnel through here, exactly as the inlined code did.
//
// ── What it deliberately does NOT do ──────────────────────────────────────
// It is NOT for routes whose error handling BRANCHES mid-handler on status
// (e.g. auth→401 but OPA→403 but downstream→502, or invalid-JSON→400 while the
// default is 502). Those routes carry irreducible per-branch semantics; keep
// them hand-rolled. `withRoute` models exactly one default status per route —
// the shape the vast majority of tab routes already have. It is also NOT for
// routes that stream, return binary, use a custom envelope (`failResponse`),
// or are intentionally UNAUTHENTICATED (cube model-sync). Leave those alone.

/**
 * The handler `withRoute` wraps. It receives the authenticated user, the parsed
 * body (only when `parse` was requested — `undefined` otherwise), the awaited
 * route params, and the raw `Request` (for `new URL(req.url).searchParams`).
 * It returns the success `NextResponse` directly — the wrapper never touches the
 * happy path, so success bodies/statuses stay byte-identical.
 *
 * The handler keeps its OWN mid-handler validation returns (e.g. a 400 for a
 * missing field). Those are explicit `return NextResponse.json(...)` short-
 * circuits and never reach the wrapper's catch — identical to the inlined code.
 */
type RouteHandler<P, B> = (args: {
  user: CurrentUser;
  body: B;
  params: P;
  req: Request;
}) => Promise<NextResponse> | NextResponse;

export type WithRouteOpts = {
  /**
   * Per-process cache warm-up, run ONCE before the gate (idempotent + graceful).
   * Mirrors the routes that call `ensureHydrated()` at the top of the handler.
   * Bundled gates (data/files `requirePrincipal`) already hydrate, so those pass
   * their store's `ensureHydrated` here instead of using the bundled gate.
   */
  hydrate?: () => Promise<void>;
  /**
   * When true, parse the JSON body with the SAME lenient default the routes use
   * (`await req.json().catch(() => ({}))`) so a missing/blank/invalid body yields
   * `{}` and the handler's own field validation produces its own 400 — matching
   * the inlined behavior exactly. Set `invalidJsonStatus` to model the STRICT
   * routes instead (see below). Defaults to false (no body read — GET routes).
   */
  parse?: boolean;
  /**
   * For the routes that hard-FAIL an unparseable body with their own status
   * (`try { body = await req.json() } catch { return 400 }`). When set AND
   * `parse` is true, an invalid JSON body short-circuits to
   * `{ error: 'Invalid JSON body' }` at this status BEFORE the handler runs.
   * Omit it to use the lenient `catch(() => ({}))` shape above.
   */
  invalidJsonStatus?: number;
  /** Message for the strict invalid-JSON 4xx. Defaults to 'Invalid JSON body'. */
  invalidJsonMessage?: string;
  /**
   * The default HTTP status for an UNTAGGED thrown error (one without a `status`).
   * A tagged error (401 from `requireUser`, a 403/404 from a store) always wins.
   * Data/Files tab routes historically default 400 (via `errorResponse`); the
   * Big Bets family defaults 500. Pass the route's real default so the error
   * envelope stays byte-identical. Defaults to 400.
   */
  defaultStatus?: number;
  /**
   * Swap the session gate. Omit → `requireUser()` (401 anon / 403 unfinished
   * setup). Pass a different guard for admin routes (`requireAdmin`) or a bundled
   * hydrate+gate (data/files `requirePrincipal` — returns the narrower store
   * `Principal`; accepted directly, no cast needed). MUST throw a status-tagged
   * error on denial so the envelope reproduces the route's auth status.
   */
  gate?: () => Promise<CurrentUser | Principal>;
};

/**
 * Wrap a route handler with the shared gate → parse → error-envelope boundary.
 *
 * PATTERN NOTE — the recipe batch agents 2-3 follow. Three before/after shapes
 * cover almost everything:
 *
 * 1) GET, no body (the single commonest shape):
 *      export const GET = withRoute(async ({ user, req }) => {
 *        const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
 *        return NextResponse.json(listX(user, { includeArchived }));
 *      }, { hydrate: ensureHydrated, defaultStatus: 500 });
 *    Replaces: `try { await ensureHydrated(); const user = await requireUser(); …
 *    } catch (e) { return fail(e); }` with `fail` defaulting 500.
 *
 * 2) POST/PATCH with a lenient body + own field validation:
 *      export const POST = withRoute(async ({ user, body, params }) => {
 *        const { id } = params;
 *        if (!isValid(body)) return NextResponse.json({ error: '…' }, { status: 400 });
 *        return NextResponse.json(doThing(id, principal(user), body));
 *      }, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
 *    Replaces `const b = await req.json().catch(() => ({}))` — `body` IS that value.
 *    Mid-handler 400s stay as explicit returns (they short-circuit the catch).
 *
 * 3) Data/Files route already on `requirePrincipal` + `errorResponse`:
 *      export const GET = withRoute(async ({ user }) =>
 *        NextResponse.json(listDatasets(user)),
 *        { gate: requirePrincipal });   // requirePrincipal hydrates + gates; default 400
 *    `user` here is the store `Principal` (structurally a CurrentUser subset).
 *
 * SKIP (leave hand-rolled, count them): any route whose catch branches on status
 * mid-handler (OPA 403 / downstream 502 / mixed invalid-JSON-vs-default), any
 * streaming/binary/custom-envelope route, and the unauthenticated cube model route.
 */
export function withRoute<P = Record<string, string>, B = unknown>(
  handler: RouteHandler<P, B>,
  opts: WithRouteOpts = {},
) {
  const defaultStatus = opts.defaultStatus ?? 400;
  const gate = opts.gate ?? requireUser;
  // NOTE: the context arg is typed REQUIRED with a required `params` — Next's
  // build-time route validation rejects a signature admitting `undefined`. The
  // body still reads it defensively (`ctx?.params`), so a direct unit-test call
  // without a context cannot crash the wrapper.
  return async function wrapped(
    req: Request,
    ctx: { params: Promise<P> },
  ): Promise<NextResponse> {
    try {
      // Warm the per-process cache once, before the gate — idempotent + graceful,
      // exactly like the routes that call `ensureHydrated()` at the top.
      if (opts.hydrate) await opts.hydrate();
      const user = (await gate()) as CurrentUser;

      let body = undefined as unknown as B;
      if (opts.parse) {
        if (opts.invalidJsonStatus !== undefined) {
          // STRICT: an unparseable body is the route's own tagged 4xx.
          try {
            body = (await req.json()) as B;
          } catch {
            return NextResponse.json(
              { error: opts.invalidJsonMessage ?? 'Invalid JSON body' },
              { status: opts.invalidJsonStatus },
            );
          }
        } else {
          // LENIENT: `await req.json().catch(() => ({}))` — the dominant shape.
          body = (await req.json().catch(() => ({}))) as B;
        }
      }

      const params = (ctx?.params ? await ctx.params : ({} as P)) as P;
      return await handler({ user, body, params, req });
    } catch (e) {
      const status = (e as { status?: number }).status ?? defaultStatus;
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
  };
}
