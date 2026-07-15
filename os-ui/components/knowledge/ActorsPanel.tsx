/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { Workflow, ActorType } from '@/lib/knowledge/schema';
import { ACTOR_TYPES, EXTERNAL_ACTORS } from '@/lib/knowledge/schema';
import { addActor, updateActor, removeActor } from '@/lib/knowledge/step-edit';

/**
 * Actor registry panel — the workflow's first-class actors. Every actor is a
 * described entity (name · category · description) across all five categories:
 * Human · Software · Agent · Customer · Partner. Customer and Partner are EXTERNAL
 * (outside the organisation) and are tagged as such. Steps pick their actor from
 * this registry in the StepInspector; this panel is where the registry is curated.
 */

const isExternal = (c: ActorType) => EXTERNAL_ACTORS.includes(c);

export default function ActorsPanel({
  workflow,
  canEdit,
  mutate,
}: {
  workflow: Workflow;
  canEdit: boolean;
  mutate: (next: Workflow) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ActorType>('Human');
  const [description, setDescription] = useState('');

  const actors = workflow.actors;

  return (
    <div className="actors-panel">
      <p className="hint" style={{ marginTop: 0 }}>
        The people, systems, agents and outside parties this workflow involves. Each is a
        described entity — give it a clear name and a one-line description of its role.
        <strong> Customer</strong> and <strong>Partner</strong> are <em>external</em> actors
        (outside the organisation); they show as distinct lanes in the visual flow.
      </p>

      <div className="section-title">Actors</div>
      {actors.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No actors yet — add the first one below.</div>
      ) : (
        <div className="ap-list">
          {actors.map((a) => (
            <div key={a.id ?? `${a.category}:${a.name}`} className={`ap-actor${isExternal(a.category) ? ' external' : ''}`}>
              <span
                className="ap-dot"
                style={{ background: isExternal(a.category) ? 'transparent' : 'var(--gold-text)', borderColor: 'var(--gold-text)' }}
              />
              <div className="ap-body">
                <div className="ap-head">
                  {canEdit ? (
                    <input
                      className="ap-name-input"
                      defaultValue={a.name}
                      onBlur={(e) => { if (a.id && e.target.value.trim() && e.target.value !== a.name) mutate(updateActor(workflow, a.id, { name: e.target.value })); }}
                    />
                  ) : (
                    <span className="ap-name">{a.name}</span>
                  )}
                  {canEdit && a.id ? (
                    <select
                      className="ap-cat-select"
                      value={a.category}
                      onChange={(e) => mutate(updateActor(workflow, a.id!, { category: e.target.value as ActorType }))}
                    >
                      {ACTOR_TYPES.map((c) => <option key={c} value={c}>{c}{isExternal(c) ? ' (external)' : ''}</option>)}
                    </select>
                  ) : (
                    <span className={`badge ${isExternal(a.category) ? 'muted' : 'ok'}`}>{a.category}</span>
                  )}
                  {isExternal(a.category) && <span className="badge muted ap-ext-badge">external</span>}
                </div>
                {canEdit && a.id ? (
                  <input
                    className="ap-desc-input"
                    defaultValue={a.description ?? ''}
                    placeholder="Describe this actor's role — e.g. Nightly REST ingestion"
                    onBlur={(e) => { if (a.id && e.target.value !== (a.description ?? '')) mutate(updateActor(workflow, a.id, { description: e.target.value })); }}
                  />
                ) : (
                  a.description && <div className="ap-desc">{a.description}</div>
                )}
              </div>
              {canEdit && a.id && (
                <button className="ap-x" title="Remove actor" onClick={() => mutate(removeActor(workflow, a.id!))}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <form
          className="ap-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            mutate(addActor(workflow, { name: name.trim(), category, ...(description.trim() ? { description: description.trim() } : {}) }));
            setName('');
            setCategory('Human');
            setDescription('');
          }}
        >
          <div className="ap-add-row">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Actor name — e.g. Salesforce API" style={{ flex: 1 }} />
            <select value={category} onChange={(e) => setCategory(e.target.value as ActorType)}>
              {ACTOR_TYPES.map((c) => <option key={c} value={c}>{c}{isExternal(c) ? ' (external)' : ''}</option>)}
            </select>
          </div>
          <div className="ap-add-row">
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional) — its role in this workflow" style={{ flex: 1 }} />
            <button className="btn sm" type="submit" disabled={!name.trim()}>+ Add actor</button>
          </div>
        </form>
      )}

      <style>{ActorsStyles}</style>
    </div>
  );
}

const ActorsStyles = `
.ap-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.ap-actor {
  display: flex; align-items: flex-start; gap: 11px;
  padding: 11px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
}
/* External actors: dashed frame echoes their dashed swimlane lane. */
.ap-actor.external { border-style: dashed; border-color: var(--border-strong); }
.ap-dot { width: 9px; height: 9px; border-radius: 3px; border: 1.5px solid; margin-top: 5px; flex-shrink: 0; }
.ap-actor.external .ap-dot { border-style: dashed; }
.ap-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ap-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.ap-name { font-size: 14px; font-weight: 600; }
.ap-ext-badge { font-size: 10px; }
.ap-name-input, .ap-desc-input, .ap-cat-select, .ap-add input, .ap-add select {
  font-family: var(--font-body); font-size: 13px; padding: 6px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.ap-name-input { font-weight: 600; min-width: 160px; }
.ap-desc-input { width: 100%; }
.ap-desc { font-size: 12.5px; color: var(--text-muted); }
.ap-x { background: none; border: none; cursor: pointer; color: var(--text-faint); font-size: 13px; padding: 2px 4px; line-height: 1; }
.ap-x:hover { color: var(--danger); }
.ap-add { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.ap-add-row { display: flex; gap: 8px; align-items: center; }
`;
