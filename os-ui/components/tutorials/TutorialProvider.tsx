/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { getTutorial } from '@/lib/tutorials/registry';
import type { TutorialDef } from '@/lib/tutorials/types';
import TutorialOverlay from './TutorialOverlay';

/**
 * The tutorial overlay host. Mounted ONCE in the root layout so the overlay (and
 * its walk-through) survive tab navigation — "Walk me through it" can route to a
 * tab and keep coaching. Opening remembers where you were (route + scroll) and
 * `close()` restores that exact position, so a tutorial never loses your place.
 */

type Origin = { path: string; scrollY: number };

type Ctx = {
  /** Open the tutorial for a golden-path key (no-op for unknown keys). */
  open: (key: string) => void;
  /** Close + restore the caller's original position. */
  close: () => void;
  activeKey: string | null;
};

const TutorialContext = createContext<Ctx | null>(null);

export function useTutorial(): Ctx {
  const ctx = useContext(TutorialContext);
  if (!ctx) throw new Error('useTutorial must be used within <TutorialProvider>');
  return ctx;
}

export default function TutorialProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [def, setDef] = useState<TutorialDef | null>(null);
  const origin = useRef<Origin | null>(null);

  const open = useCallback(
    (key: string) => {
      const t = getTutorial(key);
      if (!t) return;
      // Remember where we were so close() can restore it exactly.
      origin.current = {
        path: pathname || '/',
        scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
      };
      setDef(t);
    },
    [pathname],
  );

  const close = useCallback(() => {
    setDef(null);
  }, []);

  const value = useMemo<Ctx>(
    () => ({ open, close, activeKey: def?.key ?? null }),
    [open, close, def],
  );

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {def ? (
        <TutorialOverlay def={def} origin={origin.current} onClose={close} />
      ) : null}
    </TutorialContext.Provider>
  );
}
