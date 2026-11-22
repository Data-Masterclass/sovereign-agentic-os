/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The first mapping in `os/models.yml`: seeded from the chart, or migrated once from the old admin override.
 * USER STORY: As an operator upgrading to the three role names I keep the models my admin had chosen, the file
 *             is written once, a second run changes nothing, and I can see what it would do first (dry run).
 * ARCHITECTURE:
 *   - Acts ONLY when `os/models.yml` does not exist (an existing mapping is never touched, so the run is
 *     idempotent and an admin's later edit is never overwritten).
 *   - Per role, in order: the old admin override (`settings.modelRoles`: reasoning → strong, standard → worker
 *     (tools if standard is empty), embeddings → embedding) when it names a model that is in the LiteLLM
 *     catalog; else the chart seed (`osUI.modelRoles.seed`) when it is in the catalog; else (a cluster that
 *     carries its own catalog under the old names, as production does) the old name of that role when the
 *     catalog still serves it as a real model, so the role keeps meaning what it meant. A role with none
 *     is `incomplete`: nothing is invented, nothing is written. An unreadable catalog writes nothing.
 *   - A value that is not in the catalog — typically an old alias that the gateway now resolves through the
 *     role itself — is skipped and reported, never copied.
 *   - Injected IO (same shape as `RoleReconcileIo`); the real file and gateway are proven in
 *     `tabs/admin/lib/role-switch.e2e.test.ts`.
 */
import { ROLE_NAMES, DEPRECATED_ALIASES, ROLE_EMBEDDING, ROLE_STRONG, ROLE_WORKER, asRoleMapping, type RoleMapping, type RoleName } from '@core/models/role-mapping';

type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

export type SeedIo = {
  readMapping: () => Promise<RoleMapping | null>;
  writeMapping: (mapping: RoleMapping, by: { id: string; name?: string | null; email?: string | null }) => Promise<{ sha: string; changed: boolean }>;
  catalog: () => Promise<Fetched<string[]>>;
};

/** What the old `settings.modelRoles` held (an empty string means "unset"). */
export type LegacyRoles = { reasoning?: string; standard?: string; tools?: string; embeddings?: string };

export type SeedInput = { seed: Partial<RoleMapping> | null; legacy: LegacyRoles | null };

export type SeedState = 'already-mapped' | 'seeded' | 'migrated' | 'incomplete' | 'unreadable';

export type SeedResult = {
  state: SeedState;
  dryRun: boolean;
  mapping: RoleMapping | null;
  /** Where each role's model came from. */
  sources: Partial<Record<RoleName, 'legacy' | 'seed' | 'old-name'>>;
  /** Old override values that were not used, and why. */
  skipped: { role: RoleName; from: string; why: string }[];
  error?: string;
};

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function seedRoleMapping(io: SeedIo, input: SeedInput, opts: { by: string; dryRun?: boolean }): Promise<SeedResult> {
  const dryRun = opts.dryRun === true;
  const out = (state: SeedState, extra: Partial<SeedResult> = {}): SeedResult => ({ state, dryRun, mapping: null, sources: {}, skipped: [], ...extra });

  let existing: RoleMapping | null;
  try {
    existing = await io.readMapping();
  } catch (e) {
    return out('unreadable', { error: `os/models.yml: ${(e as Error).message}` });
  }
  if (existing) return out('already-mapped', { mapping: existing });

  const cat = await io.catalog();
  if (!cat.ok) return out('unreadable', { error: `LiteLLM catalog: ${cat.error}` });
  const catalog = new Set(cat.data);

  const legacy = input.legacy ?? {};
  const legacyFor: Record<RoleName, string[]> = {
    [ROLE_STRONG]: [clean(legacy.reasoning)],
    [ROLE_WORKER]: [clean(legacy.standard), clean(legacy.tools)],
    [ROLE_EMBEDDING]: [clean(legacy.embeddings)],
  };
  const picked: Partial<RoleMapping> = {};
  const sources: SeedResult['sources'] = {};
  const skipped: SeedResult['skipped'] = [];
  for (const role of ROLE_NAMES) {
    for (const value of legacyFor[role].filter(Boolean)) {
      if (catalog.has(value)) { picked[role] = value; sources[role] = 'legacy'; break; }
      skipped.push({ role, from: value, why: 'not a model in the LiteLLM catalog' });
    }
    if (picked[role]) continue;
    const s = clean(input.seed?.[role]);
    if (s && catalog.has(s)) { picked[role] = s; sources[role] = 'seed'; continue; }
    // A cluster that carries its own catalog (production does) still serves the OLD names as real models:
    // the role then keeps meaning exactly what its old name meant (the order of DEPRECATED_ALIASES).
    const old = Object.entries(DEPRECATED_ALIASES).find(([name, r]) => r === role && catalog.has(name));
    if (old) { picked[role] = old[0]; sources[role] = 'old-name'; }
  }
  const missing = ROLE_NAMES.filter((r) => !picked[r]);
  if (missing.length > 0) {
    return out('incomplete', { skipped, sources, error: `no catalog model to map ${missing.join(', ')} to (no usable old override and no chart seed in the catalog)` });
  }
  const mapping = asRoleMapping(picked);
  const state: SeedState = Object.values(sources).includes('legacy') ? 'migrated' : 'seeded';
  if (!dryRun) await io.writeMapping(mapping, { id: opts.by });
  return out(state, { mapping, sources, skipped });
}
