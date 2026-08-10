/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { emptySpec, specHasContent, type StorySpec } from '@/lib/software/story-spec';
import { useConfirm } from '@/components/lifecycle/ConfirmDialog';
import AutoGrowTextarea from '@/components/core/AutoGrowTextarea';

/**
 * StorySpecEditor — the Design-stage SPECIFICATION editor for ONE user story. It shows
 * three editable lists — Features · Non-functional requirements · Rules — the direct-
 * manipulation twin of the Design conversation (the assistant's spec suggestions fold
 * straight into these lists). Controlled: `value` is the story's spec, `onChange`
 * persists the whole spec through the host's governed path (patchAppDesign).
 *
 * Roomy one-artifact-per-row layout: every item is its own auto-growing textarea (edit
 * in place, save-on-blur) and each list ends with a matching add row — no wall of tiny
 * boxes. A blank list reads as an invitation ("Add the first …"), never a dead "None".
 */

const LISTS: { key: keyof StorySpec; label: string; noun: string; hint: string; placeholder: string }[] = [
  { key: 'features', label: 'Features', noun: 'feature', hint: 'What it does', placeholder: 'e.g. Send a reminder email' },
  { key: 'nfrs', label: 'Non-functional requirements', noun: 'requirement', hint: 'How well it does it', placeholder: 'e.g. Renders in under 200ms' },
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
        .sse-lists { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
      `}</style>
    </div>
  );
}

/** One editable list — a titled block of one-per-row auto-grow items + a matching add row. */
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
  // Save-on-blur: an emptied item is dropped; an unchanged trim leaves the list stable.
  const commit = (i: number, next: string) => {
    const v = next.trim();
    if (!v) { onChange(items.filter((_, j) => j !== i)); return; }
    if (v === items[i]) return;
    onChange(items.map((it, j) => (j === i ? v : it)));
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
        <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 8px' }}>
          {canEdit ? `Add the first ${noun} below →` : `No ${noun}s yet.`}
        </p>
      ) : (
        <ul className="spl-items">
          {items.map((it, i) => (
            <li key={i} className="spl-item">
              {canEdit ? (
                <SpecItemRow value={it} placeholder={placeholder} onCommit={(v) => commit(i, v)} onRemove={() => { void remove(i); }} />
              ) : (
                <span style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>{it}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="spl-add">
          <AutoGrowTextarea
            minRows={2}
            value={entry}
            placeholder={placeholder}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); add(); } }}
            aria-label={`Add a ${noun}`}
          />
          <button type="button" className="btn ghost sm" onClick={add} disabled={!entry.trim()}>Add {noun}</button>
        </div>
      ) : null}
      <style jsx>{`
        .spl { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--panel); }
        .spl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .spl-items { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .spl-item { display: flex; }
        .spl-add { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
        .spl-add :global(textarea) { flex: 1; min-width: 0; }
      `}</style>
    </div>
  );
}

/** One saved item — an in-place auto-grow editor with save-on-blur + a remove button. */
function SpecItemRow({
  value, placeholder, onCommit, onRemove,
}: {
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <div className="sir">
      <AutoGrowTextarea
        minRows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text)}
      />
      <button type="button" className="icon-btn danger" title="Delete" onClick={onRemove}>✕</button>
      <style jsx>{`
        .sir { display: flex; gap: 8px; align-items: flex-start; width: 100%; }
        .sir :global(textarea) { flex: 1; min-width: 0; }
        .sir .icon-btn { margin-top: 6px; }
      `}</style>
    </div>
  );
}
