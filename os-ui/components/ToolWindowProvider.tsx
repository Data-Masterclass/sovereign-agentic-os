/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import ToolWindow, { type OpenToolTarget } from '@/components/ToolWindow';
import { getUrlParam, patchUrl } from '@/lib/url-params';

/**
 * App-wide host for the embedded-tool overlay. Mounted once in the root layout
 * so any page/component can open a tool same-origin without threading props:
 *
 *   const { openTool } = useToolWindow();
 *   <button onClick={() => openTool('mlflow', 'MLflow')}>Open MLflow</button>
 */
type ToolWindowCtx = {
  openTool: (key: string, title: string, path?: string) => void;
  closeTool: () => void;
};

const Ctx = createContext<ToolWindowCtx | null>(null);

export function ToolWindowProvider({ children }: { children: React.ReactNode }) {
  const [tool, setTool] = useState<OpenToolTarget>(null);

  // Persist the open tool in the URL so a reload restores it and it's shareable.
  // We push on open (so browser Back closes it) and mirror history navigation.
  const openTool = useCallback((key: string, title: string, path?: string) => {
    setTool({ key, title, path });
    patchUrl({ tool: key, toolTitle: title, toolPath: path ?? null }, { push: true });
  }, []);
  const closeTool = useCallback(() => {
    setTool(null);
    patchUrl({ tool: null, toolTitle: null, toolPath: null });
  }, []);

  // Restore on mount and follow back/forward.
  useEffect(() => {
    const sync = () => {
      const key = getUrlParam('tool');
      if (key) setTool({ key, title: getUrlParam('toolTitle') ?? key, path: getUrlParam('toolPath') ?? undefined });
      else setTool(null);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const value = useMemo(() => ({ openTool, closeTool }), [openTool, closeTool]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToolWindow tool={tool} onClose={closeTool} />
    </Ctx.Provider>
  );
}

export function useToolWindow(): ToolWindowCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToolWindow must be used within <ToolWindowProvider>');
  return ctx;
}
