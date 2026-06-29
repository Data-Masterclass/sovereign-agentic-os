/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import SystemsList from './SystemsList';
import SystemView from './SystemView';

/**
 * The Agents tab's three-level experience (Approach A): Systems list (Level 1) →
 * System canvas + editors (Level 2) → agent editor (Level 3, inside SystemView).
 * A thin navigation shell over the single-source store; the heavy lifting lives in
 * the level components. This is the template we later replicate to the other tabs.
 */
export default function AgentSystems() {
  const [openId, setOpenId] = useState<string | null>(null);

  return openId ? (
    <SystemView systemId={openId} onBack={() => setOpenId(null)} />
  ) : (
    <SystemsList onOpen={(id) => setOpenId(id)} />
  );
}
