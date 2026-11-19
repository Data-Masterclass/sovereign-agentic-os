/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    useFolders — load a tab's personal and domain folder rows in one hook
 * USER STORY: As a user browsing a foldered tab I want my personal and domain folders loaded
 *             together, including archived ones when I ask for them, so that the folder rail is complete.
 * ARCHITECTURE:
 *   - Client hook; fetches `/api/folders?tab=<tab>&scope=personal|domain` in parallel. Used by the
 *     artifact browsers (Files, Metrics, Dashboards, Agents, Connections, Workflows, Software).
 *   - Owns only the fetch and the two node lists; callers decide when to call `loadFolders`.
 *   - Fail-soft: a failed request keeps the last good nodes, so the derived rail still renders.
 */
'use client';

import { useCallback, useState } from 'react';
import type { FolderPathNode } from '@core/kernel/folders';
import type { FolderTab } from '@core/folders/index';

export function useFolders(
  tab: FolderTab,
  showArchived: boolean,
): {
  personalNodes: FolderPathNode[];
  domainNodes: FolderPathNode[];
  loadFolders: () => Promise<void>;
} {
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);

  const loadFolders = useCallback(async () => {
    const archivedParam = showArchived ? '&archived=1' : '';
    try {
      const [pRes, dRes] = await Promise.all([
        fetch(`/api/folders?tab=${tab}&scope=personal${archivedParam}`, { cache: 'no-store' }),
        fetch(`/api/folders?tab=${tab}&scope=domain${archivedParam}`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPersonalNodes(((await pRes.json()).folders ?? []) as FolderPathNode[]);
      if (dRes.ok) setDomainNodes(((await dRes.json()).folders ?? []) as FolderPathNode[]);
    } catch {
      /* the synthesised rail still renders without the registry */
    }
  }, [tab, showArchived]);

  return { personalNodes, domainNodes, loadFolders };
}
