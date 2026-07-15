/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { type LinkedArtifactInput, registerLinkedArtifact } from './sources.ts';
import { BetError, type Tab } from './model.ts';

import { getDataset } from '@/lib/data/store';
import { getDashboard } from '@/lib/dashboards/store';
import { getSystem as getAgentSystem } from '@/lib/agents/store';
import { getWorkflow } from '@/lib/knowledge/store';
import { getMetric as getMetricRecord } from '@/lib/metrics/store';
import { getFile } from '@/lib/files/store';
import { listModelsForUser } from '@/lib/science/model-service';
import { getAppForUser } from '@/lib/software/apps';
import { getConnectionForUser } from '@/lib/connections/store';

/**
 * The GOVERNED resolve of a component id → the reference card a Big Bet attaches.
 *
 * ONE place, shared by the solution write route AND the `attach_bet_component` MCP
 * tool, so both re-resolve EVERY component through its own tab's canView gate FIRST
 * (a forged/unseen id is a typed 403/404 before anything is attached — no governance
 * shortcut) and map the tier→visibility, stage→lifecycle exactly like `real-sources`
 * and the legacy `attach_component`. It registers the reference card on the bet's
 * cross-tab registry and returns it; the per-tab store stays the source of truth.
 *
 * All 9 component-bearing tabs are handled. `software` and `connection` getters are
 * async (their stores are), which is why this helper is async — the reader SEAM that
 * powers the picker's "list existing" is still synchronous, so those two are honestly
 * deferred there (see real-sources.ts), but the direct-by-id attach works for all 9.
 */
const P = (u: CurrentUser) => ({ id: u.id, domains: u.domains, role: u.role });

export async function resolveLinkedComponent(
  kind: Tab,
  id: string,
  user: CurrentUser,
): Promise<LinkedArtifactInput> {
  const artifactId = id.trim();
  if (!artifactId) throw new BetError('An artifact id is required', 400);
  const p = P(user);
  let art: LinkedArtifactInput;

  switch (kind) {
    case 'data': {
      const d = getDataset(artifactId, p); // canView guard (403/404)
      const anyBuilt = d.versions.bronze.built || d.versions.silver.built || d.versions.gold.built;
      art = {
        id: d.id, tab: 'data', title: d.name, domain: d.domain,
        visibility: d.tier === 'dataset' ? 'personal' : d.tier === 'asset' ? 'shared' : 'marketplace',
        lifecycle: d.tier !== 'dataset' ? 'certified' : anyBuilt ? 'building' : 'draft',
      };
      break;
    }
    case 'dashboard': {
      const d = getDashboard(artifactId, p);
      art = {
        id: d.id, tab: 'dashboard', title: d.spec.name, domain: d.domain,
        visibility: d.tier === 'personal' ? 'personal' : d.tier === 'domain' ? 'shared' : 'marketplace',
        lifecycle: d.tier === 'personal' ? 'draft' : 'published',
      };
      break;
    }
    case 'agent': {
      const s = getAgentSystem(artifactId, p);
      art = {
        id: s.id, tab: 'agent', title: s.name, domain: s.domain,
        visibility: s.visibility === 'Personal' ? 'personal' : s.visibility === 'Shared' ? 'shared' : 'marketplace',
        lifecycle: s.visibility === 'Personal' ? 'draft' : 'live',
      };
      break;
    }
    case 'knowledge': {
      const w = getWorkflow(artifactId, p);
      art = {
        id: w.id, tab: 'knowledge', title: w.title, domain: w.domain,
        visibility: w.visibility === 'Personal' ? 'personal' : w.visibility === 'Shared' ? 'shared' : 'marketplace',
        lifecycle: w.status === 'live' ? 'published' : 'draft',
      };
      break;
    }
    case 'metric': {
      const m = getMetricRecord(artifactId, p);
      art = {
        id: m.id, tab: 'metric', title: m.measure.name, domain: m.dataset.domain,
        visibility: m.tier === 'personal' ? 'personal' : m.tier === 'domain' ? 'shared' : 'marketplace',
        lifecycle: m.tier === 'personal' ? 'draft' : 'promoted',
      };
      break;
    }
    case 'files': {
      const v = getFile(artifactId, p);
      const a = v.asset;
      art = {
        id: a.id, tab: 'files', title: a.name, domain: a.domain,
        visibility: a.tier === 'dataset' ? 'personal' : a.tier === 'asset' ? 'shared' : 'marketplace',
        lifecycle: a.tier !== 'dataset' ? 'published' : 'draft',
      };
      break;
    }
    case 'ml': {
      // listModelsForUser is synchronous + RLS-scoped by the model tier ladder (the
      // SAME gate the picker uses); resolve by id so a non-visible model is a 404.
      const m = listModelsForUser({ id: user.id, domains: user.domains }).find((x) => x.id === artifactId);
      if (!m) throw new BetError('Model not found', 404);
      art = {
        id: m.id, tab: 'ml', title: m.name, domain: m.domain,
        visibility: m.tier === 'Personal' ? 'personal' : m.tier === 'Domain' ? 'shared' : 'marketplace',
        lifecycle: m.stage === 'Production' ? 'production' : 'staging',
      };
      break;
    }
    case 'software': {
      const a = await getAppForUser(artifactId, user); // async canView guard (403/404)
      art = {
        id: a.id, tab: 'software', title: a.name, domain: a.domain,
        visibility: a.visibility === 'Personal' ? 'personal' : a.visibility === 'Shared' ? 'shared' : 'marketplace',
        lifecycle: a.visibility === 'Personal' ? 'draft' : 'deployed',
      };
      break;
    }
    case 'connection': {
      const c = await getConnectionForUser(artifactId, user); // async canView guard (403/404)
      art = {
        id: c.id, tab: 'connection', title: c.name, domain: c.domain,
        visibility: c.visibility === 'Personal' ? 'personal' : c.visibility === 'Shared' ? 'shared' : 'marketplace',
        lifecycle: c.mode === 'untested' ? 'untested' : 'tested-governed',
      };
      break;
    }
    default:
      throw new BetError(`Cannot attach a '${kind}' component`, 400);
  }

  // Register the reference card (the per-tab store stays the source of truth).
  registerLinkedArtifact(art);
  return art;
}
