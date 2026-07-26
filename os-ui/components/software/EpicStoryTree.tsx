/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { deriveStoryStatus, storyProgress, type BuildRunSignals, type TreeStoryStatus } from '@/lib/software/story-tree';
import type { BuildTarget } from '@/lib/software/build-target';

/** The Design shapes the tree renders (mirrors SoftwareBuilder's Epic/Story). */
type Story = { id: string; title: string; status?: 'todo' | 'building' | 'done' };
type Epic = { id: string; title: string; stories: Story[] };

/** The status chip — honest tones on the existing badge language. */
function StatusChip({ status }: { status: TreeStoryStatus }) {
  if (status === 'done') return <span className="badge ok">done ✓</span>;
  if (status === 'building') return <span className="badge warn">building</span>;
  if (status === 'blocked') return <span className="badge err">blocked</span>;
  return <span className="badge muted">to do</span>;
}

/** One selectable tree row — the shared button chrome (gold border when active). */
function NodeButton({
  active,
  onClick,
  title,
  children,
  emphasis = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className="row"
      style={{
        width: '100%',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
        textAlign: 'left',
        padding: emphasis ? '8px 10px' : '6px 10px',
        border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        background: active ? 'var(--panel)' : 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

/**
 * The Build stage's EPIC & STORY TREE (Simple view) — the app's structure as
 * designed, with a synthetic "General" super-epic on top that stands for the
 * ENTIRE app. Clicking any node (General / an EPIC / a story) selects it as the
 * scope the chat actions (Design · Build · Test · Review) run on; clicking the
 * selected node again clears the selection. Status derivation is pure
 * (lib/software/story-tree.ts): building = targeted in the running build,
 * done = the persisted story-done model, blocked = the last run for it failed.
 */
export default function EpicStoryTree({
  epics,
  target,
  onTarget,
  run,
  onGoDesign,
}: {
  epics: Epic[];
  target: BuildTarget | null;
  onTarget: (t: BuildTarget | null) => void;
  run: BuildRunSignals;
  /** Jump back to the Design stage (empty-state pointer). */
  onGoDesign?: () => void;
}) {
  const { built, total } = storyProgress(epics);
  const toggle = (next: BuildTarget) =>
    onTarget(JSON.stringify(target) === JSON.stringify(next) ? null : next);

  const generalActive = target?.kind === 'app';

  return (
    <div className="grant-block">
      <div className="comp-label">Epics &amp; stories</div>
      <p className="hint" style={{ marginTop: 4 }}>
        Select General, an EPIC or a story — the Design · Build · Test · Review buttons act on it.
      </p>

      {/* The synthetic "General" super-epic — the whole app as one calm node. */}
      <div style={{ marginTop: 8 }}>
        <NodeButton
          active={generalActive}
          onClick={() => toggle({ kind: 'app' })}
          title={generalActive ? 'Selected — click to clear' : 'Select the whole app as the scope'}
          emphasis
        >
          <span className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
            <span aria-hidden="true" style={{ opacity: 0.75 }}>⌂</span>
            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              General — the whole app
            </span>
          </span>
          {total > 0 ? (
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
              {built} of {total} {total === 1 ? 'story' : 'stories'} built
            </span>
          ) : null}
        </NodeButton>
      </div>

      {total === 0 ? (
        <div style={{ marginTop: 10 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            No epics yet — design the backlog first. The tree of epics and user stories
            appears here, and each node becomes a one-click scope for the chat actions.
          </p>
          {onGoDesign ? (
            <button type="button" className="btn ghost sm" onClick={onGoDesign} style={{ marginTop: 4 }}>
              Go to Design →
            </button>
          ) : null}
        </div>
      ) : (
        epics.map((e) => {
          const epicActive = target?.kind === 'epic' && target.epicId === e.id;
          return (
            <div key={e.id} style={{ marginTop: 12 }}>
              <NodeButton
                active={epicActive}
                onClick={() => toggle({ kind: 'epic', epicId: e.id })}
                title={epicActive ? 'Selected — click to clear' : 'Select this EPIC as the scope'}
              >
                <span className="comp-label" style={{ fontSize: 11, opacity: 0.85, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {epicActive ? '▸ ' : ''}{e.title || 'Untitled EPIC'}
                </span>
                <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>
                  {e.stories.length} {e.stories.length === 1 ? 'story' : 'stories'}
                </span>
              </NodeButton>
              {e.stories.length === 0 ? (
                <p className="hint" style={{ margin: '4px 0 0 10px' }}>No stories in this EPIC yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: '4px 0 0 10px', padding: 0, display: 'grid', gap: 4 }}>
                  {e.stories.map((s) => {
                    const active = target?.kind === 'story' && target.epicId === e.id && target.storyId === s.id;
                    const status = deriveStoryStatus(s, run);
                    return (
                      <li key={s.id}>
                        <NodeButton
                          active={active}
                          onClick={() => toggle({ kind: 'story', epicId: e.id, storyId: s.id })}
                          title={active ? 'Selected — click to clear' : 'Select this story as the scope'}
                        >
                          <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {active ? '▸ ' : ''}{s.title || 'Untitled story'}
                          </span>
                          <StatusChip status={status} />
                        </NodeButton>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
