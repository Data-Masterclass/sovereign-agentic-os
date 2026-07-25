/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { deriveStoryStatus, storyProgress, type BuildRunSignals, type TreeStoryStatus } from '@/lib/software/story-tree';

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

/**
 * The Build stage's EPIC & STORY TREE (Simple view) — the app's structure as
 * defined in Design, with per-story build status. Clicking a story sets it as
 * the Build target (the same target the chat sends with each run); clicking the
 * active story clears back to "whole app". Status derivation is pure
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
  target: { epicId: string; storyId: string } | null;
  onTarget: (t: { epicId: string; storyId: string } | null) => void;
  run: BuildRunSignals;
  /** Jump back to the Design stage (empty-state pointer). */
  onGoDesign?: () => void;
}) {
  const { built, total } = storyProgress(epics);

  if (total === 0) {
    return (
      <div className="grant-block">
        <div className="comp-label">Epics &amp; stories</div>
        <p className="hint" style={{ marginTop: 6 }}>
          No epics yet — design the backlog first. The tree of epics and user stories
          appears here, and each story becomes a one-click build target.
        </p>
        {onGoDesign ? (
          <button type="button" className="btn ghost sm" onClick={onGoDesign} style={{ marginTop: 4 }}>
            Go to Design →
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grant-block">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="comp-label">Epics &amp; stories</div>
        <span className="muted" style={{ fontSize: 12 }}>
          {built} of {total} {total === 1 ? 'story' : 'stories'} built
        </span>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        Click a story to target the build; click it again for the whole app.
      </p>

      {epics.map((e) => (
        <div key={e.id} style={{ marginTop: 12 }}>
          <div className="comp-label" style={{ fontSize: 11, opacity: 0.85 }}>{e.title || 'Untitled EPIC'}</div>
          {e.stories.length === 0 ? (
            <p className="hint" style={{ margin: '4px 0 0 10px' }}>No stories in this EPIC yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 4 }}>
              {e.stories.map((s) => {
                const active = target?.epicId === e.id && target?.storyId === s.id;
                const status = deriveStoryStatus(s, run);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => onTarget(active ? null : { epicId: e.id, storyId: s.id })}
                      title={active ? 'Targeted — click to clear (whole app)' : 'Set as the Build target'}
                      className="row"
                      style={{
                        width: '100%',
                        gap: 8,
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                        padding: '6px 10px',
                        border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius)',
                        background: active ? 'var(--panel)' : 'transparent',
                        cursor: 'pointer',
                        font: 'inherit',
                        color: 'inherit',
                      }}
                    >
                      <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {active ? '▸ ' : ''}{s.title || 'Untitled story'}
                      </span>
                      <StatusChip status={status} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
