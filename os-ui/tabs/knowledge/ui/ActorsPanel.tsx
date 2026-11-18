/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The actor registry list — a roster you open, not a row of input boxes
 * USER STORY: As a process owner I must see each actor with its description and how many steps use
 *             it, and click it to edit or delete it in a panel that shows what I am changing.
 * ARCHITECTURE:
 *   - LIST + ADD only. The inline name input, the row category select and the row ✕ are gone: a row
 *     opens `ActorInspector` (`onSelect`), which owns every edit and the delete flow. Editing the
 *     name on the row was the "fragile" surface — it committed on blur, with no detail in sight.
 *   - Unknown-actor warnings (a step naming an actor the registry does not hold) are shown here as
 *     a block, because this panel is where the registry is curated.
 *   - Imports only `@core/*` and this tab; the add mutation is the pure `addActor`.
 */
'use client';

import { useState } from 'react';
import type { Workflow, ActorType } from '@tabs/knowledge/lib/schema';
import { ACTOR_TYPES, EXTERNAL_ACTORS } from '@tabs/knowledge/lib/schema';
import { actorWarnings, stepsUsingActor } from '@tabs/knowledge/lib/actor-registry';
import type { CommitOutcome } from '@tabs/knowledge/lib/commit-queue';
import { addActor } from '@tabs/knowledge/lib/step-edit';

const isExternal = (c: ActorType) => EXTERNAL_ACTORS.includes(c);

export default function ActorsPanel({
  workflow,
  canEdit,
  selectedActorId,
  onSelect,
  mutate,
}: {
  workflow: Workflow;
  canEdit: boolean;
  selectedActorId: string | null;
  /** Open an actor in the inspector. */
  onSelect: (actorId: string) => void;
  mutate: (next: Workflow) => Promise<CommitOutcome>;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ActorType>('Human');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);

  const actors = workflow.actors;
  const warnings = actorWarnings(workflow);

  return (
    <div className="actors-panel">
      <div className="section-title">Actors</div>

      {warnings.length > 0 && (
        <div className="ap-warn">
          <strong>
            {warnings.length} step{warnings.length === 1 ? '' : 's'} name an actor that is not in this registry.
          </strong>
          <ul className="ap-warn-list">
            {warnings.map((w) => (
              <li key={w.stepId}>
                <span className="mono">{w.stepId}</span> — “{w.actorName}” ({w.actorCategory})
              </li>
            ))}
          </ul>
          <span className="muted" style={{ fontSize: 12 }}>
            Open the step and pick a registry actor, or add the actor below.
          </span>
        </div>
      )}

      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

      {actors.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No actors yet — add the first one below.</div>
      ) : (
        <div className="ap-list">
          {actors.map((a) => {
            const uses = stepsUsingActor(workflow, a).length;
            return (
              <button
                key={a.id ?? `${a.category}:${a.name}`}
                className={`ap-actor${isExternal(a.category) ? ' external' : ''}${a.id && a.id === selectedActorId ? ' selected' : ''}`}
                onClick={() => a.id && onSelect(a.id)}
                title="Open this actor"
              >
                <span
                  className="ap-dot"
                  style={{ background: isExternal(a.category) ? 'transparent' : 'var(--gold-text)', borderColor: 'var(--gold-text)' }}
                />
                <span className="ap-body">
                  <span className="ap-head">
                    <span className="ap-name">{a.name}</span>
                    <span className={`badge ${isExternal(a.category) ? 'muted' : 'ok'}`}>{a.category}</span>
                    {isExternal(a.category) && <span className="badge muted ap-ext-badge">external</span>}
                    <span className="ap-uses muted">{uses} step{uses === 1 ? '' : 's'}</span>
                  </span>
                  {a.description
                    ? <span className="ap-desc">{a.description}</span>
                    : <span className="ap-desc faint">No description yet.</span>}
                </span>
                <span className="ap-go">→</span>
              </button>
            );
          })}
        </div>
      )}

      {canEdit && (
        <form
          className="ap-add"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || adding) return;
            setAdding(true);
            setErr('');
            void mutate(addActor(workflow, {
              name: trimmed,
              category,
              ...(description.trim() ? { description: description.trim() } : {}),
            })).then((outcome) => {
              setAdding(false);
              if (!outcome.ok) { setErr(outcome.error); return; }
              setName('');
              setCategory('Human');
              setDescription('');
            });
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
            <button className="btn sm" type="submit" disabled={!name.trim() || adding}>+ Add actor</button>
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
  display: flex; align-items: flex-start; gap: 11px; width: 100%; text-align: left; cursor: pointer;
  padding: 11px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
  font-family: var(--font-body); color: var(--text);
}
.ap-actor:hover { border-color: var(--gold-line); background: var(--gold-soft); }
.ap-actor.selected { border-color: var(--gold-line); box-shadow: inset 2px 0 0 var(--gold-text); }
/* External actors: dashed frame echoes their dashed swimlane lane. */
.ap-actor.external { border-style: dashed; border-color: var(--border-strong); }
.ap-dot { width: 9px; height: 9px; border-radius: 3px; border: 1.5px solid; margin-top: 5px; flex-shrink: 0; }
.ap-actor.external .ap-dot { border-style: dashed; }
.ap-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ap-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.ap-name { font-size: 14px; font-weight: 600; }
.ap-ext-badge { font-size: 10px; }
.ap-uses { font-size: 11.5px; }
.ap-desc { font-size: 12.5px; color: var(--text-muted); }
.ap-desc.faint { color: var(--text-faint); font-style: italic; }
.ap-go { color: var(--gold-text); margin-top: 2px; }
.ap-warn {
  display: flex; flex-direction: column; gap: 6px; font-size: 12.5px;
  padding: 11px 13px; margin-top: 10px; border-radius: 10px;
  border: 1px solid rgba(192,57,43,0.4); background: rgba(192,57,43,0.05);
}
.ap-warn-list { margin: 0; padding-left: 18px; }
.ap-add { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.ap-add-row { display: flex; gap: 8px; align-items: center; }
.ap-add input, .ap-add select {
  font-family: var(--font-body); font-size: 13px; padding: 6px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
`;
