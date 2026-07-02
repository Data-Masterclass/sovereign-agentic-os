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
 */
export type OpenToolTarget = { key: string; title: string; path?: string } | null;

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
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <div className={`toolwin${visible ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label={active.title}>
      <div className="toolwin-bar topbar">
        <div>
          <h1>{active.title}</h1>
          <div className="crumb">Embedded · same-origin · your OS session</div>
        </div>
        <button type="button" className="toolwin-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <iframe
        key={active.key}
        className="toolwin-frame"
        src={`/tools/${active.key}/${active.path ? active.path.replace(/^\/+/, '') : ''}`}
        title={active.title}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
}
