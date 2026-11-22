/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - the checks of an app, per commit, with a "Run checks" button
 * USER STORY: As a builder I want to see, for each commit of my app, whether its checks ran, passed or failed -
 *             one status per check with its log, who triggered it and when - and to run them again for the head.
 * ARCHITECTURE: A view over `GET /api/apps/<id>/checks` (the per-commit records the OS copies from Tekton;
 *             the server re-reads running ones) and `POST` (the button: same run as a push and verify_app_gates).
 *             It decides nothing: a record is green only when the server-side verdict says so; here a status is
 *             shown as recorded. Polls while a run is in progress.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Check = { id: string; status: 'pass' | 'fail' | 'unavailable'; detail: string; violations?: string[] };
type CheckRecord = { sha: string; status: 'running' | 'finished' | 'superseded'; trigger: string; engine: string; runRef: string | null; startedAt: string; finishedAt: string | null; checks: Check[]; error: string | null };
type Listing = { checks: CheckRecord[]; head: string | null };

const label = (r: CheckRecord): string => {
  if (r.status === 'running') return 'Running';
  if (r.status === 'superseded') return 'Superseded by a newer push';
  if (r.error) return 'Could not run';
  return r.checks.length > 0 && r.checks.every((c) => c.status === 'pass') ? 'Passed' : 'Failed';
};

export default function ChecksPanel({ appId, canRun }: { appId: string; canRun: boolean }) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${appId}/checks`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else { setData(body as Listing); setError(''); }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [appId]);

  useEffect(() => { void load(); }, [load]);
  const running = data?.checks.some((r) => r.status === 'running') ?? false;
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [running, load]);

  async function runChecks() {
    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${appId}/checks`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grant-block" style={{ marginTop: 12 }} data-testid="checks-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div className="comp-label">Checks (typecheck, lint, tests, build, policy, scan)</div>
        {canRun && (
          <button className="btn" disabled={busy || running} onClick={() => void runChecks()}>
            {busy ? 'Starting…' : running ? 'Running…' : 'Run checks'}
          </button>
        )}
      </div>
      {data?.head && <p className="hint" style={{ marginTop: 4 }}>Head commit <span className="mono">{data.head.slice(0, 12)}</span>. A push, this button and the assistant all run the same checks, once per commit.</p>}
      {error && <p className="hint" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
      {data && data.checks.length === 0 && <p className="hint">No checks recorded yet. Push a commit, or press Run checks.</p>}
      {(data?.checks ?? []).map((r) => (
        <details key={r.sha} style={{ marginTop: 8 }} open={r.sha === data?.head}>
          <summary>
            <span className="mono">{r.sha.slice(0, 12)}</span> — {label(r)} · {r.trigger} · {new Date(r.startedAt).toLocaleString()}
            {r.sha === data?.head ? ' · head' : ''}
          </summary>
          {r.error && <p className="hint">{r.error}</p>}
          {r.runRef && <p className="hint">Run <span className="mono">{r.runRef}</span> ({r.engine})</p>}
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.checks.map((c) => (
              <li key={c.id}>
                <strong>{c.id}</strong>: {c.status}
                {c.status !== 'pass' && c.detail && <pre className="answer mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{[c.detail, ...(c.violations ?? [])].join('\n')}</pre>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
