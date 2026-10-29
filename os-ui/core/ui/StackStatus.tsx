'use client';

import { useCallback, useEffect, useState } from 'react';

type Service = { key: string; label: string; up: boolean; detail: string };

export default function StackStatus() {
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
      if (!res.ok) setError(data.error ?? 'Failed to load status');
      else {
        setServices(data.services ?? []);
        setSummary({ up: data.up, total: data.total });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        Stack status
        {summary ? (
          <span className={`count-pill${summary.up === summary.total ? ' ok' : ' warn'}`}>
            {summary.up}/{summary.total} up
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
                <span className="status-label">loading…</span>
              </div>
            ))
          : services.map((s) => (
              <div className="status-item" key={s.key} title={`${s.key} · ${s.detail}`}>
                <span className={`status-dot ${s.up ? 'up' : 'down'}`} />
                <span className="status-label">{s.label}</span>
                <span className="status-detail">{s.up ? 'up' : s.detail}</span>
              </div>
            ))}
      </div>
    </>
  );
}
