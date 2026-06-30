/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type BuildAdapter, ok, fail } from '../../metrics/build/adapter.ts';
import { type DashboardSpec, supersetBundle } from '../model.ts';
import { type GuestTokenRequest } from '../embed.ts';
import { type AlertRule } from '../alerts.ts';

/**
 * The LIVE Dashboard build adapters — real apply→verify against Superset (REST/MCP) +
 * the embed guest-token endpoint, behind the SAME {@link BuildAdapter} interface (reused
 * from lib/metrics/build) as the mocks. Four adapters mirror the verified surface:
 *
 *   • `superset` — import the dataset+charts bundle, VERIFY the dashboard loads;
 *   • `embed`    — mint the per-viewer guest token (RLS in the token, R3), VERIFY it
 *                  carries the viewer's RLS and a live (unexpired) ttl;
 *   • `report`   — create a scheduled report, VERIFY it is listed;
 *   • `alert`    — create a threshold alert, VERIFY it is listed.
 *
 * Pure: the Superset + embed clients are injected (fetch-backed clients in
 * live-clients.ts). A failure throws or returns falsy ⇒ ✗, never a false ✓.
 */

export interface SupersetClient {
  importBundle(name: string, bundle: string): Promise<void>;
  dashboardExists(name: string): Promise<boolean>;
  createReport(spec: { dashboard: string; cadence: string; channel: string }): Promise<string>;
  reportExists(id: string): Promise<boolean>;
  createAlert(rule: { member: string; comparator: string; threshold: number }): Promise<string>;
  alertExists(id: string): Promise<boolean>;
}

export interface EmbedClient {
  /** Mint a guest token for the request (server-signed). Returns the token + expiry. */
  mint(req: GuestTokenRequest): Promise<{ token: string; expiresInSeconds: number }>;
}

export type DashboardBuildContext = {
  spec: DashboardSpec;
  /** The guest-token request for the viewer opening the embed (built in embed.ts). */
  guestToken: GuestTokenRequest;
  /** Optional scheduled report + alert to provision alongside the dashboard. */
  report?: { cadence: string; channel: string };
  alert?: AlertRule;
  /** Filled by the adapters as they create artifacts (so verify can read ids back). */
  state: { reportId?: string; alertId?: string };
};

export type DashboardLiveDeps = { superset: SupersetClient; embed: EmbedClient };

export function makeDashboardAdapters(deps: DashboardLiveDeps): Record<string, BuildAdapter<DashboardBuildContext>> {
  const superset: BuildAdapter<DashboardBuildContext> = {
    tool: 'superset',
    async apply(ctx) {
      await deps.superset.importBundle(ctx.spec.name, supersetBundle(ctx.spec));
      return ok(`imported Superset dashboard '${ctx.spec.name}' (${ctx.spec.charts.length} chart(s))`);
    },
    async verify(ctx) {
      const exists = await deps.superset.dashboardExists(ctx.spec.name);
      if (!exists) return fail(`dashboard '${ctx.spec.name}' not found after import`);
      return ok(`dashboard '${ctx.spec.name}' loads`);
    },
  };

  const embed: BuildAdapter<DashboardBuildContext> = {
    tool: 'embed',
    async apply(ctx) {
      const minted = await deps.embed.mint(ctx.guestToken);
      if (!minted.token) return fail('guest token mint returned no token');
      if (minted.expiresInSeconds <= 0) return fail('guest token already expired');
      return ok(`minted guest token for '${ctx.guestToken.user.username}' (ttl ${minted.expiresInSeconds}s)`);
    },
    async verify(ctx) {
      // R3 verify: the token request MUST carry the viewer's RLS, never an empty filter.
      if (ctx.guestToken.rls.length === 0) return fail('guest token has no RLS clause — RLS would collapse');
      return ok(`guest token carries the viewer's RLS (${ctx.guestToken.rls.map((r) => r.clause).join('; ')})`);
    },
  };

  const report: BuildAdapter<DashboardBuildContext> = {
    tool: 'report',
    async apply(ctx) {
      if (!ctx.report) return ok('no report requested');
      ctx.state.reportId = await deps.superset.createReport({ dashboard: ctx.spec.name, cadence: ctx.report.cadence, channel: ctx.report.channel });
      return ok(`scheduled ${ctx.report.cadence} report → ${ctx.report.channel}`);
    },
    async verify(ctx) {
      if (!ctx.report) return ok('no report requested');
      const exists = ctx.state.reportId ? await deps.superset.reportExists(ctx.state.reportId) : false;
      if (!exists) return fail('scheduled report not found after creation');
      return ok('scheduled report registered');
    },
  };

  const alert: BuildAdapter<DashboardBuildContext> = {
    tool: 'alert',
    async apply(ctx) {
      if (!ctx.alert) return ok('no alert requested');
      ctx.state.alertId = await deps.superset.createAlert({ member: ctx.alert.member, comparator: ctx.alert.comparator, threshold: ctx.alert.threshold });
      return ok(`alert on '${ctx.alert.member}' ${ctx.alert.comparator} ${ctx.alert.threshold}`);
    },
    async verify(ctx) {
      if (!ctx.alert) return ok('no alert requested');
      const exists = ctx.state.alertId ? await deps.superset.alertExists(ctx.state.alertId) : false;
      if (!exists) return fail('alert not found after creation');
      return ok('alert registered');
    },
  };

  return { superset, embed, report, alert };
}
