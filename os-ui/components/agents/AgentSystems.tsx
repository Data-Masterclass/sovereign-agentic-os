/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import SystemsList from './SystemsList';
import SystemView from './SystemView';
import SystemRail from './SystemRail';
import NewSystemPanel from './NewSystemPanel';
import { getUrlParam, patchUrl } from '@/lib/url-params';

/**
 * The Agents tab experience. Master–detail: the landing shows the grouped systems
 * list (Level 1); opening a system (or "+ New") switches to a two-pane layout —
 * a compact rail of the builder's systems on the left (so the tiles never vanish
 * during edit/create) and the canvas + editors on the right (Level 2/3).
 *
 * The open system is persisted in the URL (?system=<id>, or ?system=new for the
 * create pane) so a reload restores the layout and browser Back returns to the list.
 */
const NEW = 'new';

export default function AgentSystems() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [railKey, setRailKey] = useState(0);

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
    // Clear any deep-link `?name=` seed too, so a later "+ New" pane starts blank.
    patchUrl({ system: null, name: null });
    setRailKey((k) => k + 1); // refresh the landing list after edits
  }, []);
  const startNew = useCallback(() => open(NEW), [open]);
  const onCreated = useCallback((id: string) => {
    patchUrl({ name: null }); // consume the deep-link name seed once created
    setRailKey((k) => k + 1);
    open(id);
  }, [open]);

  // Landing — no system open.
  if (!openId) return <SystemsList onOpen={open} />;

  // Master–detail — rail + main pane (create pane or the system view).
  return (
    <div className="agents-md">
      <SystemRail
        currentId={openId === NEW ? null : openId}
        onOpen={open}
        onNew={startNew}
        onBack={back}
        reloadKey={railKey}
      />
      <div className="agents-md-main">
        {openId === NEW ? (
          <NewSystemPanel onCreated={onCreated} />
        ) : (
          <SystemView key={openId} systemId={openId} onBack={back} />
        )}
      </div>
    </div>
  );
}
