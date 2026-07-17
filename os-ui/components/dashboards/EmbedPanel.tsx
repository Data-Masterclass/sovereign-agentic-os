/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { postJson } from './shared';
import type { DashboardSummary, EmbedResponse } from './shared';

const REGIONS = [
  { key: 'me', label: 'Me (my entitlements)' },
  { key: 'DE', label: 'DE' },
  { key: 'FR', label: 'FR' },
  { key: 'US', label: 'US' },
] as const;

/**
 * The embed panel. Mints a per-viewer Superset guest token (POST /api/dashboards/embed)
 * with the viewer's RLS baked into the token (R3). The "View as" selector re-mints with a
 * different region, so the RLS clause visibly changes per viewer — the whole point of the
 * guest-token demo. Live mode renders the Superset embed affordance; offline-mock renders
 * the honest token/RLS summary panel.
 */
export default function EmbedPanel({ dashboard, supersetUrl }: { dashboard: DashboardSummary; supersetUrl: string }) {
  const [region, setRegion] = useState<string>('me');
  const [embed, setEmbed] = useState<EmbedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    postJson<EmbedResponse>('/api/dashboards/embed', {
      dashboardId: dashboard.id,
      viewerRegion: region === 'me' ? undefined : region,
    })
      .then((d) => { if (live) setEmbed(d); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [dashboard.id, region]);

  // Live: mount the real Superset Embedded SDK, handing it the already-minted per-viewer
  // guest token (RLS baked in, R3). Re-runs when the token re-mints (region switch); the
  // cleanup unmounts the previous iframe so we never stack embeds.
  //
  // supersetDomain is the SAME-ORIGIN reverse proxy (`<os-origin>/tools/superset`), NOT the
  // cross-origin public console. Superset ships `X-Frame-Options: SAMEORIGIN` + a Talisman
  // CSP with no `frame-ancestors`, so a cross-origin iframe (os.* framing superset.*) is
  // blocked by the browser. Routing through `/tools/superset` (lib/tool-proxy.ts) makes the
  // iframe same-origin — the proxy strips X-Frame-Options and pins `frame-ancestors 'self'`
  // — eliminating the CSP / third-party-cookie problems entirely. The SDK sets the iframe
  // src to `${supersetDomain}/embedded/<uuid>` and uses the origin of supersetDomain as its
  // postMessage targetOrigin, so an absolute same-origin URL is required (a bare path throws).
  useEffect(() => {
    const node = mountRef.current;
    if (!embed || embed.mode !== 'live' || !embed.embeddedId || !node) return;
    const supersetDomain = `${window.location.origin}/tools/superset`;
    let unmount: (() => void) | undefined;
    embedDashboard({
      id: embed.embeddedId,
      supersetDomain,
      mountPoint: node,
      fetchGuestToken: () => Promise.resolve(embed.token),
      dashboardUiConfig: { hideTitle: true },
    })
      .then((instance) => { unmount = instance.unmount; })
      .catch(() => { /* live mount failed — the token/RLS summary above still stands */ });
    return () => { unmount?.(); };
  }, [embed]);

  return (
    <div className="agent-editor" style={{ marginTop: 16 }}>
      <div className="agent-editor-head">
        <div>
          <div className="agent-editor-title">{dashboard.name}</div>
          <div className="hint" style={{ marginTop: 2 }}>
            Opened via a per-viewer Superset guest token — row-level security is baked into the token (R3).
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="comp-label" style={{ margin: 0 }}>View as</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
      {loading && !embed ? <div className="hint">Minting guest token…</div> : null}

      {embed ? (
        <>
          <div className="passthrough-note" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>Guest token minted</span>
              <span className={`badge ${embed.mode === 'live' ? 'ok' : 'muted'}`}>{embed.mode}</span>
            </div>
            <div>
              Embedded as <strong>{embed.request.user.username}</strong>
              {' · '}token ttl <strong>{embed.expiresInSeconds}s</strong>
            </div>
            <div style={{ marginTop: 6 }}>
              RLS:{' '}
              {embed.request.rls.length ? (
                embed.request.rls.map((r, i) => (
                  <code key={i} style={{ marginRight: 6 }}>{r.clause}</code>
                ))
              ) : (
                <em>unfiltered</em>
              )}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              Switch “View as” to mint a different viewer’s token — the RLS clause changes with it.
            </div>
          </div>

          {embed.mode === 'live' ? (
            <div style={{ marginTop: 14 }}>
              <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                Live: the dashboard below is mounted via the Superset <strong>Embedded SDK</strong> with the
                per-viewer guest token above (~{embed.expiresInSeconds}s ttl + refresh).
              </div>
              <div
                ref={mountRef}
                style={{ minHeight: 480, borderRadius: 8, overflow: 'hidden' }}
              />
            </div>
          ) : (
            <div className="hint" style={{ marginTop: 10 }}>
              Offline mock — the live embed couldn’t be mounted, so it’s summarised above instead.
              {embed.reason ? <> ({embed.reason})</> : ' (Superset isn’t reachable from here.)'}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
