/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    useTechnicalDetails — the ONE hook that says whether internals panels render
 * USER STORY: As a user I never see "Under the hood" unless I asked for it in My Settings; as an
 *             engineer I flip one switch and it appears on every detail page, without a reload.
 * ARCHITECTURE:
 *   - Rules (default, parsing, key) live in `@core/prefs/technical-details-pure`; this file is
 *     the React plumbing only.
 *   - SSR-safe: the first render is always OFF (server and client agree, no hydration
 *     mismatch); the stored choice is read in an effect.
 *   - Live: a custom window event covers readers in the same tab, the `storage` event covers
 *     other tabs. Every storage access is wrapped — private mode or blocked site data simply
 *     means off / not remembered.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  TECHNICAL_DETAILS_DEFAULT,
  TECHNICAL_DETAILS_EVENT,
  TECHNICAL_DETAILS_KEY,
  parseTechnicalDetails,
  serializeTechnicalDetails,
} from '@core/prefs/technical-details-pure';

function readStored(): boolean {
  try {
    return parseTechnicalDetails(window.localStorage.getItem(TECHNICAL_DETAILS_KEY));
  } catch {
    return TECHNICAL_DETAILS_DEFAULT;
  }
}

/** Whether technical details are shown for this user on this device, and a setter. */
export function useTechnicalDetails(): { on: boolean; setOn: (next: boolean) => void } {
  const [on, setLocal] = useState<boolean>(TECHNICAL_DETAILS_DEFAULT);

  useEffect(() => {
    setLocal(readStored());
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setLocal(typeof detail === 'boolean' ? detail : readStored());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === TECHNICAL_DETAILS_KEY) setLocal(readStored());
    };
    window.addEventListener(TECHNICAL_DETAILS_EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TECHNICAL_DETAILS_EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setOn = useCallback((next: boolean) => {
    setLocal(next);
    try {
      window.localStorage.setItem(TECHNICAL_DETAILS_KEY, serializeTechnicalDetails(next));
    } catch {
      /* private mode — the choice holds for this page only */
    }
    window.dispatchEvent(new CustomEvent(TECHNICAL_DETAILS_EVENT, { detail: next }));
  }, []);

  return { on, setOn };
}
