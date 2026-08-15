/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { getUrlParam, patchUrl } from '@/lib/core/url-params';

/**
 * App-wide host for embedded tools (Superset, Langfuse, MLflow, …).
 *
 * os-ui 0.6.140 — the in-app FULL-SCREEN tool OVERLAY was REMOVED entirely. It could leave a
 * black screen over the whole OS chrome (including the left nav) with no reliable way out — a
 * stale `?tool=` URL param restored it on every reload, and a hung/focus-grabbing embed could
 * swallow the dismiss keys ("the menu is blacked out and I can't click anything"). An overlay
 * that can trap the operator is never acceptable. Tools now open in their OWN BROWSER TAB, which
 * can never cover the OS. `openTool` keeps the same signature so every "Open <tool>" button keeps
 * working; `closeTool` is a no-op (there is nothing to close).
 */
type ToolWindowCtx = {
  openTool: (key: string, title: string, path?: string) => void;
  closeTool: () => void;
};

const Ctx = createContext<ToolWindowCtx | null>(null);

export function ToolWindowProvider({ children }: { children: React.ReactNode }) {
  // Open the same-origin tool proxy (`/tools/<key>/…`, served by os-ui) in a NEW TAB.
  const openTool = useCallback((key: string, _title: string, path?: string) => {
    if (typeof window === 'undefined') return;
    const url = `/tools/${encodeURIComponent(key)}/${path ? path.replace(/^\/+/, '') : ''}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);
  const closeTool = useCallback(() => {}, []);

  // One-time cleanup: strip any stale `?tool=` params left in the address bar / a bookmark so an
  // old URL can't linger. Nothing restores an overlay on load anymore — there is no overlay.
  useEffect(() => {
    if (getUrlParam('tool') || getUrlParam('toolTitle') || getUrlParam('toolPath')) {
      patchUrl({ tool: null, toolTitle: null, toolPath: null });
    }
  }, []);

  const value = useMemo(() => ({ openTool, closeTool }), [openTool, closeTool]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useToolWindow(): ToolWindowCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToolWindow must be used within <ToolWindowProvider>');
  return ctx;
}
