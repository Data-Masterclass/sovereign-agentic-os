/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Auto-Gold decision — the pure rule behind the simplified Data Edit surface.
 *
 * With the Gold UI removed from an ingested dataset's Edit (no "Bring to Gold" section,
 * no manual "Pass through Gold" button), an ingested dataset must STILL materialize
 * `gold_<slug>` — metrics and dashboards require a built Gold (lib/data/metrics.ts
 * metricSqlReady). So after a successful INGEST (bronze) build AND after every
 * successful Transformation (silver) build on an ingested (origin ≠ curated) dataset,
 * the UI automatically fires the SAME governed pass-through Gold build the old manual
 * button used (POST /version {layer:'gold', passThrough:true}). This module is only the
 * pure yes/no decision — the network call + its honest BuildResultDialog stay in the
 * component, so this stays trivially testable.
 *
 * A CURATED dataset is excluded: it never had a pass-through button — its Gold is the
 * explicit Compose build, so auto-firing a pass-through would be wrong (there is no
 * own-Silver to carry, and it would clobber the composed definition).
 */

/** The minimal shape the decision reads — mirrors DataBuilder's Dataset. */
export type AutoGoldInput = {
  origin?: 'ingest' | 'curated' | 'connected';
  versions: {
    bronze: { built: boolean; updatedAt: string | null };
    silver: { built: boolean; updatedAt: string | null };
    gold: { built: boolean; updatedAt: string | null };
  };
};

/**
 * Should the UI auto-trigger a pass-through Gold after a `just` build committed?
 *
 * True only when:
 *   • the dataset is INGESTED (origin ≠ curated) — curated composes its own Gold, and
 *   • a lower layer exists to carry forward (bronze for a bronze build; silver for a
 *     silver build — the pass-through resolver picks the newest real source), and
 *   • Gold is not ALREADY current — i.e. Gold is unbuilt, or the layer we just built is
 *     newer than the existing Gold (a stale Gold that needs catching up). This keeps the
 *     trigger idempotent: re-opening a fully-built dataset never re-fires a redundant copy.
 */
export function shouldAutoGold(d: AutoGoldInput, just: 'bronze' | 'silver'): boolean {
  // A connected dataset never auto-materializes a UI pass-through Gold: a LIVE one is an
  // external table (no medallion build), and a SYNC one has its Gold LANDED DIRECTLY by the
  // sync engine (`iceberg.<domain>.gold_<slug>`, earned `versions.gold.built`) — there is no
  // bronze/silver to carry forward. A curated dataset composes its own Gold. The synced
  // Gold copy is still registered for Cube handover through the NORMAL governed path
  // (`cubeDeliverable` = governed tier + built Gold, `metricCubeReady`) — it needs no
  // pass-through here. So all connected/curated origins stay out of this UI trigger.
  if (d.origin === 'curated' || d.origin === 'connected') return false;
  const v = d.versions;
  // The layer we just built must actually be present (the caller only fires on ✓, but be
  // defensive — a decision on an absent source would 400 at the route).
  if (just === 'silver' && !v.silver.built) return false;
  if (just === 'bronze' && !v.bronze.built) return false;
  // Gold not built yet → always materialize it.
  if (!v.gold.built) return true;
  // Gold exists → only refresh when the layer we just built is strictly newer than Gold
  // (honest staleness, same comparison staleVsBronze uses). Missing timestamps are treated
  // as "not newer" so we never re-fire a redundant pass-through on a clean re-open.
  const built = v[just].updatedAt;
  const gold = v.gold.updatedAt;
  return Boolean(built && gold && built > gold);
}
