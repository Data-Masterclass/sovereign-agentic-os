/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Page context — what the user has open right now, shared across the OS shell
 * USER STORY: As a user asking the OS Assistant about the dataset or agent I have open I want it
 *             to know which artifact that is so that it does not ask me for the id.
 * ARCHITECTURE:
 *   - A plain client-side React context. `PageContextProvider` is mounted once in
 *     `app/layout.tsx`, `core/ui/OsAssistant.tsx` reads it with `usePageContext()`, and tab
 *     surfaces (Agents SimpleBuilder, Data DataBuilder, Knowledge WorkflowView, Files
 *     FilePreview) publish with `usePublishPageContext()`.
 *   - It only adds information. With nothing published, `usePageContext()` returns null and the
 *     assistant asks for the id as before. Calling it without a provider is a harmless no-op.
 *   - A publisher clears its snapshot on unmount, so one screen's context does not carry over to
 *     the next. There is no server round trip. The pathname stays the server's source for the
 *     tab.
 */
'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** The focus snapshot a tab publishes. Every field beyond `tab` is optional — a tab
 *  publishes only what it actually knows (a builder may know its stage but have no
 *  artifact yet; a preview knows the open file). */
export type PageContext = {
  /** The tab the user is on. Matches the app's route segment vocabulary
   *  (e.g. 'data', 'agents', 'knowledge', 'files'). */
  tab: string;
  /** The sub-stage / phase / step within the tab, if the surface is staged
   *  (e.g. Data 'silver', Agents 'design', Knowledge 'workflow'). */
  stage?: string;
  /** The kind of the open artifact (e.g. 'dataset', 'agent', 'workflow', 'file'). */
  artifactType?: string;
  /** The stable id of the open artifact — the value the assistant should act on
   *  WITHOUT re-asking (e.g. a dataset id). */
  artifactId?: string;
  /** The human name/title of the open artifact, for grounding + friendly reference. */
  artifactName?: string;
  /** Any small extra hints a surface wants to surface (kept short — this rides in a
   *  prompt preamble, not a data channel). */
  extra?: Record<string, string>;
};

type Ctx = {
  context: PageContext | null;
  setContext: (ctx: PageContext | null) => void;
};

const PageContextCtx = createContext<Ctx | null>(null);

/**
 * Mount ONCE in the app shell (around the assistant). Holds the single current
 * page-context snapshot. Defensive by construction: default is `null`.
 */
export function PageContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<PageContext | null>(null);
  return (
    <PageContextCtx.Provider value={{ context, setContext }}>
      {children}
    </PageContextCtx.Provider>
  );
}

/**
 * READ the current page-context (or null when nothing is published / provider
 * absent). The assistant calls this; if it returns null it falls back to today's
 * behavior. Never throws when used outside a provider — enrichment is optional.
 */
export function usePageContext(): PageContext | null {
  return useContext(PageContextCtx)?.context ?? null;
}

/**
 * PUBLISH the calling surface's context for as long as it is mounted, then clear it
 * on unmount. Call it once, high in a tab's render, with the live focus:
 *
 *   // Agents builder (SimpleBuilder), publishing the current phase + open system:
 *   usePublishPageContext({
 *     tab: 'agents',
 *     stage: phase,                 // 'define' | 'design' | 'build' | 'run' | 'evaluate'
 *     artifactType: 'agent',
 *     artifactId: systemId,
 *     artifactName: system.system.name,
 *   });
 *
 *   // Data builder (DataBuilder) — ONE-LINER to add when its owning agent is done:
 *   usePublishPageContext({
 *     tab: 'data',
 *     stage,                        // e.g. 'silver'
 *     artifactType: 'dataset',
 *     artifactId: datasetId,
 *     artifactName: dataset?.name,
 *   });
 *
 * It re-publishes whenever the passed fields change (the effect deps are the field
 * values, so it is stable across renders without memoizing the object). A no-op —
 * but harmless — when there is no provider above it.
 */
export function usePublishPageContext(ctx: PageContext | null | undefined): void {
  const store = useContext(PageContextCtx);
  const setContext = store?.setContext;
  const tab = ctx?.tab;
  const stage = ctx?.stage;
  const artifactType = ctx?.artifactType;
  const artifactId = ctx?.artifactId;
  const artifactName = ctx?.artifactName;
  // Serialize `extra` so the effect re-runs only on real changes, not identity.
  const extraKey = ctx?.extra ? JSON.stringify(ctx.extra) : '';

  useEffect(() => {
    if (!setContext || !tab) return;
    setContext({
      tab,
      ...(stage ? { stage } : {}),
      ...(artifactType ? { artifactType } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(artifactName ? { artifactName } : {}),
      ...(extraKey ? { extra: JSON.parse(extraKey) as Record<string, string> } : {}),
    });
    return () => setContext(null);
  }, [setContext, tab, stage, artifactType, artifactId, artifactName, extraKey]);
}
