/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import type { FolderPathNode } from '@/lib/core/folders';
import type { FolderTab } from '@/lib/folders';

/**
 * The parallel personal + domain folder fetch shared by every artifact browser
 * (Data / Metrics / Files). Each tab hit `/api/folders?tab=<tab>&scope=personal`
 * and `…&scope=domain` in a `Promise.all`, stored the two node lists, and re-ran
 * the fetch whenever the archived toggle flipped — identical code but for the
 * `tab` param. This hook is that one copy.
 *
 * It owns ONLY the fetch + the two node lists; each caller keeps its own effect /
 * reload wiring and simply invokes the returned `loadFolders`. Fail-soft: a failed
 * request leaves the last good nodes in place (the synthesised rail still renders).
 *
 * @param tab          the folders namespace — any registered {@link FolderTab}
 * @param showArchived include archived folders (mirrors the tab's archived view)
 */
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
