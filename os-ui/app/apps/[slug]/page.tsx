/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * `/apps/<slug>` — SAME-ORIGIN serving of a declarative AppSpec app (AppSpec Phase 3).
 *
 * A `serveMode: 'spec'` app is rendered HERE, by the trusted OS renderer, under the viewer's
 * EXISTING OS session — no per-app image / pod / CI / registry, no cross-origin. Data reads run
 * AS the OS user through the same governed `/api/*` path (canView + RLS), so a served spec app
 * needs no separate deploy to show correct, governed data.
 *
 * Access mirrors opening the app in the Software tab: the app must be VISIBLE to the viewer
 * (`getAppBySlugForUser` applies the Personal/Shared/Certified visibility gate). Anything that
 * is not a spec app (image / runtime / no spec) gets an HONEST notice, never a blank render.
 *
 * NOTE(appspec-grant-scope): a same-origin OS render runs AS the viewer and applies canView+RLS,
 * but NOT the stricter app-grant INTERSECTION (`checkAppGrant`, audit F2) that fires for
 * cross-ORIGIN app requests carrying the app slug. So a SHARED spec app currently shows a viewer
 * everything THEY can see among its sources, not a grant-narrowed subset — a minor (more-
 * permissive, never less) gap. Phase-4 hardening: carry the app slug into the same-origin data
 * reads so `checkAppGrant` applies here too. See appspec/DESIGN.md.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/core/auth';
import { getAppBySlugForUser } from '@/lib/software/apps';
import { resolveServeTarget } from '@/lib/software/served-app';
import ServedAppSpec from './ServedAppSpec';

export const dynamic = 'force-dynamic';

export default async function ServedAppPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Resolve the OS session. Middleware already redirects a signed-out navigation to /signin;
  // this is the graceful in-page fallback for an expired session, matching the OS pattern.
  const user = await currentUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(`/apps/${slug}`)}`);

  // Visibility gate — the SAME rule as opening the app in the Software tab. Not found /
  // not visible → the OS's honest 404.
  const app = await getAppBySlugForUser(slug, user);
  if (!app) {
    return (
      <div className="content">
        <div className="stub-page">
          App not found. <Link href="/software">Back to Software</Link>
        </div>
      </div>
    );
  }

  const target = resolveServeTarget(app);

  if (target.kind === 'image-elsewhere') {
    // A per-app image/runtime app is served at its OWN subdomain, not by this route.
    const url = app.subdomain ? `https://${app.subdomain}` : app.deploy.previewUrl;
    return (
      <div className="content">
        <div className="stub-page">
          <p>“{app.name}” is served at its own URL, not here.</p>
          {url ? (
            <p>
              Open it at <a href={url}>{url}</a>.
            </p>
          ) : (
            <p>It has not been deployed yet — open it from the Software tab to preview.</p>
          )}
          <p>
            <Link href="/software">Back to Software</Link>
          </p>
        </div>
      </div>
    );
  }

  if (target.kind === 'none' || !app.spec) {
    // Declared spec-mode but nothing to render yet — honest, not blank.
    return (
      <div className="content">
        <div className="stub-page">
          “{app.name}” has no spec to render yet. <Link href="/software">Open it in Software</Link> to build one.
        </div>
      </div>
    );
  }

  // Spec app: render the validated spec same-origin. Seed identity with the server-resolved
  // role so the first paint gates correctly; the client confirms via os.whoami().
  return <ServedAppSpec slug={app.slug} spec={app.spec} initialRole={user.role} />;
}
