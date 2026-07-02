/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import SystemsList from './SystemsList';
import SystemView from './SystemView';
import { getUrlParam, patchUrl } from '@/lib/url-params';

/**
 * The Agents tab's three-level experience (Approach A): Systems list (Level 1) →
 * System canvas + editors (Level 2) → agent editor (Level 3, inside SystemView).
 * A thin navigation shell over the single-source store; the heavy lifting lives in
 * the level components. This is the template we later replicate to the other tabs.
 */
export default function AgentSystems() {
  const [openId, setOpenId] = useState<string | null>(null);

  // Persist the open system in the URL (?system=<id>) so a reload restores the
  // canvas + helper chat instead of dropping back to the list. Push on open so
  // browser Back returns to the list; mirror back/forward via popstate.
  useEffect(() => {
    const sync = () => setOpenId(getUrlParam('system'));
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const open = useCallback((id: string) => {
    setOpenId(id);
    patchUrl({ system: id }, { push: true });
  }, []);
  const back = useCallback(() => {
    setOpenId(null);
    patchUrl({ system: null });
  }, []);

  return openId ? (
    <SystemView systemId={openId} onBack={back} />
  ) : (
    <SystemsList onOpen={open} />
  );
}
