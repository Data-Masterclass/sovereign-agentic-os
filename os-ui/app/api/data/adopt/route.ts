/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { adoptExposedTable, type AdoptSyncInput } from '@/lib/data/adopt-connected';

export const dynamic = 'force-dynamic';

type AdoptBody = {
  exposureId?: string;
  /** The specific table (of the exposure's tables) to adopt. */
  schema?: string;
  table?: string;
  /** Dataset name (defaults to the table name). */
  name?: string;
  /** REQUIRED short description (feeds the documentation gate). */
  description?: string;
  /** SYNC-mode adoption (Phase 3): the sync config the dialog assembled (SyncPanel shape).
   *  Ignored for a live-mode exposure. */
  sync?: AdoptSyncInput;
};

/**
 * ADOPT one exposed table as a governed dataset (lakehouse-import-exposure.md, Phase 2+3).
 * The whole discipline — external-connectors flag + `domain_admin` floor, server-side
 * re-resolution of the exposure (governance NEVER trusted from the body), the required
 * description, the LIVE-vs-SYNC branch (validated sync config, connection + source PINNED to
 * the exposure, CronJob provisioned), and the `dataset_adopted` trace — lives in the shared
 * `adoptExposedTable` seam, byte-identical to the MCP `adopt_exposed_table` tool.
 */
export const POST = withRoute<Record<string, string>, AdoptBody>(async ({ user, body }) => {
  const { dataset, cron } = await adoptExposedTable(user, {
    exposureId: (body.exposureId ?? '').trim(),
    schema: (body.schema ?? '').trim(),
    table: (body.table ?? '').trim(),
    name: body.name,
    description: (body.description ?? '').trim(),
    sync: body.sync,
  });
  return NextResponse.json({ dataset, ...(cron ? { cron } : {}) }, { status: 201 });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser>, defaultStatus: 500 });
