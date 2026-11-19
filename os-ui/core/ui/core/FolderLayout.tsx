/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    FolderLayout — the shared left-rail and main-area shell for foldered tabs
 * USER STORY: As a user moving between foldered tabs I want folders and tiles laid out the same
 *             way everywhere so that I do not have to learn a new layout per tab.
 * ARCHITECTURE:
 *   - Uses the Files tab's `.files-layout` / `.files-rail` / `.files-main` grid. Files keeps its
 *     own inline markup (it has an extra preview column). Data, Knowledge, Metrics, Workflows,
 *     Software, Agents and Connections render through this component.
 *   - The rail starts with an "All <items>" row that clears the folder filter, followed by the
 *     host's `rail` content (normally `FolderTree variant="nav"`).
 */
'use client';

import type { DragEventHandler, ReactNode } from 'react';

/**
 * FolderLayout — the ONE canonical folder-tab shell (Files is the reference).
 *
 * Every foldered tab (Files · Data · Knowledge · Metrics) presents folders
 * IDENTICALLY: a sticky LEFT rail (the `FolderTree variant="nav"` for the active
 * scope root) + a tile/grid MAIN area, laid out with the same `.files-layout` /
 * `.files-rail` / `.files-main` CSS grid so they cannot drift. Files itself keeps
 * its own inline markup (it adds a third preview column); the OTHER tabs render
 * through this wrapper so they are pixel-consistent with it.
 *
 * The rail always leads with an "All <items>" row (the shared `.rail-item`
 * affordance) that clears the folder filter — the same top row Files shows.
 */
export default function FolderLayout({
  allLabel,
  allCount,
  allSelected,
  onSelectAll,
  rail,
  children,
  mainClassName,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  /** The "All …" row label, e.g. "All datasets". */
  allLabel: string;
  /** Count shown on the "All …" row. */
  allCount: number;
  /** True when no folder is selected (the "All …" row is active). */
  allSelected: boolean;
  /** Clears the folder filter (selects "All …"). */
  onSelectAll: () => void;
  /** The FolderTree (nav variant) + any tag cloud below it. */
  rail: ReactNode;
  /** The main area — the tile grid + bulk actions + empty states. */
  children: ReactNode;
  /**
   * Extra class(es) on the `.files-main` section. Files uses this for its
   * `file-drop`/`drag` drag-and-drop affordance; other tabs omit it.
   */
  mainClassName?: string;
  /** Drag-and-drop handlers on the main section (Files' upload-by-drop). */
  onDragOver?: DragEventHandler<HTMLElement>;
  onDragLeave?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
}) {
  return (
    <div className="files-layout">
      <nav className="files-rail files-rail-tree">
        <div>
          <button
            className={`rail-item${allSelected ? ' on' : ''}`}
            onClick={onSelectAll}
            type="button"
          >
            <span>{allLabel}</span>
            <span className="rail-count">{allCount}</span>
          </button>
          {rail}
        </div>
      </nav>
      <section
        className={`files-main${mainClassName ? ` ${mainClassName}` : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {children}
      </section>
    </div>
  );
}
