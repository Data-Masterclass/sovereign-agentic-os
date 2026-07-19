/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';

/**
 * Data Quality — the read-only tenant/domain rollup on the Monitoring tab (§5.2).
 *
 * Datasets ranked by risk (health · open failures · freshness); the few that need a human
 * lead, greens recede. Scope-aware My / Domain / Company. Each row deep-links back to that
 * dataset's Validate stage (`/data?focus=<id>`) — monitor here, fix there. Read-only:
 * nothing here mutates. It reuses the persisted `dq-results` runs; no re-run.
 */

type Badge = 'passing' | 'failing' | 'unknown';
type RiskRow = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  badge: Badge;
  healthScore: number | null;
  openFailures: number;
  freshnessLate: boolean;
  ranAt: string | null;
  risk: number;
};
type Overview = {
  rows: RiskRow[];
  domainHealth: number | null;
  failing: number;
  openFailures: number;
  neverRun: number;
  scope: string;
};

type ScopeFilter = 'my' | 'domain' | 'company';
const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: 'my', label: 'My' },
  { id: 'domain', label: 'Domain' },
  { id: 'company', label: 'Company' },
];

function badgeMark(badge: Badge): string {
  return badge === 'failing' ? '✖' : badge === 'passing' ? '✔' : '•';
}
function badgeColor(badge: Badge): string | undefined {
  return badge === 'failing' ? 'var(--danger, #d64545)' : badge === 'passing' ? 'var(--ok, #2e9e6b)' : 'var(--muted, #999)';
}

export default function DataQualityRollup() {
  const [scope, setScope] = useState<ScopeFilter>('domain');
  const { data, loading, error } = useApi<Overview>(`/api/monitoring/data-quality?scope=${scope}`);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div className="row" style={{ gap: 16, alignItems: 'baseline' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span
              style={{
                fontSize: 30,
                fontWeight: 700,
                lineHeight: 1,
                color: data && data.domainHealth !== null ? (data.failing > 0 ? 'var(--danger, #d64545)' : 'var(--ok, #2e9e6b)') : 'var(--muted, #999)',
              }}
            >
              {data && data.domainHealth !== null ? data.domainHealth : '—'}
            </span>
            <span className="muted" style={{ fontSize: 13 }}>health</span>
          </div>
          {data ? (
            <span className="muted" style={{ fontSize: 13, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ color: data.failing > 0 ? 'var(--danger, #d64545)' : undefined }}>✖ {data.failing} failing</span>
              <span>{data.openFailures} open</span>
              {data.neverRun > 0 ? <span>• {data.neverRun} not run</span> : null}
            </span>
          ) : null}
        </div>
        <div className="seg" role="tablist" aria-label="Data quality scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              className={scope === s.id ? 'on' : ''}
              role="tab"
              aria-selected={scope === s.id}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
      {!data && loading ? <div className="stub-page" style={{ marginTop: 12 }}>Loading data-quality rollup…</div> : null}

      {data && data.rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>No datasets in this scope yet.</p>
      ) : null}

      {data && data.rows.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Health</th>
                <th>Open</th>
                <th>Freshness</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    <a href={`/data?focus=${encodeURIComponent(r.id)}`} title="Open the Validate stage">
                      <span style={{ color: badgeColor(r.badge), marginRight: 6 }}>{badgeMark(r.badge)}</span>
                      {r.name}
                    </a>
                  </td>
                  <td>{r.healthScore !== null ? r.healthScore : <span className="muted">—</span>}</td>
                  <td>{r.openFailures > 0 ? <span style={{ color: 'var(--danger, #d64545)' }}>{r.openFailures}</span> : <span className="muted">0</span>}</td>
                  <td>{r.freshnessLate ? <span style={{ color: 'var(--danger, #d64545)' }}>late</span> : <span className="muted">ok</span>}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.ranAt ? new Date(r.ranAt).toLocaleString() : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="hint" style={{ marginTop: 8 }}>
        Ranked by risk. Author + fix quality in Data → the dataset's Validate stage; this is the read view.
      </div>
    </>
  );
}
