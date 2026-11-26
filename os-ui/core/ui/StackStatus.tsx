/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    StackStatus — live up/down status of the platform services
 * USER STORY: As a user on the settings page I want to see which platform services are up so that
 *             I know whether a problem is on my side or the platform's.
 * ARCHITECTURE:
 *   - Used by `app/(entry)/settings/page.tsx`. Polls `/api/status` every 15 seconds.
 * I18N:       converted (wave 1) — texts from `common.status.*`; service names and details come from the server.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from '@core/i18n/client';

type Service = { key: string; label: string; up: boolean; detail: string };

export default function StackStatus() {
  const t = useTranslations('common');
  const [services, setServices] = useState<Service[]>([]);
  const [summary, setSummary] = useState<{ up: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? t('status.loadFailed'));
      else {
        setServices(data.services ?? []);
        setSummary({ up: data.up, total: data.total });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {t('status.title')}
        {summary ? (
          <span className={`count-pill${summary.up === summary.total ? ' ok' : ' warn'}`}>
            {t('status.upCount', { up: summary.up, total: summary.total })}
          </span>
        ) : null}
        {loading ? <span className="spin" /> : null}
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="statusbar">
        {services.length === 0 && loading
          ? Array.from({ length: 8 }).map((_, i) => (
              <div className="status-item skel" key={i}>
                <span className="status-dot unknown" />
                <span className="status-label">{t('status.loading')}</span>
              </div>
            ))
          : services.map((s) => (
              <div className="status-item" key={s.key} title={`${s.key} · ${s.detail}`}>
                <span className={`status-dot ${s.up ? 'up' : 'down'}`} />
                <span className="status-label">{s.label}</span>
                <span className="status-detail">{s.up ? t('status.up') : s.detail}</span>
              </div>
            ))}
      </div>
    </>
  );
}
