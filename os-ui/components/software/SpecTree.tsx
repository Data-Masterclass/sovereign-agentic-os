/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type { AppEpic } from '@/lib/software/apps';
import {
  BUILD_BATCH_CAP,
  featureId,
  storyFeatureIds,
  epicFeatureIds,
  groupSelectState,
  canSelectFeature,
  type SelEpic,
} from '@/lib/software/build-selection';

/**
 * SpecTree — the hierarchical Epic › Story › (Feature / NFR / Rule) browser. It is the
 * ONE nav + selection + progress surface shared by the Design and Build stages.
 *
 * TWO DISTINCT MARKS, kept visually separate on purpose:
 *   • a SELECTION checkbox ("queue to build next") on stories + features — a toggle,
 *     shown only in `selectable` mode (Build). Cascades epic→story→feature (capped).
 *   • a DONE ✓ badge (green) — a STATUS, not a toggle. A done story stays in the tree,
 *     green; clicking it opens it to refine; ticking its checkbox = rebuild next batch.
 *
 * Selection is capped at BUILD_BATCH_CAP features: past the cap, unselected checkboxes
 * DISABLE with an honest title — never a silent truncation. NFR/Rule leaves are shown
 * for spec visibility but are NOT independently selectable (features drive the build).
 */

/** What the tree currently has selected for the DETAIL panel (nav, not build-select). */
export type SpecNode =
  | { kind: 'app' }
  | { kind: 'epic'; epicId: string }
  | { kind: 'story'; epicId: string; storyId: string }
  | { kind: 'feature'; epicId: string; storyId: string; index: number };

export function nodeKey(n: SpecNode): string {
  if (n.kind === 'app') return 'app';
  if (n.kind === 'epic') return `epic:${n.epicId}`;
  if (n.kind === 'story') return `story:${n.epicId}:${n.storyId}`;
  return `feature:${n.epicId}:${n.storyId}:${n.index}`;
}

function TriBox({
  state, disabled, title, onClick,
}: {
  state: 'none' | 'some' | 'all';
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="st-box"
      aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      role="checkbox"
      disabled={disabled}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      data-state={state}
    >
      {state === 'all' ? '✓' : state === 'some' ? '–' : ''}
      <style jsx>{`
        .st-box {
          width: 16px; height: 16px; flex-shrink: 0; border-radius: 4px; cursor: pointer;
          border: 1px solid var(--border-strong, var(--border)); background: var(--bg);
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 11px; line-height: 1; color: var(--bg); padding: 0;
        }
        .st-box[data-state='all'], .st-box[data-state='some'] { background: var(--gold); border-color: var(--gold); }
        .st-box:disabled { opacity: 0.4; cursor: not-allowed; }
      `}</style>
    </button>
  );
}

/** The green DONE badge — a status, never a toggle. */
function DoneBadge() {
  return <span className="badge ok" style={{ fontSize: 10 }} title="Built ✓">done ✓</span>;
}

