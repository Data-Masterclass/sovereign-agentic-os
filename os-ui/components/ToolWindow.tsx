/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Full-bleed overlay that frames one embedded tool. The tool loads same-origin
 * at `/tools/<key>/` — served by the os-ui server (lib/tool-proxy.ts), never a
 * localhost address — so the browser only ever presents the OS session. A black
 * top bar (the OS `.topbar` context) carries the title + a Close ×; the iframe
 * fills the rest. Open/close are a quiet fade + lift, and Escape closes.
 *
 * Not every tool can live in the frame: SPAs that load root-absolute assets
 * (`/_next/*`, `/static/*`) collide with the OS's own routes behind the
 * `/tools/<key>` prefix and render blank (how the Superset embed died), and
 * WebSocket tools can't run over the HTTP proxy at all. `/api/tools/<key>`
 * reports which mode a tool gets; for `own-tab` tools the frame area shows the
 * Tier-2 card — the tool's own console link in its own tab — instead of a
 * blank iframe. If that lookup fails we fall back to the iframe (never block
 * a working tool on a metadata hiccup).
 */
export type OpenToolTarget = { key: string; title: string; path?: string } | null;

type EmbedInfo = {
  embed: 'iframe' | 'own-tab';
  reason: string | null;
  consoleUrl: string | null;
};

export default function ToolWindow({
  tool,
  onClose,
}: {
  tool: OpenToolTarget;
  onClose: () => void;
}) {
  // `active` is the tool currently rendered (kept during the close animation);
  // `visible` drives the CSS enter/exit transition.
  const [active, setActive] = useState<OpenToolTarget>(null);
  const [visible, setVisible] = useState(false);
  const [info, setInfo] = useState<EmbedInfo | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Embed mode for the active tool. Until it answers we render nothing in the
  // frame area (a beat of black, no flash of a broken iframe); on any failure
  // we default to the iframe so a metadata hiccup can't break a working tool.
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setInfo(null);
    fetch(`/api/tools/${encodeURIComponent(active.key)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<EmbedInfo>) : null))
      .then((d) => {
        if (alive) setInfo(d?.embed ? d : { embed: 'iframe', reason: null, consoleUrl: null });
      })
      .catch(() => {
        if (alive) setInfo({ embed: 'iframe', reason: null, consoleUrl: null });
      });
    return () => {
      alive = false;
    };
  }, [active]);

  useEffect(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (tool) {
      setActive(tool);
      // next frame so the element mounts hidden, then transitions in
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    closeTimer.current = setTimeout(() => setActive(null), 220);
    return undefined;
  }, [tool]);

  // Escape closes; body scroll locks while the overlay is up.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [active, onClose]);

  if (!active) return null;

  const ownTab = info?.embed === 'own-tab';

  return (
    <div className={`toolwin${visible ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label={active.title}>
      <div className="toolwin-bar topbar">
        <div>
          <h1>{active.title}</h1>
          <div className="crumb">
            {ownTab ? 'Opens in its own tab' : 'Embedded · same-origin · your OS session'}
          </div>
        </div>
        <button type="button" className="toolwin-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {info === null ? (
        <div className="toolwin-frame toolwin-wait" />
      ) : ownTab ? (
        <div className="toolwin-fallback">
          <div className="toolwin-card">
            <h2>{active.title} opens in its own tab</h2>
            <p className="hint">
              {info.reason ?? 'This console cannot render inside the embedded frame.'}
            </p>
            {info.consoleUrl ? (
              <>
                <a className="btn" href={info.consoleUrl} target="_blank" rel="noreferrer">
                  Open {active.title} ↗
                </a>
                <p className="hint toolwin-card-note">
                  Opens the {active.title} console directly — it applies its own sign-in and
                  access controls there; your OS session does not carry over.
                </p>
              </>
            ) : (
              <p className="hint toolwin-card-note">
                No console URL is configured on this deployment — ask your platform admin
                (Components tab has the port-forward command).
              </p>
            )}
          </div>
        </div>
      ) : (
        <iframe
          key={active.key}
          className="toolwin-frame"
          src={`/tools/${active.key}/${active.path ? active.path.replace(/^\/+/, '') : ''}`}
          title={active.title}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      )}
    </div>
  );
}
