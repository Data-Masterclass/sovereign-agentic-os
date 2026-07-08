/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type BuildAdapter } from '../../metrics/build/adapter.ts';
import {
  type DashboardBuildContext,
  type DashboardLiveDeps,
  type EmbedClient,
  type SupersetClient,
  makeDashboardAdapters,
} from './live.ts';
import { GUEST_TOKEN_TTL_SECONDS } from '../embed.ts';

/**
 * The honest OFFLINE-MOCK Superset + embed backends. Real in-process clients — `apply`
 * records state, `verify` reads it back — so the SAME adapter logic runs against them: a
 * dashboard only "loads" if it was actually imported; a report/alert only "exists" if it
 * was actually created. The mock embed signer mints a token only for a request that
 * carries RLS, so the R3 verify is a real check.
 */

export type DashboardMockBackend = { dashboards: Set<string>; reports: Set<string>; alerts: Set<string>; minted: number };

export function newDashboardMock(): DashboardMockBackend {
  return { dashboards: new Set(), reports: new Set(), alerts: new Set(), minted: 0 };
}

function mockSuperset(b: DashboardMockBackend): SupersetClient {
  let seq = 0;
  return {
    async importBundle(name) { b.dashboards.add(name); },
    async dashboardExists(name) { return b.dashboards.has(name); },
    async deleteDashboard(name) { return b.dashboards.delete(name); },
    async createReport(spec) { const id = `rep_${++seq}_${spec.dashboard}`; b.reports.add(id); return id; },
    async reportExists(id) { return b.reports.has(id); },
    async createAlert(rule) { const id = `alt_${++seq}_${rule.member}`; b.alerts.add(id); return id; },
    async alertExists(id) { return b.alerts.has(id); },
  };
}

function mockEmbed(b: DashboardMockBackend): EmbedClient {
  return {
    async mint(req) {
      if (req.rls.length === 0) throw new Error('refusing to mint an unscoped guest token (RLS would collapse)');
      b.minted++;
      return { token: `guest.${req.user.username}.${req.resourceId}`, expiresInSeconds: req.ttlSeconds || GUEST_TOKEN_TTL_SECONDS };
    },
  };
}

export function mockDashboardDeps(b: DashboardMockBackend): DashboardLiveDeps {
  return { superset: mockSuperset(b), embed: mockEmbed(b) };
}

export function makeMockDashboardAdapters(b: DashboardMockBackend): Record<string, BuildAdapter<DashboardBuildContext>> {
  return makeDashboardAdapters(mockDashboardDeps(b));
}
