/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import FilesBrowser from '@/components/files/FilesBrowser';
import FilesSources from '@/components/files/FilesSources';

/**
 * The Files tab — a calm governed drive. Any file (docs, images, video, audio,
 * archives) lands here, is organised with folders + tags, previewed in place, and
 * searched across names/tags/content. Connected drives (Google Drive / OneDrive)
 * sync in under "Sources". Everything under the hood — parsing, embeddings,
 * OpenSearch, the policy compiler — stays hidden; the user only ever sees files,
 * folders, tags, search and a status chip (Processing → Searchable ✓).
 */
export default function FilesPage() {
  const [view, setView] = useState<'browser' | 'sources'>('browser');
  // A bump key remounts the browser after a sync so freshly-synced files appear.
  const [bump, setBump] = useState(0);
  return (
    <>
      <PageHeader title="Files" crumb="a governed drive · folders · tags · search" mcpTab="files" />
      <div className="content">
        <div className="tabstrip">
          <button className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')}>Files</button>
          <button className={view === 'sources' ? 'active' : ''} onClick={() => setView('sources')}>Sources</button>
        </div>
        {view === 'browser' ? <FilesBrowser key={bump} /> : <FilesSources onSynced={() => setBump((b) => b + 1)} />}
      </div>
    </>
  );
}
