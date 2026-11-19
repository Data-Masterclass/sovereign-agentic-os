/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       software
 * FEATURE:    One honest deploy-status word per app, from what is really served
 * USER STORY: As an app owner I want the status badge and `get_software_status` to say
 *             "Live" only when a runner really serves my app, "Published" when my declarative
 *             app is served by the OS, and nothing about images for an app that has no image,
 *             so I never share a link to an app that is not there.
 * ARCHITECTURE:
 *   - Pure and client-safe (type-only imports), so the Software builder's badge and the MCP
 *     status card read the same rule. A `.tsx` cannot be tested; this `.ts` sibling is.
 *   - The serve mode decides what "served" means: a declarative (`spec`) app is served
 *     same-origin at `/apps/<slug>` as soon as it has a published spec — there is no image and
 *     no pod; an image app is served only once its runner reports a running pod, which is when
 *     `deploy.previewUrl` is set.
 *   - `deploy.state === 'live'` stays the record of the approval decision. It is not, on its
 *     own, a claim that anything is serving.
 */
import type { DeployState } from '@tabs/software/lib/model';

export type DeployStatusInput = {
  slug: string;
  /** The raw persisted serve mode; anything but 'image' / 'runtime' is a declarative app. */
  serveMode?: string;
  /** The published declarative spec (truthy once published). */
  spec?: unknown;
  deploy: { state: DeployState; previewUrl: string | null };
};

export type DeployStatus = {
  cls: string;
  label: string;
  /** The URL that really serves the app right now, or null. */
  servedUrl: string | null;
};

/** Mirrors `normalizeServeMode` in apps.ts (kept here so the browser need not import apps.ts). */
export function isDeclarative(app: Pick<DeployStatusInput, 'serveMode'>): boolean {
  return app.serveMode !== 'image' && app.serveMode !== 'runtime';
}

/** The same-origin URL the OS serves a declarative app at. */
export function declarativeUrl(app: Pick<DeployStatusInput, 'slug'>): string {
  return `/apps/${app.slug}`;
}

export function deployStatusOf(app: DeployStatusInput): DeployStatus {
  const state = app.deploy.state;
  if (state === 'review') return { cls: 'badge warn', label: 'In review', servedUrl: null };
  if (isDeclarative(app)) {
    return app.spec
      ? { cls: 'badge ok', label: 'Published', servedUrl: declarativeUrl(app) }
      : { cls: 'badge muted', label: 'Draft', servedUrl: null };
  }
  const served = app.deploy.previewUrl;
  if (state === 'live') {
    return served
      ? { cls: 'badge ok', label: 'Live', servedUrl: served }
      : { cls: 'badge warn', label: 'Approved · not serving yet', servedUrl: null };
  }
  if (state === 'preview') return { cls: 'badge muted', label: 'Preview', servedUrl: served };
  return { cls: 'badge muted', label: 'Draft', servedUrl: null };
}

/** The note `get_software_status` gives for a declarative app with no URL (null when served). */
export function declarativePreviewNote(app: DeployStatusInput): string | null {
  if (app.spec) return null;
  return (
    'This is a declarative app: it is served same-origin at ' + declarativeUrl(app) +
    ' as soon as it has a published spec. There is no spec yet — author one with set_app_spec ' +
    '(or scaffold it with generate_app_spec). No image is built and no runner is involved.'
  );
}
