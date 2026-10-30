/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GatewayPanel — what LiteLLM currently holds, shown inside the OS.
 *
 * FEATURE:
 *   • Four variants over ONE endpoint (`/api/platform-admin/gateway`), so the
 *     same mirror renders as gateway health on the Admin overview, budgets on
 *     Domains, spend on Billing and component health on Components.
 *   • Honest empty and failure states: a stale mirror is dated and labelled,
 *     an unreadable gateway says so, and spend that cannot be attributed is
 *     reported as not attributed rather than as zero.
 *   • Drift is always visible: anything in LiteLLM with no OS counterpart is
 *     named, with the reminder that the OS will not adopt it on its own.
 *
 * USER STORY:
 *   • As a platform admin, I see at a glance how many models the gateway
 *     brokers, which are failing their health probe, and which guardrails run.
 *   • As a platform admin on Domains, I see the real budget and real spend per
 *     domain from LiteLLM, not an OS guess.
 *   • As a platform admin, when something was created directly in LiteLLM I am
 *     told, so I can either adopt it in the OS or remove it there.
 *
 * ARCHITECTURE:
 *   A thin client component. It owns no state beyond the fetch and performs no
 *   mapping — every rule (drift, health, provider, attribution) already ran in
 *   `gateway-mirror` on the server, which is what keeps those rules testable.
 *   Read-only in this phase: there is deliberately no control here that writes
 *   to LiteLLM. Admins who need to change the gateway use Admin -> LLM Gateway,
 *   which frames LiteLLM's own UI.
 */
'use client';

import { useApi } from '@core/ui/useApi';
import type { GatewayMirror } from '@tabs/admin/lib/gateway-mirror';

export type GatewayPanelVariant = 'overview' | 'budgets' | 'spend' | 'health';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const num = new Intl.NumberFormat('en-US');

const TITLES: Record<GatewayPanelVariant, string> = {
  overview: 'Model gateway',
  budgets: 'Budgets in the gateway',
  spend: 'Gateway spend',
  health: 'LiteLLM gateway',
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 24, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub ? <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>{children}</div>
);

/** Sum a spend dimension; `null` when the dimension carries nothing at all. */
function total(by: Record<string, number>): number | null {
  const vals = Object.values(by);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

/** Drift, named. Never silently reconciled. */
function Unmanaged({ rows }: { rows: GatewayMirror['unmanaged'] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line, rgba(128,128,128,.25))' }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{rows.length} unmanaged in LiteLLM</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        Created directly in the gateway with no OS counterpart. The OS lists these and changes nothing.
      </div>
      <ul className="muted" style={{ fontSize: 12, margin: '8px 0 0', paddingLeft: 18 }}>
        {rows.slice(0, 8).map((u) => <li key={`${u.kind}:${u.id}`}>{u.kind} · {u.id}</li>)}
        {rows.length > 8 ? <li>and {rows.length - 8} more</li> : null}
      </ul>
    </div>
  );
}

