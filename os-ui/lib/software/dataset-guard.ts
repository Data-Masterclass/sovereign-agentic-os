/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { peekDatasetMeta } from '@/lib/data/store';
import type { App } from './apps.ts';
import type { ScaffoldFile } from './model.ts';
import {
  ungrantedDatasetRefs,
  ungrantedDatasetWarning,
  type UngrantedDatasetRef,
} from './dataset-refs.ts';

/**
 * The server-side seam of the ungranted-dataset guard (0.6.97): it composes the pure
 * scanner (`dataset-refs.ts`) with server-side dataset-NAME resolution so both the
 * COMMIT path (server.ts `commitToApp`) and the DEPLOY review path (review.ts
 * `requestDeploy`) surface the SAME, name-legible warning from one place.
 *
 * It is a WARNING, not a hard block. The scanner reads code as text and is deliberately
 * conservative, so a hard block risks a false positive rejecting a good commit (e.g. an
 * id inside a comment/example). A loud, unmissable warning at BOTH commit and deploy is
 * the safer enforcement: the reference can't ship silently, and a real
 * `Forbidden: … not granted ds_…` at runtime is pre-empted with the exact fix.
 */

/**
 * Resolve each id against the DATASET store into the EXISTS-vs-DELETED split the warning
 * needs: a present record contributes its `name`; an id that peeks to NULL is DELETED (its
 * hard-coded reference is the root of the unfixable runtime Forbidden — you can't grant a
 * dataset that's gone). A lookup ERROR fails soft to neither (treated as "exists, unnamed"
 * → grant advice with the bare id).
 *
 * NOTE (0.6.114): datasets live in `lib/data/store.ts`, NOT the artifacts registry
 * (`getArtifact` only holds knowledge/metrics/dashboards/agents/software/bigbets). Peeking
 * the artifacts registry ALWAYS returned null for a `ds_…` id, so every referenced — even
 * LIVE — dataset was falsely flagged "no longer exists (likely deleted)". `peekDatasetMeta`
 * is the unscoped existence+name peek against the real dataset store.
 */
async function resolveDatasetRefs(ids: string[]): Promise<{ names: Record<string, string>; deletedIds: string[] }> {
  const names: Record<string, string> = {};
  const deletedIds: string[] = [];
  for (const id of ids) {
    try {
      const meta = peekDatasetMeta(id);
      if (meta) {
        if (meta.name) names[id] = meta.name; // present record ⇒ EXISTS (archived counts)
      } else {
        deletedIds.push(id); // peeked to null ⇒ deleted / nonexistent
      }
    } catch {
      /* fail-soft: leave unclassified — the warning treats it as grant-advice, NOT deleted */
    }
  }
  return { names, deletedIds };
}

/** The ungranted dataset references in `files` for `app` (pure; no naming). */
export function ungrantedRefsForApp(app: App, files: ScaffoldFile[]): UngrantedDatasetRef[] {
  return ungrantedDatasetRefs(
    files,
    app.grants.data.map((g) => g.id),
  );
}

/**
 * The name-legible warning for any dataset ids `files` reference that `app` is NOT
 * granted, or '' when there are none. Used at both commit and deploy so the operator
 * sees `«Service Centers» (ds_…)`, not an opaque id.
 */
export async function ungrantedDatasetWarningForApp(app: App, files: ScaffoldFile[]): Promise<string> {
  const refs = ungrantedRefsForApp(app, files);
  if (refs.length === 0) return '';
  const resolution = await resolveDatasetRefs(refs.map((r) => r.id));
  return ungrantedDatasetWarning(refs, resolution);
}
