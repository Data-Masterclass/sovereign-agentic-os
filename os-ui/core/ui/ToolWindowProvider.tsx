/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    ToolWindowProvider — app-wide `openTool` for embedded tools (Langfuse, MLflow, …)
 * USER STORY: As a user I want "Open <tool>" buttons to open the tool without any overlay that could
 *             cover the OS so that I can never be locked out of the navigation.
 * ARCHITECTURE:
 *   - Mounted in `app/layout.tsx`; consumers call `useToolWindow()` (e.g. the Components page).
 *   - `openTool` opens the same-origin proxy `/tools/<key>/…` in a new browser tab; `closeTool` is
 *     a no-op kept for the old signature. The in-app overlay was removed in os-ui 0.6.140.
 *   - On mount it strips stale `?tool=` / `toolTitle` / `toolPath` URL params.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { getUrlParam, patchUrl } from '@core/kernel/url-params';

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
