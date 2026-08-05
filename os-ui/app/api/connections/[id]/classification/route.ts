/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  getMergedClassification,
  runClassification,
  overridePlacement,
  setSeed,
  patchTaxonomy,
  type SeedSource,
} from '@/lib/connections/warehouse/catalog-classification';

export const dynamic = 'force-dynamic';

/**
 * The AI CATALOG CLASSIFICATION surface for one warehouse connection
 * (lakehouse-expose-experience.md, Phase B) — the folder taxonomy + per-table placement
 * the Organize stage browses.
 *
 * GET  — the MERGED read (override ?? AI entry ?? Unsorted) for every snapshot table, plus
 *        the taxonomy, seed, last-run detail, and (when unseeded) the smart-default the
 *        chooser pre-selects. Same visibility gate as the sibling snapshot route: the
 *        caller must be able to SEE the connection.
 * POST — the admin-only mutating actions (`run` | `run-new` | `override` | `seed`); the run
 *        executes SERVER-SIDE and returns the honest run tally + detail (no streaming — the
 *        UI polls the run detail). Each action re-gates admin in the lib.
 * PATCH — the admin-only taxonomy edit (add/rename folders). Unsorted is always preserved.
 */

/** GET the merged classification (domain-visible read). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  return NextResponse.json({ classification: await getMergedClassification(params.id, user) });
}, { defaultStatus: 500 });

type ClassificationAction =
  | { action: 'run' | 'run-new' }
  | { action: 'override'; fqn: string; category: string }
  | { action: 'seed'; seed: SeedSource };

/**
 * POST an action. `run`/`run-new` classify server-side (awaited) and return the doc +
 * tally + honest detail. `override` records a permanent human move. `seed` sets the
 * taxonomy source. All admin-only (re-gated in the lib).
 */
export const POST = withRoute<{ id: string }, ClassificationAction>(async ({ user, params, body }) => {
  const action = body?.action;
  if (action === 'run' || action === 'run-new') {
    const { doc, tally } = await runClassification(params.id, user, action);
    return NextResponse.json({ classification: await getMergedClassification(params.id, user), doc, tally });
  }
  if (action === 'override') {
    const fqn = String((body as { fqn?: string }).fqn ?? '').trim();
    const category = String((body as { category?: string }).category ?? '').trim();
    if (!fqn || !category) {
      return NextResponse.json({ error: 'fqn and category are required' }, { status: 400 });
    }
    await overridePlacement(params.id, user, fqn, category);
    return NextResponse.json({ classification: await getMergedClassification(params.id, user) });
  }
  if (action === 'seed') {
    const seed = (body as { seed?: SeedSource }).seed;
    if (seed !== 'source' && seed !== 'os-domains' && seed !== 'starter' && seed !== 'empty') {
      return NextResponse.json({ error: 'seed must be source | os-domains | starter | empty' }, { status: 400 });
    }
    await setSeed(params.id, user, seed);
    return NextResponse.json({ classification: await getMergedClassification(params.id, user) });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}, { parse: true, defaultStatus: 500 });

/** PATCH the taxonomy (admin add/rename folders). */
export const PATCH = withRoute<{ id: string }, { taxonomy: unknown }>(async ({ user, params, body }) => {
  await patchTaxonomy(params.id, user, body?.taxonomy);
  return NextResponse.json({ classification: await getMergedClassification(params.id, user) });
}, { parse: true, defaultStatus: 500 });
