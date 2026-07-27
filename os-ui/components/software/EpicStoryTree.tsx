/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import {
  deriveStoryStatus,
  deriveEpicStatus,
  epicProgress,
  currentEpicIndex,
  storyProgress,
  type BuildRunSignals,
  type TreeStoryStatus,
  type EpicStatus,
} from '@/lib/software/story-tree';
import type { BuildTarget } from '@/lib/software/build-target';

/** The Design shapes the tree renders (mirrors SoftwareBuilder's Epic/Story). */
type Story = { id: string; title: string; status?: 'todo' | 'building' | 'done' };
type Epic = { id: string; title: string; stories: Story[] };

/** The story status chip — honest tones on the existing badge language. */
function StatusChip({ status }: { status: TreeStoryStatus }) {
  if (status === 'done') return <span className="badge ok">done ✓</span>;
  if (status === 'building') return <span className="badge warn">building</span>;
  if (status === 'blocked') return <span className="badge err">blocked</span>;
  return <span className="badge muted">to do</span>;
}

/** The epic-level state chip for the sequence. */
function EpicStateChip({ status }: { status: EpicStatus }) {
  if (status === 'done') return <span className="badge ok">done ✓</span>;
  if (status === 'in-progress') return <span className="badge warn">in progress</span>;
  return <span className="badge muted">not started</span>;
}

/** One selectable tree row — the shared button chrome (gold border when active). */
function NodeButton({
  active,
  onClick,
  title,
  children,
  emphasis = false,
  current = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  emphasis?: boolean;
  /** The CURRENT epic in the one-at-a-time sequence — a calm gold wash even when unselected. */
  current?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-current={current ? 'step' : undefined}
      onClick={onClick}
      title={title}
      className="row"
      style={{
        width: '100%',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
        textAlign: 'left',
        padding: emphasis ? '8px 10px' : '7px 10px',
        border: `1px solid ${active ? 'var(--gold)' : current ? 'var(--gold-line)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        background: active ? 'var(--panel)' : current ? 'var(--gold-soft)' : 'transparent',
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
 * The Build stage's EPIC & STORY tree — the one-at-a-time build journey. It reads
 * as an ORDERED checklist: a "General" umbrella on top (the whole app), then the
 * epics NUMBERED 1..n in sequence. Each epic carries an honest state (not started /
 * in progress / done, derived from its stories) and its story progress. The CURRENT
 * epic — the first that isn't done — is visually primary (a calm gold wash), and
 * when it completes a "Start Epic N ▸" affordance points at the next one.
 *
 * Clicking any node (General / an epic / a story) focuses the whole right side on
 * THAT scope; clicking the selected node again clears it. Status derivation is pure
 * (lib/software/story-tree.ts) and never fabricated.
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
  const select = (next: BuildTarget) => onTarget(next);

  const generalActive = target?.kind === 'app';
  const curIdx = currentEpicIndex(epics);

  return (
    <div className="grant-block">
      <div className="comp-label">Build journey</div>
      <p className="hint" style={{ marginTop: 4 }}>
        Build one epic at a time, in order. Pick an epic to focus the assistant on it — or General for the whole app.
      </p>

      {/* The "General" umbrella — the whole app, above the numbered sequence. */}
      <div style={{ marginTop: 10 }}>
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

      {total === 0 && epics.length === 0 ? (
        <div style={{ marginTop: 14 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            <strong>Build your app one epic at a time — start with Epic 1.</strong> No epics yet: design the
            backlog first and each epic appears here as a numbered step.
          </p>
          {onGoDesign ? (
            <button type="button" className="btn ghost" onClick={onGoDesign} style={{ marginTop: 8 }}>
              Design the epics →
            </button>
          ) : null}
        </div>
      ) : (
        <ol className="sw-epic-sequence" style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, display: 'grid', gap: 12 }}>
          {epics.map((e, i) => {
            const epicActive = target?.kind === 'epic' && target.epicId === e.id;
            const status = deriveEpicStatus(e);
            const isCurrent = i === curIdx;
            const { built: eb, total: et } = epicProgress(e);
            return (
              <li key={e.id}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  {/* Ordinal rail — the sequence number, calm and legible. */}
                  <span className={`sw-epic-ordinal${status === 'done' ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}`} aria-hidden="true">
                    {status === 'done' ? '✓' : i + 1}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <NodeButton
                      active={epicActive}
                      current={isCurrent && !epicActive}
                      onClick={() => toggle({ kind: 'epic', epicId: e.id })}
                      title={epicActive ? 'Selected — click to clear' : 'Focus the assistant on this epic'}
                    >
                      <span className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: isCurrent ? 600 : 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.title || `Epic ${i + 1}`}
                        </span>
                      </span>
                      <span className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        {et > 0 ? <span className="muted" style={{ fontSize: 11 }}>{eb}/{et}</span> : null}
                        <EpicStateChip status={status} />
                      </span>
                    </NodeButton>

                    {/* The current epic's stories are shown inline; completed / upcoming
                        epics stay collapsed to keep the sequence calm. */}
                    {isCurrent ? (
                      e.stories.length === 0 ? (
                        <p className="hint" style={{ margin: '6px 0 0' }}>No stories in this epic yet — add them in Design.</p>
                      ) : (
                        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
                          {e.stories.map((s) => {
                            const active = target?.kind === 'story' && target.epicId === e.id && target.storyId === s.id;
                            const sStatus = deriveStoryStatus(s, run);
                            return (
                              <li key={s.id}>
                                <NodeButton
                                  active={active}
                                  onClick={() => toggle({ kind: 'story', epicId: e.id, storyId: s.id })}
                                  title={active ? 'Selected — click to clear' : 'Focus the assistant on this story'}
                                >
                                  <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {active ? '▸ ' : ''}{s.title || 'Untitled story'}
                                  </span>
                                  <StatusChip status={sStatus} />
                                </NodeButton>
                              </li>
                            );
                          })}
                        </ul>
                      )
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* "Next epic" affordance — when a DONE epic is selected and a current epic
          still awaits, point the user at it: the natural one-at-a-time hand-off. */}
      {(() => {
        if (curIdx < 0) return null; // every epic done, or none.
        const cur = epics[curIdx];
        const selectedEpic = target?.kind === 'epic' ? epics.find((e) => e.id === target.epicId) : null;
        const onDoneEpic = selectedEpic ? deriveEpicStatus(selectedEpic) === 'done' : false;
        // Show when nothing is selected yet, or a completed epic is selected.
        const show = (!target || onDoneEpic) && !(target?.kind === 'epic' && target.epicId === cur.id);
        if (!show) return null;
        return (
          <button
            type="button"
            className="btn ghost"
            style={{ marginTop: 12 }}
            onClick={() => select({ kind: 'epic', epicId: cur.id })}
          >
            {built === 0 ? 'Start' : 'Continue with'} Epic {curIdx + 1} · {cur.title || 'current'} ▸
          </button>
        );
      })()}
    </div>
  );
}
