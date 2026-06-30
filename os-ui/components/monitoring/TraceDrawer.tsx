/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type {
  Correlation,
  HealthItem,
  LensId,
  TraceDetail,
} from '@/lib/monitoring';
import { healthDot, isRun, LENS_SHORT } from './health';

/**
 * The drill-into-trace drawer — the core promise. For a run item it fetches the
 * full Langfuse trace (context pack · steps · logs); for any red/amber item it
 * also fetches the correlation chain run → pipeline → system → artifact and the
 * Governance cross-links. 403 (out of scope) and 404 surface calmly.
 */
export default function TraceDrawer({
  item,
  onClose,
}: {
  item: HealthItem;
  onClose: () => void;
}) {
  const runId = item.links?.runId ?? item.id;
  const showTrace = isRun(item.lens, item.links?.runId);

  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [traceErr, setTraceErr] = useState('');
  const [corr, setCorr] = useState<Correlation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setTrace(null);
    setTraceErr('');
    setCorr(null);

    const jobs: Promise<void>[] = [];

    if (showTrace) {
      jobs.push(
        fetch(`/api/monitoring/trace/${encodeURIComponent(runId)}`, { cache: 'no-store' })
          .then(async (res) => {
            const body = await res.json();
            if (!live) return;
            if (!res.ok) {
              setTraceErr(
                res.status === 403
                  ? 'This trace is out of your scope.'
                  : res.status === 404
                    ? 'Trace not found.'
                    : body.error ?? `Trace failed (${res.status})`,
              );
            } else {
              setTrace(body.trace as TraceDetail);
            }
          })
          .catch((e) => {
            if (live) setTraceErr((e as Error).message);
          }),
      );
    }

    jobs.push(
      fetch(`/api/monitoring/correlate?id=${encodeURIComponent(item.id)}`, { cache: 'no-store' })
        .then(async (res) => {
          const body = await res.json();
          if (live && res.ok) setCorr(body.correlation as Correlation);
        })
        .catch(() => {}),
    );

    Promise.all(jobs).then(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [item.id, runId, showTrace]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hops: { lens: LensId; it: HealthItem }[] = corr
    ? ([
        ['runs', corr.run],
        ['pipelines', corr.pipeline],
        ['artifacts', corr.artifact],
      ].filter(([, v]) => Boolean(v)) as [LensId, HealthItem][]).map(([lens, it]) => ({
        lens,
        it,
      }))
    : [];

  const auditRef = corr?.auditRef ?? item.links?.auditRef;
  const capRef = corr?.capRef ?? item.links?.capRef;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2>{showTrace ? 'Trace' : 'Trace chain'}</h2>
          <button className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-body">
          <div className="mon-attn-head" style={{ marginBottom: 4 }}>
            <span className={healthDot(item.health)} />
            <span className="mon-attn-title">{item.title}</span>
            {item.source === 'mock' && <span className="mon-tag">mock</span>}
          </div>
          <div className="mon-item-detail" style={{ marginBottom: 4 }}>{item.detail}</div>
          <div className="hint" style={{ marginTop: 0 }}>
            <span className="mono">{runId}</span> · {item.owner} · {item.domain}
          </div>

          {loading && (
            <div style={{ marginTop: 18 }}>
              <span className="spin" /> <span className="muted">Loading…</span>
            </div>
          )}

          {/* ---- Trace ---- */}
          {showTrace && traceErr && (
            <div className="error" style={{ marginTop: 18 }}>{traceErr}</div>
          )}

          {trace && (
            <>
              {trace.contextPack.length > 0 && (
                <>
                  <div className="mon-sub">Context pack</div>
                  <ul className="mon-ctx">
                    {trace.contextPack.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mon-sub">Steps</div>
              {trace.steps.map((s, i) => (
                <div key={i} className={`mon-step${s.status === 'error' ? ' err' : ''}`}>
                  <div className="mon-step-head">
                    <span className={`badge ${s.status === 'error' ? 'err' : 'muted'}`}>{s.kind}</span>
                    <span className="mon-step-name">{s.name}</span>
                    <span className="mon-step-meta">
                      {typeof s.tokens === 'number' && <>{s.tokens} tok · </>}
                      {typeof s.ms === 'number' && <>{s.ms} ms · </>}
                      {s.status === 'error' ? '✕ error' : '✓ ok'}
                    </span>
                  </div>
                  {s.input && (
                    <div className="mon-io">
                      <span className="lbl">in</span>
                      <span className="val">{s.input}</span>
                    </div>
                  )}
                  {s.output && (
                    <div className="mon-io">
                      <span className="lbl">out</span>
                      <span className="val">{s.output}</span>
                    </div>
                  )}
                </div>
              ))}

              {trace.logs.length > 0 && (
                <>
                  <div className="mon-sub">Logs (tail)</div>
                  <div className="mon-logs">{trace.logs.join('\n')}</div>
                </>
              )}
            </>
          )}

          {/* ---- Correlation chain ---- */}
          {hops.length > 0 && (
            <>
              <div className="mon-sub">Trace chain</div>
              <div className="mon-chain">
                {hops.map((h, i) => (
                  <span key={h.lens} style={{ display: 'flex' }}>
                    {i > 0 && <span className="mon-hop-arrow">→</span>}
                    <span className="mon-hop">
                      <span className="mon-hop-lens">{LENS_SHORT[h.lens]}</span>
                      <span className="mon-hop-title">
                        <span className={healthDot(h.it.health)} />
                        {h.it.title}
                      </span>
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}

          {(auditRef || capRef) && (
            <div className="mon-xlinks">
              {auditRef && (
                <a className="mon-xlink" href="/governance">→ Governance audit {auditRef}</a>
              )}
              {capRef && (
                <a className="mon-xlink" href="/governance">→ cap {capRef}</a>
              )}
            </div>
          )}

          {!loading && !trace && !traceErr && hops.length === 0 && (
            <div className="muted" style={{ marginTop: 18 }}>No linked trace or chain.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
