/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type DelegatedToken } from '../../data/identity.ts';
import { type BuildRow, runAdapter } from '../../metrics/build/adapter.ts';
import { type DashboardSpec } from '../model.ts';
import { guestTokenRequest } from '../embed.ts';
import { type AlertRule } from '../alerts.ts';
import { type DashboardBuildContext, makeDashboardAdapters } from './live.ts';
import { makeMockDashboardAdapters, mockDashboardDeps, newDashboardMock } from './mocks.ts';
import { makeRealDashboardClients, liveDashboardsReachable } from './live-clients.ts';

/**
 * Server boundary for a Dashboard build (mirrors lib/data/build/server.ts). It builds the
 * per-viewer guest-token request (RLS in the token, R3) from the delegated token, then
 * runs the superset/embed/report/alert adapters against LIVE Superset when reachable, or
 * the honest offline-MOCK otherwise — labelled either way. Same adapter logic both
 * paths, so a ✓ is a real apply+verify.
 */

export type BuildMode = 'live' | 'offline-mock';
export type DashboardBuildReport = { rows: BuildRow[]; ok: boolean; mode: BuildMode };

export async function buildDashboard(
  spec: DashboardSpec,
  token: DelegatedToken,
  dashboardId: string,
  opts: { report?: { cadence: string; channel: string }; alert?: AlertRule } = {},
): Promise<DashboardBuildReport> {
  const ctx: DashboardBuildContext = {
    spec,
    guestToken: guestTokenRequest(token, dashboardId), // R3 — viewer's RLS in the request
    report: opts.report,
    alert: opts.alert,
    state: {},
  };
  const adapters = (await liveDashboardsReachable())
    ? { set: makeDashboardAdapters(makeRealDashboardClients()), mode: 'live' as const }
    : { set: makeMockDashboardAdapters(newDashboardMock()), mode: 'offline-mock' as const };
  const rows: BuildRow[] = [];
  for (const tool of ['superset', 'embed', 'report', 'alert']) {
    rows.push(await runAdapter(adapters.set[tool], ctx));
  }
  return { rows, ok: rows.every((r) => r.status === 'ok'), mode: adapters.mode };
}

/**
 * Tiles → double-click → embed: mint the viewer's guest token for an existing dashboard.
 * The guest-token REQUEST (which carries the RLS, R3) is built here regardless of mode;
 * the live signer/offline-mock returns the token. Returns the request too so the route
 * can hand the Embedded SDK the resource + ttl.
 */
export async function mintEmbed(token: DelegatedToken, dashboardId: string): Promise<{
  request: ReturnType<typeof guestTokenRequest>;
  token: string;
  expiresInSeconds: number;
  mode: BuildMode;
}> {
  const request = guestTokenRequest(token, dashboardId);
  if (await liveDashboardsReachable()) {
    const minted = await makeRealDashboardClients().embed.mint(request);
    return { request, ...minted, mode: 'live' };
  }
  const minted = await mockDashboardDeps(newDashboardMock()).embed.mint(request);
  return { request, ...minted, mode: 'offline-mock' };
}
