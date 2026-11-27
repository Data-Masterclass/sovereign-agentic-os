/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - which apps must pass the quality gates, decided from what the OS stored
 * USER STORY: As the platform owner I want "must this app pass the gates?" to be answered from the app's
 *             record, which only the platform writes, and never from a line in the author's own files.
 * ARCHITECTURE:
 *   - Key = the STORED `app.template` and `app.serveMode`. The tree's `app.yaml` `template:` line is
 *     author-controlled and is never read for this decision.
 *   - Decision of record: every app SERVED AS A CONTAINER (`serveMode: image`) requires the gates,
 *     whatever its template. A golden-path app is judged by its own template's gate set; a legacy-template
 *     container app is judged by the `nextjs-web` gate set (the only platform-owned gate set), so a legacy
 *     app that cannot pass them is BLOCKED until it moves to the golden path - blocked, not skipped.
 *   - Apps the OS serves itself (`spec`, `runtime`) run no container of the author's, so there is nothing for
 *     a sandbox to execute and no gates apply to them.
 *   - TEMPLATE VERSION (App Builder W0): `version` is the STORED `app.templateVersion` (absent ⇒ 1) of a golden-path
 *     app, so a v1 app is judged by the v1 gate files and a v2 app by the v2 ones (chart
 *     `files/tekton/platform/v<n>/`). Legacy and OS-served apps are always version 1.
 *   - PURE.
 */
import type { App } from '@tabs/software/lib/apps';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { isGoldenPath, type GoldenPathKey, type TemplateVersion } from '@tabs/software/lib/golden-path';

export type GatePolicy = { required: boolean; profile: GoldenPathKey; version: TemplateVersion; reason: string };

/** The gate set legacy container apps are held to. */
export const LEGACY_GATE_PROFILE: GoldenPathKey = 'nextjs-web';

export function gatePolicyFor(app: Pick<App, 'template' | 'serveMode' | 'templateVersion'>): GatePolicy {
  // Only the explicit 'image' serve mode is a container (an absent value normalises to 'spec', see normalizeServeMode).
  const container = app.serveMode === 'image';
  if (!container) return { required: false, profile: LEGACY_GATE_PROFILE, version: 1, reason: 'served by the OS itself: no container of the author runs, so no gates apply' };
  if (isGoldenPath(app.template)) {
    const version = templateVersionOf(app);
    return { required: true, profile: app.template, version, reason: `golden-path template '${app.template}'${version === 1 ? '' : ` v${version}`}: its own gate set` };
  }
  return {
    required: true,
    profile: LEGACY_GATE_PROFILE,
    version: 1,
    reason: `served as a container (template '${app.template}'): every container app requires the gates, judged by the '${LEGACY_GATE_PROFILE}' gate set`,
  };
}
