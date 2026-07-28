/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type { AppEpic, AppStory } from '@/lib/software/apps';
import { clampEpicIndex } from '@/lib/software/story-tree';
import { specHasContent, type StorySpec } from '@/lib/software/story-spec';
import { useConfirm } from '@/components/lifecycle/ConfirmDialog';
import StorySpecEditor from './StorySpecEditor';

/**
 * DesignEpicDetail — the Design stage's ONE-EPIC-AT-A-TIME detail. It shows a single
 * epic with a prev/next switcher, VIEW-FIRST (clean read mode by default) with an
 * explicit Edit toggle that flips the epic's requirements + its stories' specs into
 * editors. Each user story is an EXPANDING row: collapsed to its title/summary, it
 * expands in place to reveal its Features · NFRs · Rules.
 *
 * Controlled: `epics` is the value; `onSave` persists the whole array through the host's
 * governed path (patchAppDesign). Local state = which epic is shown, read/edit mode, and
 * which stories are expanded.
 */

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
function emptyStory(): AppStory {
  return { id: rid('story'), title: '', asA: '', iWant: '', soThat: '', acceptance: '' };
}

export default function DesignEpicDetail({
  epics,
  canEdit,
  onSave,
  onActiveStory,
}: {
  epics: AppEpic[];
  canEdit: boolean;
  onSave: (epics: AppEpic[]) => void;
  /** Report the story the user is currently focused on (expanded), so the assistant can target it. */
  onActiveStory?: (ref: { epicId: string; storyId: string } | null) => void;
}) {
  const confirm = useConfirm();
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  // ONE open story at a time — the single source of truth for both the expanded row and
  // the assistant's active-story target. Cleared on epic nav so a hidden story is never
  // the write target.
  const [openStoryId, setOpenStoryId] = useState<string | null>(null);
  useEffect(() => { setIdx((i) => clampEpicIndex(i, epics.length)); }, [epics.length]);

  const at = clampEpicIndex(idx, epics.length);
  const epicId = epics[at]?.id;
  // Keep the parent's active-story in sync with the single open row (and clear it when
  // nothing is open or the epic changed). Runs after render — never a side effect inside
  // a setState updater.
  useEffect(() => {
    if (openStoryId && epicId) onActiveStory?.({ epicId, storyId: openStoryId });
    else onActiveStory?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openStoryId, epicId]);
  const gotoEpic = (next: number) => { setIdx(next); setEditing(false); setOpenStoryId(null); };

  if (epics.length === 0) {
    return (
      <div className="ded-empty">
        <p className="muted" style={{ margin: 0 }}>No EPICs yet.</p>
        {canEdit ? (
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => onSave([...epics, { id: rid('epic'), title: '', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] }])}>
            + Add your first EPIC
          </button>
        ) : null}
        <style jsx>{`.ded-empty { padding: 22px; border: 1px dashed var(--border); border-radius: 10px; text-align: center; }`}</style>
      </div>
    );
  }

  const epic = epics[at];

  const patchEpic = (fn: (e: AppEpic) => AppEpic) => onSave(epics.map((e, i) => (i === at ? fn(e) : e)));
  // Delete the whole EPIC (cascades its stories + specs) behind the OS-standard
  // confirm dialog. The epics.length effect re-clamps the shown index afterward.
  const removeEpic = async () => {
    const n = epic.stories.length;
    const ok = await confirm({
      title: 'Delete this EPIC?',
      body: `“${epic.title.trim() || 'Untitled EPIC'}” and its ${n} user stor${n === 1 ? 'y' : 'ies'} (with their specs) will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete EPIC',
      danger: true,
    });
    if (!ok) return;
    setEditing(false);
    setOpenStoryId(null);
    onSave(epics.filter((_, i) => i !== at));
  };
  const removeStory = async (story: AppStory) => {
    const ok = await confirm({
      title: 'Delete this user story?',
      body: `“${story.title.trim() || 'Untitled story'}” and its spec (features, NFRs, rules) will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete story',
      danger: true,
    });
    if (!ok) return;
    if (openStoryId === story.id) setOpenStoryId(null);
    patchEpic((e) => ({ ...e, stories: e.stories.filter((s) => s.id !== story.id) }));
  };
  const setStorySpec = (storyId: string, spec: StorySpec) =>
    patchEpic((e) => ({ ...e, stories: e.stories.map((s) => (s.id === storyId ? { ...s, spec } : s)) }));

  return (
    <div className="ded">
      {/* Prev/next epic switcher. */}
      <div className="ded-nav">
        <button className="btn ghost sm" disabled={at <= 0} onClick={() => gotoEpic(at - 1)} title="Previous EPIC">← Prev</button>
        <div className="ded-nav-mid">
          <span className="ded-tag">EPIC {at + 1} of {epics.length}</span>
          <span className="ded-title">{epic.title.trim() || 'Untitled EPIC'}</span>
        </div>
        <button className="btn ghost sm" disabled={at >= epics.length - 1} onClick={() => gotoEpic(at + 1)} title="Next EPIC">Next →</button>
      </div>

      <div className="ded-head-actions">
        <span className="badge muted">{epic.stories.length} stor{epic.stories.length === 1 ? 'y' : 'ies'}</span>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {canEdit && editing ? (
            <button className="btn ghost sm danger" onClick={removeEpic} title="Delete this EPIC and all its stories">Delete EPIC</button>
          ) : null}
          {canEdit ? (
            <button className={editing ? 'btn sm' : 'btn ghost sm'} onClick={() => setEditing((v) => !v)}>
              {editing ? 'Done editing' : 'Edit'}
            </button>
          ) : null}
        </div>
      </div>

      {/* Epic title + description + requirements — read-first, editable on toggle. */}
      {editing ? (
        <div className="ded-epic-edit">
          <input className="ded-input" value={epic.title} placeholder="EPIC title" onChange={(e) => patchEpic((x) => ({ ...x, title: e.target.value }))} />
          <textarea rows={2} value={epic.description} placeholder="What this EPIC delivers, in a sentence" onChange={(e) => patchEpic((x) => ({ ...x, description: e.target.value }))} style={{ width: '100%', marginTop: 8 }} />
          <div className="ded-reqs">
            {(['technical', 'ux', 'governance'] as const).map((k) => (
              <div key={k}>
                <label className="comp-label" style={{ textTransform: 'capitalize' }}>{k} requirements</label>
                <textarea rows={2} value={epic.requirements[k]} style={{ width: '100%' }} onChange={(e) => patchEpic((x) => ({ ...x, requirements: { ...x.requirements, [k]: e.target.value } }))} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="ded-epic-read">
          {epic.description ? <p className="hint" style={{ marginTop: 0 }}>{epic.description}</p> : null}
          <div className="ded-reqs-read">
            {(['technical', 'ux', 'governance'] as const).map((k) =>
              epic.requirements[k].trim() ? (
                <div key={k} className="ded-req">
                  <span className="comp-label" style={{ margin: 0, textTransform: 'capitalize' }}>{k}</span>
                  <span style={{ fontSize: 13 }}>{epic.requirements[k]}</span>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}

      {/* Stories — each an expanding spec row. */}
      <div className="ded-stories-head">
        <span className="comp-label" style={{ margin: 0 }}>User stories</span>
        {editing ? (
          <button className="btn ghost sm" onClick={() => patchEpic((x) => ({ ...x, stories: [...x.stories, emptyStory()] }))}>+ Add story</button>
        ) : null}
      </div>
      {epic.stories.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>No stories yet.</p>
      ) : (
        <div className="ded-stories">
          {epic.stories.map((story, si) => (
            <StoryRow
              key={story.id}
              story={story}
              n={`${at + 1}.${si + 1}`}
              canEdit={canEdit}
              editing={editing}
              open={openStoryId === story.id}
              onToggle={() => setOpenStoryId((cur) => (cur === story.id ? null : story.id))}
              onPatch={(fn) => patchEpic((e) => ({ ...e, stories: e.stories.map((s) => (s.id === story.id ? fn(s) : s)) }))}
              onRemove={() => { void removeStory(story); }}
              onSaveSpec={(spec) => setStorySpec(story.id, spec)}
            />
          ))}
        </div>
      )}

      <style jsx>{`
        .ded { display: flex; flex-direction: column; }
        .ded-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .ded-nav-mid { display: flex; flex-direction: column; align-items: center; min-width: 0; }
        .ded-tag { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--gold-text, var(--accent)); text-transform: uppercase; }
        .ded-title { font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .ded-head-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; }
        .ded-input { width: 100%; font-weight: 600; }
        .ded-reqs { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 12px; }
        .ded-reqs-read { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
        .ded-req { display: flex; flex-direction: column; gap: 2px; }
        .ded-epic-read, .ded-epic-edit { margin-top: 10px; }
        .ded-stories-head { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; }
        .ded-stories { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
      `}</style>
    </div>
  );
}

/** One story — a controlled expanding row (single-open; parent owns which is open). */
function StoryRow({
  story, n, canEdit, editing, open, onToggle, onPatch, onRemove, onSaveSpec,
}: {
  story: AppStory;
  n: string;
  canEdit: boolean;
  editing: boolean;
  open: boolean;
  onToggle: () => void;
  onPatch: (fn: (s: AppStory) => AppStory) => void;
  onRemove: () => void;
  onSaveSpec: (spec: StorySpec) => void;
}) {
  const spec = story.spec;
  const specced = specHasContent(spec);

  return (
    <div className="sr">
      <div className="sr-bar">
        <button type="button" className="sr-chev" aria-expanded={open} onClick={onToggle} title={open ? 'Collapse' : 'Expand'}>
          <span style={{ transform: open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 120ms' }}>▶</span>
        </button>
        <span className="sr-n">{n}</span>
        {editing ? (
          <input className="sr-title-input" value={story.title} placeholder="Story title" onChange={(e) => onPatch((s) => ({ ...s, title: e.target.value }))} />
        ) : (
          <button type="button" className="sr-title" onClick={onToggle}>{story.title.trim() || 'Untitled story'}</button>
        )}
        <span className={`badge ${specced ? 'ok' : 'muted'}`} style={{ fontSize: 10 }}>{specced ? 'specified' : 'no spec'}</span>
        {editing ? <button className="icon-btn danger" title="Remove story" onClick={onRemove}>✕</button> : null}
      </div>

      {open ? (
        <div className="sr-body">
          {editing ? (
            <div className="sr-line">
              <span className="muted">As a</span>
              <input value={story.asA} placeholder="role" onChange={(e) => onPatch((s) => ({ ...s, asA: e.target.value }))} />
              <span className="muted">I want</span>
              <input value={story.iWant} placeholder="capability" onChange={(e) => onPatch((s) => ({ ...s, iWant: e.target.value }))} />
              <span className="muted">so that</span>
              <input value={story.soThat} placeholder="benefit" onChange={(e) => onPatch((s) => ({ ...s, soThat: e.target.value }))} />
            </div>
          ) : story.asA || story.iWant || story.soThat ? (
            <p className="hint" style={{ marginTop: 0 }}>
              As a <strong>{story.asA || '…'}</strong>, I want <strong>{story.iWant || '…'}</strong> so that <strong>{story.soThat || '…'}</strong>.
            </p>
          ) : null}

          {editing ? (
            <StorySpecEditor value={spec} canEdit={canEdit} onChange={onSaveSpec} />
          ) : specced ? (
            <div className="sr-spec-read">
              {(['features', 'nfrs', 'rules'] as const).map((k) => {
                const items = spec?.[k] ?? [];
                if (items.length === 0) return null;
                const label = k === 'features' ? 'Features' : k === 'nfrs' ? 'Non-functional requirements' : 'Rules';
                return (
                  <div key={k} className="sr-spec-block">
                    <span className="comp-label" style={{ margin: 0 }}>{label}</span>
                    <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>No spec yet — press Edit to add its features, NFRs and rules.</p>
          )}
        </div>
      ) : null}

      <style jsx>{`
        .sr { border: 1px solid var(--border); border-radius: 9px; background: var(--panel); overflow: hidden; }
        .sr-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
        .sr-chev { background: none; border: none; padding: 0; cursor: pointer; color: var(--text-faint); font-size: 9px; width: 12px; }
        .sr-n { font-size: 10.5px; font-weight: 600; color: var(--text-faint); flex-shrink: 0; }
        .sr-title { flex: 1; min-width: 0; text-align: left; background: none; border: none; cursor: pointer; color: inherit; font: inherit; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0; }
        .sr-title-input { flex: 1; min-width: 0; font-weight: 600; }
        .sr-body { padding: 4px 12px 12px 30px; border-top: 1px solid var(--border); }
        .sr-line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .sr-line input { flex: 1; min-width: 110px; }
        .sr-line .muted { font-size: 12px; }
        .sr-spec-read { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
        .sr-spec-block ul { margin: 4px 0 0; padding-left: 18px; font-size: 13px; display: flex; flex-direction: column; gap: 3px; }
      `}</style>
    </div>
  );
}
