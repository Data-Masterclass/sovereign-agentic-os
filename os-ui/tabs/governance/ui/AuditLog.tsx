/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Audit log viewer — searchable list of audit entries with the chain-integrity status
 * USER STORY: As an admin I want to search and filter the audit trail by text and action and see
 *             whether its hash chain is intact, so that I can trust and investigate what happened.
 * ARCHITECTURE:
 *   - Client component rendered by `app/(govern)/governance/page.tsx`; reads
 *     `GET /api/governance/audit?q=&action=`. The server computes `intact` / `broken`.
 *   - Read-only: the action filter options are derived from the returned entries.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';

/** `toLocaleString()`'s English form, kept byte-identical; other locales get their own. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  domain: string;
  reason: string;
  detail: unknown;
};

type AuditData = {
  entries: AuditEntry[];
  broken: string | null;
  intact: boolean;
};

export default function AuditLog() {
  const t = useTranslations('governance');
  const f = useFormat();
  const [data, setData] = useState<AuditData | null>(null);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (action) params.set('action', action);
      const res = await fetch(`/api/governance/audit?${params.toString()}`, {
        cache: 'no-store',
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('audit.loadFailed'));
      else setData(body as AuditData);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [q, action, t]);

  useEffect(() => {
    load();
  }, [load]);

  const knownActions = data
    ? Array.from(new Set(data.entries.map((e) => e.action))).sort()
    : [];

  return (
    <div>
      <div className="section-title">
        {t('audit.title')}
        {data && (
          <span className={`badge ${data.intact ? 'ok' : 'err'}`}>
            {data.intact ? t('audit.intact') : t('audit.broken')}
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

      {data?.broken && (
        <div className="error" style={{ marginBottom: 10 }}>
          {t('audit.brokenDetail', { detail: data.broken })}
        </div>
      )}

      <div className="row" style={{ marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          style={{ flex: '1 1 220px', padding: '8px 12px' }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('audit.searchPlaceholder')}
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ minWidth: 160 }}
        >
          <option value="">{t('audit.allActions')}</option>
          {knownActions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

      {!data && !error && <div className="stub-page">{t('audit.loading')}</div>}

      {data && data.entries.length === 0 && (
        <div className="stub-page">{t('audit.empty')}</div>
      )}

      {data && data.entries.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('audit.th.when')}</th>
                  <th>{t('audit.th.actor')}</th>
                  <th>{t('audit.th.action')}</th>
                  <th>{t('audit.th.subject')}</th>
                  <th>{t('audit.th.domain')}</th>
                  <th>{t('audit.th.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {f.dateTime(e.at, LEGACY_DT)}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.actor}</td>
                    <td><span className="badge">{e.action}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.subject}</td>
                    <td style={{ fontSize: 12 }}>{e.domain}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t('audit.count', { count: data.entries.length, filtered: q || action ? 'yes' : 'no' })}
          </div>
        </>
      )}
    </div>
  );
}
