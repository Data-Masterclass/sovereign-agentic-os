/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { emptySpec, specHasContent, type StorySpec } from '@/lib/software/story-spec';
import { useConfirm } from '@/components/lifecycle/ConfirmDialog';

/**
 * StorySpecEditor — the Design-stage SPECIFICATION editor for ONE user story. It shows
 * three editable lists — Features · Non-functional requirements · Rules — the direct-
 * manipulation twin of the Design conversation (the assistant's spec suggestions fold
 * straight into these lists). Controlled: `value` is the story's spec, `onChange`
 * persists the whole spec through the host's governed path (patchAppDesign).
 *
 * Calm three-column layout, generous spacing, one add-row per list — no cards-in-cards.
 * A blank spec reads as an invitation ("what should this story do?"), never a wall.
 */

const LISTS: { key: keyof StorySpec; label: string; noun: string; hint: string; placeholder: string }[] = [
  { key: 'features', label: 'Features', noun: 'feature', hint: 'What it does', placeholder: 'e.g. Send a reminder email' },
  { key: 'nfrs', label: 'Non-functional requirements', noun: 'requirement', hint: 'How well', placeholder: 'e.g. Renders in under 200ms' },
  { key: 'rules', label: 'Rules', noun: 'rule', hint: 'Governance & business rules', placeholder: 'e.g. Writes are held for approval' },
];

export default function StorySpecEditor({
  value,
  canEdit,
  onChange,
  storyTitle,
}: {
  value: StorySpec | undefined;
  canEdit: boolean;
  onChange: (spec: StorySpec) => void;
  storyTitle?: string;
}) {
  const [draft, setDraft] = useState<StorySpec>(value ?? emptySpec());
  useEffect(() => { setDraft(value ?? emptySpec()); }, [value]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(value ?? emptySpec());

  const setList = (key: keyof StorySpec, items: string[]) => setDraft((d) => ({ ...d, [key]: items }));

  return (
    <div className="sse">
      {storyTitle ? <div className="sse-head">Specifying <strong>{storyTitle}</strong></div> : null}
      <p className="hint" style={{ marginTop: storyTitle ? 4 : 0 }}>
        Say what this story should do. The Build stage ticks each item against what actually gets built.
      </p>

      <div className="sse-lists">
        {LISTS.map((l) => (
          <SpecList
            key={l.key}
            label={l.label}
            noun={l.noun}
            hint={l.hint}
            placeholder={l.placeholder}
            items={draft[l.key]}
            canEdit={canEdit}
            onChange={(items) => setList(l.key, items)}
          />
        ))}
      </div>

      {canEdit ? (
        <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button className="btn" disabled={!dirty} onClick={() => onChange(draft)}>Save spec</button>
          {dirty ? <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>
            : specHasContent(value) ? <span className="muted" style={{ fontSize: 12 }}>Saved</span> : null}
        </div>
      ) : null}

      <style jsx>{`
        .sse { margin-top: 4px; }
        .sse-head { font-size: 13.5px; }
        .sse-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-top: 10px; }
      `}</style>
    </div>
  );
}

/** One editable list — a titled column with removable chips + an add row. */
function SpecList({
  label, noun, hint, placeholder, items, canEdit, onChange,
}: {
  label: string;
  noun: string;
  hint: string;
  placeholder: string;
  items: string[];
  canEdit: boolean;
  onChange: (items: string[]) => void;
}) {
  const confirm = useConfirm();
  const [entry, setEntry] = useState('');
  const remove = async (i: number) => {
    const ok = await confirm({
      title: `Delete this ${noun}?`,
      body: `“${items[i]}” will be removed from the spec. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) onChange(items.filter((_, j) => j !== i));
  };
  const add = () => {
    const v = entry.trim();
    if (!v) return;
    onChange([...items, v]);
    setEntry('');
  };
  return (
    <div className="spl">
      <div className="spl-head">
        <span className="comp-label" style={{ margin: 0 }}>{label}</span>
        <span className="muted" style={{ fontSize: 11 }}>{hint}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>None yet.</p>
      ) : (
        <ul className="spl-items">
          {items.map((it, i) => (
            <li key={i} className="spl-item">
              <span style={{ flex: 1, minWidth: 0 }}>{it}</span>
              {canEdit ? (
                <button type="button" className="icon-btn danger" title="Delete" onClick={() => { void remove(i); }}>✕</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
          <input
            type="text" value={entry} placeholder={placeholder}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="button" className="btn ghost sm" onClick={add} disabled={!entry.trim()}>Add</button>
        </div>
      ) : null}
      <style jsx>{`
        .spl { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
        .spl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .spl-items { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .spl-item {
          display: flex; align-items: center; gap: 8px; font-size: 13px;
          background: var(--tile, var(--bg-elevated, var(--panel)));
          border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px;
        }
      `}</style>
    </div>
  );
}
