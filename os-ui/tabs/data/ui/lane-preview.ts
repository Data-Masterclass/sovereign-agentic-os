/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The lane table a build preview shows (Refine and GoldJoin panels)
 * USER STORY: As a builder I want the SQL preview to name the table the build really writes,
 *             so that what I review is what runs.
 * ARCHITECTURE:
 *   - Pure. Builds run in the owner's personal lane under the dataset's RECORDED lane name
 *     (`laneSlug`, store-fqn.ts); a dataset without one still uses its legacy name. Mirrors the
 *     server's transform plans (silverPlan / goldJoinPlan), which use the same rule.
 */
import { personalSchema } from '@tabs/data/lib/transform';

/** A stable, guard-compatible slug (mirrors store-fqn.slug). */
function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/** The lane slug a preview uses: the recorded one, else the legacy name slug. */
export function previewLaneSlug(d: { datasetName: string; laneSlug?: string }): string {
  return d.laneSlug ?? nameSlug(d.datasetName);
}

/** `iceberg.personal_<owner>.<layer>_<lane>` — the table a build of this layer writes or reads. */
export function previewLaneFqn(d: { owner: string; datasetName: string; laneSlug?: string }, layer: 'bronze' | 'silver' | 'gold'): string {
  return `iceberg.${personalSchema(d.owner)}.${layer}_${previewLaneSlug(d)}`;
}
