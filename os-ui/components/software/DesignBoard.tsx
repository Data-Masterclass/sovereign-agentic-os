/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AppEpic, AppStory } from '@/lib/software/apps';

/**
 * DesignBoard — the Design-stage EPIC + user-story editor, rebuilt as a JIRA-like-but-
 * simpler, Apple-clean surface that stays legible with MANY epics/stories (the old flat
 * editor fell apart past a handful). The shape:
 *
 *   • a calm LIST of epics, each a collapsible row showing its title, a one-line
 *     description, and a story count — collapsed by default so a big backlog reads as a
 *     tidy index, not a wall of textareas;
 *   • expanding an epic reveals its description, the technical/UX/governance
 *     requirements, and its stories (each an "As a … I want … so that …" line + an
 *     acceptance criterion), with inline add / edit / remove throughout;
 *   • clear empty AND populated states, generous spacing, one gold accent — no cards-in-
 *     cards, no default-Inter noise; it rides the existing `.grant-block` / badge grammar.
 *
 * Purely CONTROLLED: `epics` is the value, `onSave` persists the whole array through the
 * host's governed path (patchAppDesign). It holds only local draft + which-epic-open UI
 * state; it never fetches or mutates server state itself.
 */

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function emptyEpic(): AppEpic {
  return { id: rid('epic'), title: '', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] };
}
function emptyStory(): AppStory {
  return { id: rid('story'), title: '', asA: '', iWant: '', soThat: '', acceptance: '' };
}

export default function DesignBoard({
  epics,
  canEdit,
  onSave,
}: {
  epics: AppEpic[];
  canEdit: boolean;
  onSave: (epics: AppEpic[]) => void;
}) {
  const [draft, setDraft] = useState<AppEpic[]>(epics);
  const [open, setOpen] = useState<Set<string>>(() => new Set(epics.length === 1 ? epics.map((e) => e.id) : []));
  useEffect(() => { setDraft(epics); }, [epics]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(epics), [draft, epics]);
  const storyTotal = draft.reduce((n, e) => n + e.stories.length, 0);

  const patchEpic = (id: string, fn: (e: AppEpic) => AppEpic) =>
    setDraft((d) => d.map((e) => (e.id === id ? fn(e) : e)));
  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const addEpic = () => {
    const e = emptyEpic();
    setDraft((d) => [...d, e]);
    setOpen((s) => new Set(s).add(e.id));
  };

  return (
    <div className="db">
      <div className="db-head">
        <div>
          <div className="db-count">
            {draft.length === 0 ? 'No EPICs yet' : `${draft.length} EPIC${draft.length === 1 ? '' : 's'} · ${storyTotal} stor${storyTotal === 1 ? 'y' : 'ies'}`}
          </div>
          <p className="hint" style={{ margin: '2px 0 0' }}>
            Shape the work as EPICs and user stories. Collapse an EPIC to keep the backlog legible; expand to edit it.
          </p>
        </div>
        {canEdit ? (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {draft.length > 1 ? (
              <button className="btn ghost sm" onClick={() => setOpen((s) => s.size === draft.length ? new Set() : new Set(draft.map((e) => e.id)))}>
                {open.size === draft.length ? 'Collapse all' : 'Expand all'}
              </button>
            ) : null}
            <button className="btn sm" onClick={addEpic}>+ Add EPIC</button>
          </div>
        ) : null}
      </div>

      {draft.length === 0 ? (
        <div className="db-empty">
          <p className="muted" style={{ margin: 0 }}>Start with one EPIC — a chunk of value — then add the user stories under it.</p>
          {canEdit ? <button className="btn sm" style={{ marginTop: 10 }} onClick={addEpic}>+ Add your first EPIC</button> : null}
        </div>
      ) : (
        <div className="db-list">
          {draft.map((epic, idx) => (
            <EpicRow
              key={epic.id}
              epic={epic}
              index={idx}
              open={open.has(epic.id)}
              canEdit={canEdit}
              onToggle={() => toggle(epic.id)}
              onPatch={(fn) => patchEpic(epic.id, fn)}
              onRemove={() => setDraft((d) => d.filter((x) => x.id !== epic.id))}
            />
          ))}
        </div>
      )}

      {canEdit ? (
        <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button className="btn" disabled={!dirty} onClick={() => onSave(draft)}>Save design</button>
          {dirty ? <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span> : <span className="muted" style={{ fontSize: 12 }}>Saved</span>}
        </div>
      ) : null}

      <style jsx>{`
        .db { margin-top: 4px; }
        .db-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .db-count { font-weight: 600; font-size: 13.5px; }
        .db-empty {
          margin-top: 14px; padding: 22px; border: 1px dashed var(--border-strong, var(--border));
          border-radius: 10px; text-align: center; background: var(--tile, var(--panel));
        }
        .db-list { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
      `}</style>
    </div>
  );
}

