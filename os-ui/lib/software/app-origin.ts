/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { isAllowedAppOrigin } from '@/lib/core/cors';
import { getAppBySlugInternal } from '@/lib/software/apps';
import { isGranted, type ContextKind } from '@/lib/core/context-grants';

/**
 * LEAST-PRIVILEGE for APP ORIGINS. Generated apps run under the user's ambient
 * `soa_session`, so without this a deployed app could read ANY artifact the
 * signed-in USER can see — regardless of what the app was granted. These helpers
 * cap an app's data plane at (user access ∩ app grants): the governed route still
 * enforces the user's own canView/RLS; this only ever DENIES artifacts the app was
 * not granted. It never widens access.
 *
 * A request is attributed to an app two ways, both reusing the SAME source of truth
 * middleware/CORS use (`isAllowedAppOrigin` + `config.appsBaseDomain`):
 *   • CROSS-ORIGIN deployed app — `Origin` (fallback `Referer`) is a host under the
 *     apps domain: `<slug>.<domain>.<appsDomain>` → the FIRST label is the slug.
 *   • SAME-ORIGIN runtime-served app — no app Origin, but the `Referer` path is
 *     `/api/apps/runtime/<slug>` (the Phase-D no-image runtime). Best-effort: this
 *     path must NEVER weaken the non-app case (an OS-UI request carries neither).
 *
 * Cheap by design: when the request is not from an app origin, `appSlugFromRequest`
 * returns null WITHOUT any I/O, so the OS-UI's own reads are completely unaffected.
 */

/** The OS host — a same-origin `Origin` that is the OS itself is NOT an app. */
function osHost(): string {
  const raw = (config.osPublicUrl ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The apps base domain, normalised the same way `isAllowedAppOrigin` normalises it. */
function appsDomain(): string {
  return (config.appsBaseDomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Parse an app HOST (`<slug>.<domain>.<appsDomain>`) into the app's frozen slug —
 * the FIRST label — or null when the host is the OS itself, the bare apps domain,
 * or otherwise not a per-app subdomain.
 */
function slugFromAppHost(host: string): string | null {
  const h = host.toLowerCase();
  const apps = appsDomain();
  if (!apps) return null;
  if (h === osHost()) return null; // the OS's own origin is not an app
  if (h === apps) return null; // the bare apps domain is not a per-app host
  if (!h.endsWith(`.${apps}`)) return null;
  const label = h.slice(0, h.length - apps.length - 1); // strip ".<appsDomain>"
  const first = label.split('.')[0] ?? '';
  return first || null;
}

/** The `/api/apps/runtime/<slug>` slug from a same-origin runtime referer, or null. */
function slugFromRuntimeReferer(referer: string): string | null {
  try {
    const path = new URL(referer).pathname;
    const m = /^\/api\/apps\/runtime\/([^/?#]+)/.exec(path);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The app slug this request should be attributed to, or null when it is NOT from an
 * app (the OS UI itself, or any same-origin OS surface). Reads only the `Origin` and
 * `Referer` headers — no store I/O — so it is free on the non-app path.
 */
export function appSlugFromRequest(req: Request): string | null {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  // A recognised CROSS-ORIGIN app origin (the deployed-app case). We only trust an
  // Origin/Referer that isAllowedAppOrigin already vetted (host under the apps domain
  // or the OS host) — never an arbitrary attacker-supplied header.
  for (const raw of [origin, referer]) {
    if (!raw) continue;
    if (!isAllowedAppOrigin(raw, config.osPublicUrl, config.appsBaseDomain)) continue;
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    const slug = slugFromAppHost(host);
    if (slug) return slug;
    // Vetted OS-host origin (or bare apps domain): fall through to the runtime path.
    break;
  }

  // SAME-ORIGIN runtime-served app: no app Origin, but the referer PATH names the app.
  if (referer) {
    const slug = slugFromRuntimeReferer(referer);
    if (slug) return slug;
  }

  return null;
}

/** The outcome of an app-grant check — `allowed` plus an honest, actionable reason. */
export type AppGrantCheck = { allowed: boolean; reason: string };

/**
 * The honest, actionable denial message naming the app + the artifact and pointing at
 * the Software tab grant flow. Shared by the single-artifact check and the route 403s.
 */
export function appGrantDenial(slug: string, kind: ContextKind, artifactId: string): string {
  const noun =
    kind === 'data' ? 'dataset' :
    kind === 'metrics' ? 'metric' :
    kind === 'knowledge' ? 'knowledge item' :
    kind === 'files' ? 'file' : 'connection';
  return (
    `This app (${slug}) is not granted ${noun} ${artifactId}. ` +
    `Grant it in the OS Software tab → ${slug} → Context.`
  );
}

/**
 * Whether an APP-ORIGIN request may read a specific artifact: allowed iff the id is in
 * the app's grants for `kind`. Fails CLOSED for app origins — an unknown slug (an app
 * origin whose app no longer exists) is denied. The governed route decides the user's
 * own access; this is only the app-grant intersection.
 */
export async function checkAppGrant(
  slug: string,
  kind: ContextKind,
  artifactId: string,
): Promise<AppGrantCheck> {
  const app = await getAppBySlugInternal(slug);
  if (!app) {
    return {
      allowed: false,
      reason:
        `The app origin "${slug}" is not a known app in this OS, so its data plane is ` +
        `denied. If this app was deleted, redeploy it or remove its origin.`,
    };
  }
  if (isGranted(app.grants, kind, artifactId)) return { allowed: true, reason: '' };
  return { allowed: false, reason: appGrantDenial(slug, kind, artifactId) };
}

/**
 * FILTER a set of artifact ids to those the app is granted for `kind` — the list-route
 * behavior (narrow, do not 403). An unknown slug yields the empty set (fail closed).
 * Returns a Set for O(1) membership tests by the caller when trimming rich rows.
 */
export async function grantedIdSet(slug: string, kind: ContextKind): Promise<Set<string>> {
  const app = await getAppBySlugInternal(slug);
  if (!app) return new Set();
  return new Set(app.grants[kind].map((g) => g.id));
}
