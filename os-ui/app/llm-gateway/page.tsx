/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import type { Usage } from '@/lib/gateway-usage';

/**
 * LLM Gateway — read-only, for ALL users. Two safe surfaces over LiteLLM:
 *   • an OS-native usage panel: tenant-TOTAL requests/tokens/spend + budget used,
 *     read server-side (the master key never leaves the server, no per-user rows).
 *   • the embedded, key-free Model Hub (the public models list), framed
 *     same-origin through the /tools/litellm proxy — no admin UI, no keys, no spend
 *     per key. Strictly read-only.
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

export default function LlmGatewayPage() {
  const { data, loading, error } = useApi<{ usage: Usage }>('/api/gateway/usage');
  const usage = data?.usage;

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

        <div className="section-title">Usage this {usage?.budgetWindow ?? 'period'}</div>
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
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="hint" style={{ margin: 0 }}>
            The gateway&apos;s public model catalogue, embedded same-origin with your OS session. Read-only.
          </div>
          <a className="btn ghost" style={{ padding: '5px 12px' }} href="/tools/litellm/ui/model_hub_table" target="_blank" rel="noreferrer">
            Open ↗
          </a>
        </div>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <iframe
            src="/tools/litellm/ui/model_hub_table"
            title="LiteLLM Model Hub"
            style={{ width: '100%', height: 640, border: 0, display: 'block' }}
            sandbox="allow-same-origin allow-scripts allow-popups"
          />
        </div>
      </div>
    </>
  );
}
