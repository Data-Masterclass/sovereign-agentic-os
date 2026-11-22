/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The real wiring of the first role mapping: the chart seed, the old admin override, the platform repository and LiteLLM.
 * USER STORY: As an operator the first mapping appears by itself on first boot, from what my admin had chosen or from the chart.
 * ARCHITECTURE: `role-seed.ts` holds the logic. Here: the seed comes from `MODEL_ROLE_SEED_JSON` (chart
 *   `osUI.modelRoles.seed`), the old override from the settings the previous release stored (hydrated first),
 *   the file and the catalog from `liveRoleIo`. Server-only.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { getSettings, ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { liveRoleIo } from '@core/models/role-live';
import { exclusiveRoleWork } from '@core/models/role-reconcile';
import { seedRoleMapping, type SeedResult } from '@core/models/role-seed';
import { ROLE_NAMES, type RoleMapping } from '@core/models/role-mapping';
import type { GitStoreOptions } from '@core/infra/git-store';

/** The chart seed; an unparseable value is reported, never guessed at. */
export function readSeedFromConfig(raw: string = config.modelRoleSeedJson): { seed: Partial<RoleMapping> | null; error?: string } {
  if (!raw.trim()) return { seed: null };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const seed: Partial<RoleMapping> = {};
    for (const r of ROLE_NAMES) if (typeof o[r] === 'string' && (o[r] as string).trim()) seed[r] = (o[r] as string).trim();
    return { seed };
  } catch (e) {
    return { seed: null, error: `MODEL_ROLE_SEED_JSON is not valid JSON: ${(e as Error).message}` };
  }
}

export async function seedRoleMappingLive(opts: { by: string; dryRun?: boolean; git?: GitStoreOptions }): Promise<SeedResult> {
  await ensureSettingsHydrated();
  const io = liveRoleIo(opts.git);
  const { seed, error } = readSeedFromConfig();
  const r = await exclusiveRoleWork(() => seedRoleMapping({ readMapping: io.readMapping, writeMapping: io.writeMapping, catalog: io.catalog }, { seed, legacy: getSettings().modelRoles }, { by: opts.by, dryRun: opts.dryRun }));
  return error && r.state === 'incomplete' ? { ...r, error: `${error}; ${r.error ?? ''}` } : r;
}
