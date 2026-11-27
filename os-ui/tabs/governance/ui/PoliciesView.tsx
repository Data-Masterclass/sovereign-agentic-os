/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Policy plane view — capability profiles, access grants, egress allowlist, standing policies
 * USER STORY: As a builder or admin I want to see who may call which tool, where each grant came from and
 *             what it compiles to, and as an admin revoke a grant, so that access is visible and correctable.
 * ARCHITECTURE:
 *   - Client component rendered by `app/(govern)/governance/page.tsx`; reads
 *     `GET /api/governance/policies` and revokes with `POST` `{ principal, tool }`.
 *   - Revoke and "Edit profiles" show only when the server returns `canOverride`; the badge says
 *     whether OPA is live or the plane is only compiled.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';

/** `toLocaleDateString()`'s English form, kept byte-identical. */
const LEGACY_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };

/** A grant source in words. */
const SOURCE_KEYS = {
  role: 'policies.source.role', 'access-grant': 'policies.source.accessGrant', egress: 'policies.source.egress', standing: 'policies.source.standing',
} as const;

type GrantRow = {
  principal: string;
  tool: string;
  source: 'role' | 'access-grant' | 'egress' | 'standing';
  domain: string;
  compiledTo: 'OPA' | 'OpenSearch-DLS';
};

type PolicyPlane = {
  plane: GrantRow[];
  sources: { name: string; authoredIn: string; compiledTo: string; rights: string[] }[];
  egress: { endpoint: string; domain: string; approvedBy: string }[];
  standing: {
    id: string;
    kind: string;
    match: string;
    domain: string;
    createdBy: string;
    createdAt: string;
    fromApproval: string;
  }[];
  opaLive: boolean;
  canOverride: boolean;
};

export default function PoliciesView() {
  const t = useTranslations('governance');
  const msg = useServerMessage();
  const f = useFormat();
  const [data, setData] = useState<PolicyPlane | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/policies', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(msg(body, t('policies.loadFailed')));
      else setData(body as PolicyPlane);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t, msg]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = useCallback(
    async (principal: string, tool: string) => {
      const key = `${principal}:${tool}`;
      setBusy(key);
      setError('');
      try {
        const res = await fetch('/api/governance/policies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ principal, tool }),
        });
        const body = await res.json();
        if (!res.ok) setError(msg(body, t('policies.revokeFailed')));
        else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load, t],
  );

  return (
    <div>
      <div className="section-title">
        {t('policies.title')}
        {data && (
          <span className={`badge ${data.opaLive ? 'ok' : 'muted'}`} style={{ marginLeft: 4 }}>
            {data.opaLive ? t('policies.opaLive') : t('policies.compiledMock')}
          </span>
        )}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          {t('actions.refresh')}
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!data && !error && <div className="stub-page">{t('policies.loading')}</div>}

      {data && (
        <>
          {/* Capability profiles — heart of the policy plane, shown first */}
          <div className="section-title">
            {t('policies.profiles.title')}
            {data.sources.length > 0 && (
              <span className="count-pill">{data.sources.length}</span>
            )}
            {data.canOverride ? (
              <a
                href="/governance?section=roles"
                className="btn ghost"
                style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12, textDecoration: 'none' }}
              >
                {t('policies.profiles.edit')}
              </a>
            ) : (
              <span className="hint" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>
                {t('policies.profiles.editableHint')}
              </span>
            )}
          </div>
          {data.sources.length === 0 ? (
            <div className="stub-page">
              {data.canOverride
                ? t('policies.profiles.emptyAdmin')
                : t('policies.profiles.empty')}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>{t('policies.profiles.th.profile')}</th><th>{t('policies.profiles.th.authoredIn')}</th><th>{t('policies.th.compiledTo')}</th><th>{t('policies.profiles.th.rights')}</th></tr>
                </thead>
                <tbody>
                  {data.sources.map((s, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{s.name}</td>
                      <td style={{ fontSize: 12 }}>{s.authoredIn}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{s.compiledTo}</td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {s.rights.map((r) => (
                            <span key={r} className="chip">{r}</span>
                          ))}
                        </div>
                        {data.canOverride && (
                          <a
                            href="/governance?section=roles"
                            style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--text-faint)', textDecoration: 'none' }}
                          >
                            {t('policies.profiles.editInRoles')}
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Access grants table */}
          <div className="section-title">
            {t('policies.grants.title')}
            <span className="count-pill">{data.plane.length}</span>
          </div>
          {data.plane.length === 0 ? (
            <div className="stub-page">{t('policies.grants.empty')}</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('policies.grants.th.principal')}</th>
                    <th>{t('policies.grants.th.tool')}</th>
                    <th>{t('policies.grants.th.source')}</th>
                    <th>{t('policies.th.domain')}</th>
                    <th>{t('policies.th.compiledTo')}</th>
                    {data.canOverride && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {data.plane.map((row, i) => {
                    const k = `${row.principal}:${row.tool}`;
                    return (
                      <tr key={i}>
                        <td className="mono" style={{ fontWeight: 600 }}>{row.principal}</td>
                        <td className="mono">{row.tool}</td>
                        <td><span className="badge">{row.source in SOURCE_KEYS ? t(SOURCE_KEYS[row.source]) : row.source}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{row.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{row.compiledTo}</td>
                        {data.canOverride && (
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn ghost"
                              style={{
                                padding: '3px 10px',
                                fontSize: 12,
                                color: 'var(--danger)',
                                borderColor: 'rgba(229,104,95,0.35)',
                              }}
                              disabled={busy === k}
                              onClick={() => revoke(row.principal, row.tool)}
                            >
                              {busy === k ? <span className="spin" /> : t('policies.grants.revoke')}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Egress allowlist */}
          {data.egress.length > 0 && (
            <>
              <div className="section-title">
                {t('policies.egress.title')}
                <span className="count-pill">{data.egress.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>{t('policies.egress.th.endpoint')}</th><th>{t('policies.th.domain')}</th><th>{t('policies.egress.th.approvedBy')}</th></tr>
                  </thead>
                  <tbody>
                    {data.egress.map((e, i) => (
                      <tr key={i}>
                        <td className="mono">{e.endpoint}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{e.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{e.approvedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Standing policies */}
          {data.standing.length > 0 && (
            <>
              <div className="section-title">
                {t('policies.standing.title')}
                <span className="count-pill">{data.standing.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('policies.standing.th.kind')}</th>
                      <th>{t('policies.standing.th.match')}</th>
                      <th>{t('policies.th.domain')}</th>
                      <th>{t('policies.standing.th.createdBy')}</th>
                      <th>{t('policies.standing.th.fromApproval')}</th>
                      <th>{t('policies.standing.th.created')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.standing.map((p) => (
                      <tr key={p.id}>
                        <td><span className="badge">{p.kind}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.match}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.createdBy}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.fromApproval || '—'}</td>
                        <td style={{ fontSize: 12 }}>{f.date(p.createdAt, LEGACY_DATE)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
