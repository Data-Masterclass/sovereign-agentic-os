/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import type { Usage } from '@/lib/monitoring/gateway-usage';

/**
 * LLM Gateway — read-only, for ALL users. Two safe surfaces over LiteLLM:
 *   • an OS-native usage panel: tenant-TOTAL requests/tokens/spend + budget used,
 *     read server-side (the master key never leaves the server, no per-user rows).
 *   • an OS-native Model Hub — the models the gateway brokers, read from
 *     `/api/gateway` (`/v1/models` server-side). No keys, no admin UI. Read-only.
 */

const fmt = new Intl.NumberFormat('en-US');

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 600, marginTop: 6 }}>{value}</div>
      {sub ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

function BudgetCard({ usage }: { usage: Usage }) {
  const hasBudget = usage.budgetUsd > 0;
  const pct = usage.pctUsed;
  const bar = pct >= 90 ? 'var(--danger, #c0392b)' : pct >= 70 ? 'var(--warn, #b8860b)' : 'var(--gold-line, #b99a54)';
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
        Budget ({usage.budgetWindow})
      </div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 600, marginTop: 6 }}>
        ${usage.spendUsd.toFixed(2)}
        {hasBudget ? <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}> / ${usage.budgetUsd.toFixed(2)}</span> : null}
      </div>
      {hasBudget ? (
        <>
          <div style={{ height: 6, borderRadius: 4, background: 'var(--border)', marginTop: 10, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: bar, transition: 'width .3s' }} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{pct}% of the {usage.budgetWindow} envelope used</div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Self-hosted models — no spend cap configured.</div>
      )}
    </div>
  );
}

type GatewayModel = { id: string; ownedBy: string };

export default function LlmGatewayPage() {
  const { data, loading, error } = useApi<{ usage: Usage }>('/api/gateway/usage');
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

        <div className="section-title">Usage (last 30 days)</div>
        {loading && !usage ? (
          <div className="hint">Reading gateway usage…</div>
        ) : usage ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
            <StatCard label="Requests" value={fmt.format(usage.requests)} sub="API calls, tenant total" />
            <StatCard label="Tokens" value={fmt.format(usage.tokens)} sub="prompt + completion" />
            <BudgetCard usage={usage} />
          </div>
        ) : (
          <div className="hint">Usage is unavailable — the gateway did not answer. The model list below still works.</div>
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
