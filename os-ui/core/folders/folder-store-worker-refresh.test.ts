/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folder rows written in one process are listed in the other without a restart
 * USER STORY: As a user whose agent run saved a result into a new folder (the run worker creates
 *             the folder row) I see that folder in the web app's folder rail right away.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL folder registry.
 */
import * as store from '@core/folders/folder-store';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';

const bea = { id: 'bea', domains: ['sales'], role: 'creator' as const };
let n = 0;

workerRefreshSuite({
  name: 'folder rows',
  keys: [Symbol.for('soa.folders.store')],
  index: 'os-folders',
  reset: () => store.__resetStore(),
  read: () => store.ensureHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: (label) => store.createFolder(bea, { tab: 'knowledge', scope: 'personal', path: `/${label.replace(/\W+/g, '-')}-${++n}` }).id,
  remove: (id) => {
    store.archiveFolderRows(bea, id);
    store.deleteFolderRows(bea, id);
  },
  visible: (id) => store.getFolder(id) !== undefined,
  edit: (id, value) => { store.renameFolder(bea, id, `/${value.replace(/\W+/g, '-')}`); },
  marker: (id) => {
    const p = store.getFolder(id)?.path;
    return p === undefined ? undefined : p.slice(1).replace(/-/g, ' ');
  },
});