/** One epic — a collapsible row. Collapsed: title + summary + story count. Expanded: editor. */
function EpicRow({
  epic, index, open, canEdit, onToggle, onPatch, onRemove,
}: {
  epic: AppEpic;
  index: number;
  open: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onPatch: (fn: (e: AppEpic) => AppEpic) => void;
  onRemove: () => void;
}) {
  const stories = epic.stories;
  const reqCount = (['technical', 'ux', 'governance'] as const).filter((k) => epic.requirements[k].trim()).length;

  const setStory = (sid: string, fn: (s: AppStory) => AppStory) =>
    onPatch((e) => ({ ...e, stories: e.stories.map((s) => (s.id === sid ? fn(s) : s)) }));

  return (
    <div className="db-epic">
      <div className="db-epic-bar">
        <button type="button" className="db-chevron" aria-expanded={open} onClick={onToggle} aria-label={open ? 'Collapse EPIC' : 'Expand EPIC'}>
          <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>▶</span>
        </button>
        <div className="db-epic-headline" onClick={onToggle} style={{ cursor: 'pointer' }}>
          <span className="db-epic-tag">EPIC {index + 1}</span>
          <span className="db-epic-title">{epic.title.trim() || <span className="muted">Untitled EPIC</span>}</span>
          {!open && epic.description.trim() ? <span className="db-epic-desc muted">— {epic.description.trim()}</span> : null}
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <span className="badge muted" title="User stories">{stories.length} stor{stories.length === 1 ? 'y' : 'ies'}</span>
          {!open && reqCount > 0 ? <span className="badge" title="Requirements set">{reqCount} req</span> : null}
          {canEdit ? <button className="icon-btn danger" title="Remove EPIC" onClick={onRemove}>✕</button> : null}
        </div>
      </div>

      {open ? (
        <div className="db-epic-body">
          <input
            type="text" value={epic.title} readOnly={!canEdit}
            placeholder="EPIC title (a chunk of value)" className="db-title-input"
            onChange={(e) => onPatch((x) => ({ ...x, title: e.target.value }))}
          />
          <textarea
            value={epic.description} readOnly={!canEdit} rows={2}
            placeholder="What this EPIC delivers, in a sentence"
            style={{ width: '100%', marginTop: 8 }}
            onChange={(e) => onPatch((x) => ({ ...x, description: e.target.value }))}
          />

          <div className="db-reqs">
            {(['technical', 'ux', 'governance'] as const).map((k) => (
              <div key={k}>
                <label className="comp-label" style={{ textTransform: 'capitalize' }}>{k} requirements</label>
                <textarea
                  value={epic.requirements[k]} readOnly={!canEdit} rows={2} style={{ width: '100%' }}
                  placeholder={k === 'technical' ? 'e.g. reads the invoices dataset' : k === 'ux' ? 'e.g. one-click send' : 'e.g. writes held for approval'}
                  onChange={(e) => onPatch((x) => ({ ...x, requirements: { ...x.requirements, [k]: e.target.value } }))}
                />
              </div>
            ))}
          </div>

          <div className="db-stories-head">
            <span className="comp-label" style={{ margin: 0 }}>User stories</span>
            {canEdit ? (
              <button className="btn ghost sm" onClick={() => onPatch((x) => ({ ...x, stories: [...x.stories, emptyStory()] }))}>+ Add story</button>
            ) : null}
          </div>

          {stories.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No stories yet.</div>
          ) : (
            <div className="db-stories">
              {stories.map((story, si) => (
                <div key={story.id} className="db-story">
                  <div className="db-story-top">
                    <span className="db-story-n">{index + 1}.{si + 1}</span>
                    <input
                      type="text" value={story.title} readOnly={!canEdit} placeholder="Story title"
                      style={{ flex: 1 }}
                      onChange={(e) => setStory(story.id, (s) => ({ ...s, title: e.target.value }))}
                    />
                    {canEdit ? (
                      <button className="icon-btn danger" title="Remove story" onClick={() => onPatch((x) => ({ ...x, stories: x.stories.filter((s) => s.id !== story.id) }))}>✕</button>
                    ) : null}
                  </div>
                  <div className="db-story-line">
                    <span className="muted">As a</span>
                    <input type="text" value={story.asA} readOnly={!canEdit} placeholder="role" onChange={(e) => setStory(story.id, (s) => ({ ...s, asA: e.target.value }))} />
                    <span className="muted">I want</span>
                    <input type="text" value={story.iWant} readOnly={!canEdit} placeholder="capability" onChange={(e) => setStory(story.id, (s) => ({ ...s, iWant: e.target.value }))} />
                    <span className="muted">so that</span>
                    <input type="text" value={story.soThat} readOnly={!canEdit} placeholder="benefit" onChange={(e) => setStory(story.id, (s) => ({ ...s, soThat: e.target.value }))} />
                  </div>
                  <input
                    type="text" value={story.acceptance} readOnly={!canEdit}
                    placeholder="Acceptance criterion — how we know it's done" style={{ width: '100%', marginTop: 6 }}
                    onChange={(e) => setStory(story.id, (s) => ({ ...s, acceptance: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <style jsx>{`
        .db-epic {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--panel);
          overflow: hidden;
          transition: border-color 0.14s, box-shadow 0.14s;
        }
        .db-epic:hover { border-color: var(--border-strong, var(--border)); }
        .db-epic-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
        .db-chevron {
          background: none; border: none; padding: 0; cursor: pointer;
          color: var(--text-faint); font-size: 10px; line-height: 1; display: inline-flex;
        }
        .db-epic-headline { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
        .db-epic-tag {
          font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--gold-text, var(--accent));
          text-transform: uppercase; flex-shrink: 0;
        }
        .db-epic-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-epic-desc { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-epic-body { padding: 4px 14px 14px; border-top: 1px solid var(--border); }
        .db-title-input { width: 100%; font-weight: 600; margin-top: 10px; }
        .db-reqs { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 12px; }
        .db-stories-head { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; }
        .db-stories { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
        .db-story {
          border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px;
          background: var(--tile, var(--bg-elevated, var(--panel)));
        }
        .db-story-top { display: flex; gap: 8px; align-items: center; }
        .db-story-n { font-size: 11px; font-weight: 600; color: var(--text-faint); flex-shrink: 0; min-width: 30px; }
        .db-story-line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
        .db-story-line .muted { font-size: 12px; }
        .db-story-line input { flex: 1; min-width: 110px; }
      `}</style>
    </div>
  );
}