export default function SpecTree({
  epics,
  selected,
  onSelectNode,
  selectable,
  selectedFeatures,
  onToggleFeature,
  onToggleGroup,
  onGoDesign,
}: {
  epics: AppEpic[];
  /** The DETAIL node currently open on the right (nav). */
  selected: SpecNode;
  onSelectNode: (n: SpecNode) => void;
  /** Build mode: show the build-select checkboxes. */
  selectable: boolean;
  /** The feature-ids queued for the next build (Build mode). */
  selectedFeatures: ReadonlySet<string>;
  onToggleFeature: (featureId: string) => void;
  onToggleGroup: (featureIds: string[]) => void;
  /** Build mode: jump to Design (the "Design this first" pointer on a spec-less story). */
  onGoDesign?: () => void;
}) {
  const [openEpics, setOpenEpics] = useState<Set<string>>(() => new Set(epics.map((e) => e.id)));
  const [openStories, setOpenStories] = useState<Set<string>>(new Set());
  // Epics that arrive AFTER mount (async load, or a newly-added epic) start expanded too,
  // so the tree is never silently collapsed on the first data that lands.
  useEffect(() => {
    setOpenEpics((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const e of epics) if (!next.has(e.id)) { next.add(e.id); changed = true; }
      return changed ? next : prev;
    });
  }, [epics]);
  const sel = nodeKey(selected);

  const toggleEpic = (id: string) => setOpenEpics((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleStory = (id: string) => setOpenStories((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (epics.length === 0) {
    return (
      <div className="st-empty">
        <p className="muted" style={{ margin: 0 }}>No EPICs yet — add them in Design, then specify each story.</p>
        <style jsx>{`.st-empty { padding: 20px; border: 1px dashed var(--border); border-radius: 10px; text-align: center; }`}</style>
      </div>
    );
  }

  return (
    <div className="st">
      {epics.map((epic, ei) => {
        const efids = epicFeatureIds(epic as SelEpic);
        const eState = groupSelectState(efids, selectedFeatures);
        const eOpen = openEpics.has(epic.id);
        return (
          <div key={epic.id} className="st-epic">
            <div className={`st-row st-epic-row ${sel === `epic:${epic.id}` ? 'active' : ''}`}>
              <button type="button" className="st-chev" aria-expanded={eOpen} onClick={() => toggleEpic(epic.id)} title={eOpen ? 'Collapse' : 'Expand'}>
                <span style={{ transform: eOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
              </button>
              {selectable && efids.length > 0 ? (
                <TriBox
                  state={eState}
                  title={eState === 'all' ? 'Deselect this EPIC' : 'Select this EPIC (cascades to its features, capped)'}
                  onClick={() => onToggleGroup(efids)}
                />
              ) : selectable ? <span style={{ width: 16 }} /> : null}
              <button type="button" className="st-label" onClick={() => onSelectNode({ kind: 'epic', epicId: epic.id })}>
                <span className="st-tag">EPIC {ei + 1}</span>
                <span className="st-title">{epic.title.trim() || 'Untitled EPIC'}</span>
              </button>
            </div>

            {eOpen ? (
              <div className="st-children">
                {(epic.stories ?? []).map((story, si) => {
                  const sfids = storyFeatureIds(story as SelEpic['stories'][number]);
                  const sState = groupSelectState(sfids, selectedFeatures);
                  const sOpen = openStories.has(story.id);
                  const done = story.status === 'done';
                  const features = story.spec?.features ?? [];
                  const nfrs = story.spec?.nfrs ?? [];
                  const rules = story.spec?.rules ?? [];
                  return (
                    <div key={story.id} className="st-story">
                      <div className={`st-row st-story-row ${sel === `story:${epic.id}:${story.id}` ? 'active' : ''}`}>
                        <button type="button" className="st-chev" aria-expanded={sOpen} onClick={() => toggleStory(story.id)} title={sOpen ? 'Collapse' : 'Expand'}>
                          <span style={{ transform: sOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                        </button>
                        {selectable && sfids.length > 0 ? (
                          <TriBox
                            state={sState}
                            title={sState === 'all' ? 'Deselect this story' : 'Queue this story to build next (cascades to its features, capped)'}
                            onClick={() => onToggleGroup(sfids)}
                          />
                        ) : selectable ? <span style={{ width: 16 }} /> : null}
                        <button type="button" className="st-label" onClick={() => onSelectNode({ kind: 'story', epicId: epic.id, storyId: story.id })}>
                          <span className="st-n">{ei + 1}.{si + 1}</span>
                          <span className="st-title">{story.title.trim() || 'Untitled story'}</span>
                        </button>
                        {done ? <DoneBadge /> : null}
                      </div>

                      {sOpen ? (
                        <div className="st-children">
                          {features.map((f, fi) => {
                            const fid = featureId(story.id, fi);
                            const on = selectedFeatures.has(fid);
                            const canTick = canSelectFeature(fid, selectedFeatures);
                            return (
                              <div key={fi} className={`st-row st-leaf ${sel === `feature:${epic.id}:${story.id}:${fi}` ? 'active' : ''}`}>
                                {selectable ? (
                                  <TriBox
                                    state={on ? 'all' : 'none'}
                                    disabled={!canTick}
                                    title={on ? 'Remove from the next build' : canTick ? 'Queue this feature to build next' : `Batch is full (${BUILD_BATCH_CAP}). Build these first, or deselect one.`}
                                    onClick={() => onToggleFeature(fid)}
                                  />
                                ) : null}
                                <button type="button" className="st-label" onClick={() => onSelectNode({ kind: 'feature', epicId: epic.id, storyId: story.id, index: fi })}>
                                  <span className="st-kind">feature</span>
                                  <span className="st-leaf-text">{f}</span>
                                </button>
                                {done ? <span className="badge ok" style={{ fontSize: 9 }}>✓</span> : null}
                              </div>
                            );
                          })}
                          {nfrs.map((n, ni) => (
                            <div key={`n${ni}`} className="st-row st-leaf st-leaf-ro">
                              {selectable ? <span style={{ width: 16 }} /> : null}
                              <span className="st-label st-label-ro"><span className="st-kind">NFR</span><span className="st-leaf-text">{n}</span></span>
                            </div>
                          ))}
                          {rules.map((r, ri) => (
                            <div key={`r${ri}`} className="st-row st-leaf st-leaf-ro">
                              {selectable ? <span style={{ width: 16 }} /> : null}
                              <span className="st-label st-label-ro"><span className="st-kind">rule</span><span className="st-leaf-text">{r}</span></span>
                            </div>
                          ))}
                          {features.length === 0 ? (
                            // SPEC GATE: no features to build — a spec-less story is not
                            // buildable (no checkbox), with a pointer back to Design.
                            <div className="st-row st-leaf st-leaf-ro">
                              {selectable ? <span style={{ width: 16 }} /> : null}
                              <span className="muted" style={{ fontSize: 12, paddingLeft: 4 }}>
                                No features specified — {selectable && onGoDesign ? (
                                  <button type="button" className="st-inline-link" onClick={onGoDesign}>Design this first</button>
                                ) : 'add them in Design'}.
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {(epic.stories ?? []).length === 0 ? (
                  <div className="muted" style={{ fontSize: 12, padding: '4px 0 4px 26px' }}>No stories yet.</div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <style jsx>{`
        .st { display: flex; flex-direction: column; gap: 2px; }
        .st-row { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 7px; }
        .st-row.active { background: var(--gold-soft); box-shadow: inset 0 0 0 1px var(--gold-line); }
        .st-children { margin-left: 16px; border-left: 1px solid var(--border); padding-left: 6px; margin-top: 2px; display: flex; flex-direction: column; gap: 2px; }
        .st-chev { background: none; border: none; padding: 0; cursor: pointer; color: var(--text-faint); font-size: 9px; width: 12px; display: inline-flex; }
        .st-label { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 7px; background: none; border: none; cursor: pointer; color: inherit; font: inherit; text-align: left; padding: 0; overflow: hidden; }
        .st-label-ro { cursor: default; }
        .st-tag { font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--gold-text, var(--accent)); text-transform: uppercase; flex-shrink: 0; }
        .st-n { font-size: 10.5px; font-weight: 600; color: var(--text-faint); flex-shrink: 0; }
        .st-kind { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-faint); flex-shrink: 0; width: 44px; }
        .st-title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .st-epic-row .st-title { font-size: 13.5px; }
        .st-leaf-text { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .st-leaf-ro { opacity: 0.85; }
        .st-inline-link { background: none; border: none; padding: 0; color: var(--gold-text, var(--accent)); cursor: pointer; font: inherit; text-decoration: underline; }
      `}</style>
    </div>
  );
}