function Body({ variant, m }: { variant: GatewayPanelVariant; m: GatewayMirror }) {
  const unhealthy = m.models.filter((x) => !x.healthy);

  if (variant === 'budgets') {
    const withBudget = m.teams.filter((t) => t.maxBudget != null);
    if (m.teams.length === 0) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No teams in the gateway yet. A domain gets a budget once it has a LiteLLM team.</p>;
    return (
      <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr className="muted" style={{ textAlign: 'left' }}>
                <th style={{ padding: '4px 8px 4px 0', fontWeight: 500 }}>Domain / team</th>
                <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>Budget</th>
                <th style={{ padding: '4px 0 4px 8px', fontWeight: 500, textAlign: 'right' }}>Spent</th>
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
              {m.teams.map((t) => (
                <tr key={t.teamId}>
                  <td style={{ padding: '4px 8px 4px 0' }}>{t.alias || t.teamId}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.maxBudget == null ? <span className="muted">no cap</span> : usd.format(t.maxBudget)}</td>
                  <td style={{ padding: '4px 0 4px 8px', textAlign: 'right' }}>{usd.format(t.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {withBudget.length} of {m.teams.length} teams have a cap. Set caps in Admin → LLM Gateway; the gateway enforces them.
        </div>
      </>
    );
  }

  if (variant === 'spend') {
    const byDomain = total(m.spend.byDomain);
    const byUser = total(m.spend.byUser);
    const teamSpend = m.teams.reduce((a, t) => a + t.spend, 0);
    return (
      <>
        <Row>
          <Stat label="Spend on teams" value={usd.format(teamSpend)} sub={`${m.teams.length} teams · gateway ledger`} />
          <Stat
            label="Attributed to domains"
            value={byDomain == null ? '—' : usd.format(byDomain)}
            sub={byDomain == null ? 'No tagged requests yet — untagged spend is not guessed at.' : `${num.format(Object.keys(m.spend.byDomain).length)} domains tagged`}
          />
          <Stat
            label="Attributed to users"
            value={byUser == null ? '—' : usd.format(byUser)}
            sub={byUser == null ? 'Per-user spend not reported by the gateway.' : `${num.format(Object.keys(m.spend.byUser).length)} users`}
          />
        </Row>
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Amounts are LiteLLM&apos;s own ledger in USD. Monitoring prices OS run traces separately in EUR; the two answer different questions.
        </div>
      </>
    );
  }

  if (variant === 'health') {
    return (
      <>
        <Row>
          <Stat label="Models" value={num.format(m.models.length)} sub={`${num.format(new Set(m.models.map((x) => x.provider)).size)} providers`} />
          <Stat label="Failing health probe" value={num.format(unhealthy.length)} sub={unhealthy.length === 0 ? 'All deployments answering.' : unhealthy.slice(0, 3).map((x) => x.id).join(', ')} />
          <Stat label="Guardrails" value={num.format(m.guardrails.length)} sub={m.guardrails.length === 0 ? 'None configured.' : m.guardrails.map((g) => g.provider).join(', ')} />
        </Row>
        {m.guardrails.some((g) => g.failOpen) ? (
          <div style={{ fontSize: 12, marginTop: 12 }}>
            {m.guardrails.filter((g) => g.failOpen).map((g) => g.name).join(', ')} run fail-open: if the scanner errors the request still goes through.
          </div>
        ) : null}
      </>
    );
  }

  // overview
  const blocked = m.keys.filter((k) => k.blocked);
  return (
    <>
      <Row>
        <Stat label="Models brokered" value={num.format(m.models.length)} sub={unhealthy.length > 0 ? `${num.format(unhealthy.length)} failing health probe` : 'All answering.'} />
        <Stat label="Teams" value={num.format(m.teams.length)} sub={`${num.format(m.teams.filter((t) => t.maxBudget != null).length)} with a budget cap`} />
        <Stat label="Keys" value={num.format(m.keys.length)} sub={blocked.length > 0 ? `${num.format(blocked.length)} blocked` : 'None blocked.'} />
        <Stat label="Guardrails" value={num.format(m.guardrails.length)} sub={m.guardrails.length === 0 ? 'None configured.' : 'At the gateway edge.'} />
      </Row>
      <Unmanaged rows={m.unmanaged} />
    </>
  );
}

/**
 * One panel over the gateway mirror. `variant` picks what this page needs; the
 * data, the gate and every rule are shared.
 */
export default function GatewayPanel({ variant = 'overview' }: { variant?: GatewayPanelVariant }) {
  const { data, loading, error } = useApi<GatewayMirror>('/api/platform-admin/gateway');

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ fontFamily: 'var(--font-head)', fontSize: 16, margin: 0 }}>{TITLES[variant]}</h2>
        {/* No "Open LiteLLM" link: it pointed at the proxy root, which upstream is
            LiteLLM's Swagger page, not its console. Restore it as
            /tools/litellm/ui once the proxy prefix fix is verified in production. */}
      </div>

      {loading ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Reading the gateway…</p> : null}
      {error ? <p style={{ fontSize: 13, margin: 0 }}>Could not read the gateway mirror: {error}</p> : null}

      {data ? (
        <>
          {data.degraded ? (
            <p style={{ fontSize: 13, margin: '0 0 12px' }}>
              Gateway unreachable.{' '}
              {data.fetchedAt > 0 && data.models.length > 0
                ? `Showing the last good read from ${new Date(data.fetchedAt).toLocaleTimeString()}.`
                : 'No cached read to show — this is not an empty gateway.'}
            </p>
          ) : null}
          <Body variant={variant} m={data} />
        </>
      ) : null}
    </section>
  );
}
