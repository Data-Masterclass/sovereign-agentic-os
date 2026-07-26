/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import type { GatewayUsage } from '@/lib/monitoring/gateway-usage';

/**
 * LLM Gateway — read-only, for ALL users. Two safe surfaces over LiteLLM:
 *   • an OS-native usage panel: tenant-TOTAL requests/tokens (LiteLLM activity)
 *     plus 7-day EUR spend from the OS's own run traces — the same source and
 *     prices as Monitoring, read server-side (the master key never leaves the
 *     server, no per-user rows).
 *   • an OS-native Model Hub — the models the gateway brokers, read from
 *     `/api/gateway` (`/v1/models` server-side). No keys, no admin UI. Read-only.
 */

const fmt = new Intl.NumberFormat('en-US');
const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 600, marginTop: 6 }}>{value}</div>
      {sub ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

/**
 * 7-day tenant spend, from the SAME run traces + EUR prices Monitoring uses.
 * Honest states, never a fake 0: telemetry unreachable → "—" (unknown); runs but
 * no priced model → "—" (unpriced ≠ free); no runs → a true €0.00.
 */
function SpendCard({ usage }: { usage: GatewayUsage }) {
  const w = usage.weekly;
  let value: string;
  let sub: string;
  if (!w.telemetryOk) {
    value = '—';
    sub = 'Run telemetry unreachable — spend unknown, not €0.';
  } else if (w.runs === 0) {
    value = eur.format(0);
    sub = 'No LLM runs in the last 7 days.';
  } else if (w.spendEur == null) {
    value = '—';
    sub = `${fmt.format(w.runs)} runs, no priced model — set prices in Platform → Models.`;
  } else {
    value = eur.format(w.spendEur);
    sub =
      w.pricedRuns < w.runs
        ? `${fmt.format(w.pricedRuns)} of ${fmt.format(w.runs)} runs priced — unpriced runs are not counted as €0.`
        : `${fmt.format(w.runs)} runs · same traces and prices as Monitoring.`;
  }
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
        Spend (last 7 days)
      </div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 600, marginTop: 6 }}>{value}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {usage.budgetUsd > 0
          ? `Gateway key budget: $${usage.budgetUsd.toFixed(2)} per ${usage.budgetWindow} — enforced by LiteLLM on its own meter.`
          : 'No weekly budget set — spend caps live in Governance → Cost & Limits.'}
      </div>
    </div>
  );
}

type GatewayModel = { id: string; ownedBy: string };

export default function LlmGatewayPage() {
  const { data, loading, error } = useApi<{ usage: GatewayUsage }>('/api/gateway/usage');
  const usage = data?.usage;
  const gw = useApi<{ models: GatewayModel[]; modelsError?: string }>('/api/gateway');
  const models = gw.data?.models ?? [];

  return (
    <>
      <PageHeader title="LLM Gateway" crumb="models & usage — the read plane over LiteLLM" />
      <div className="content">
        <p className="lead">
          Every model call in the OS is brokered by one gateway. This is its read-only face:
          what the whole tenant is spending, and which models are available. No keys, no admin
          controls — usage is aggregate, never per-user.
        </p>

        {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}

        <div className="section-title">Usage</div>
        {loading && !usage ? (
          <div className="hint">Reading gateway usage…</div>
        ) : usage ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
            <StatCard
              label="Requests"
              value={usage.activity ? fmt.format(usage.activity.requests) : '—'}
              sub={usage.activity ? 'API calls, tenant total · 30 days' : 'gateway did not answer'}
            />
            <StatCard
              label="Tokens"
              value={usage.activity ? fmt.format(usage.activity.tokens) : '—'}
              sub={usage.activity ? 'prompt + completion · 30 days' : 'gateway did not answer'}
            />
            <SpendCard usage={usage} />
          </div>
        ) : (
          <div className="hint">Usage is unavailable — the usage read failed. The model list below still works.</div>
        )}

        <div className="section-title">Model Hub</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          The models this gateway brokers — every OS model call routes to one of these. Read-only.
        </div>
        {gw.loading && !models.length ? (
          <div className="hint">Loading models…</div>
        ) : models.length ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {models.map((m) => (
              <div className="card" key={m.id}>
                <div style={{ fontFamily: 'var(--font-head)', fontWeight: 600 }}>{m.id}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{m.ownedBy || 'gateway'}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="hint">{gw.data?.modelsError || 'No models registered on the gateway.'}</div>
        )}
      </div>
    </>
  );
}
