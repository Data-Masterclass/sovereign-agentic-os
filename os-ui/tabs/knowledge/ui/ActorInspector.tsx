/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The actor inspector — an actor's details, its steps, and a delete that asks first
 * USER STORY: As a process owner I must be able to open an actor, see what it is and where it is
 *             used, rename it with the steps following, and delete it for good.
 * ARCHITECTURE:
 *   - The same vocabulary as `StepInspector`: a controlled draft, one Save, a `• unsaved` marker, an
 *     unsaved-changes guard on close, and an inline error when the commit fails. The registry row
 *     used to BE the input field (`defaultValue` + `onBlur`), with no detail view at all.
 *   - Rename/category changes go through `updateActor`, which rewrites every referencing step in
 *     the SAME mutation — one commit, never a window where the steps disagree with the registry.
 *   - Delete is a question, not a default: an actor in use offers "reassign to …" or "clear the
 *     steps"; an unused actor deletes outright. `removeActor` holds both shapes.
 *   - Every commit is a REDUCER over the freshly-read document (`lib/workflow-commit.ts`), never a
 *     snapshot of this render's `workflow` prop — otherwise a save here reverts whatever landed
 *     between the render and the click.
 *   - Dirtiness is REPORTED UP (`onDirtyChange`); the unsaved-changes prompt lives in WorkflowView,
 *     which owns every way out of this panel (another actor, another panel, a step jump).
 *   - An actor of category `Agent` also carries its LONG PROMPT here: one more controlled field in
 *     the same draft, reported through the same `onDirtyChange` and saved by the same reducer, and
 *     beneath it a read-only preview of the `AGENT.md` the scaffold would write — built by the
 *     scaffold's own `actorAgentMd`, never a second copy of the format, so the preview cannot drift
 *     from what the Agents tab receives.
 *   - Imports only `@core/*` and this tab; all mutations are the pure helpers in `lib/step-edit.ts`.
 *     The preview comes from `lib/actor-prompt.ts` precisely because that module does NOT import
 *     the Agents tab's System schema, which must not reach the browser bundle.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import type { Workflow, Actor, ActorType } from '@tabs/knowledge/lib/schema';
import { ACTOR_TYPES, EXTERNAL_ACTORS } from '@tabs/knowledge/lib/schema';
import { stepsUsingActor } from '@tabs/knowledge/lib/actor-registry';
import { actorAgentMd } from '@tabs/knowledge/lib/actor-prompt';
import type { CommitOutcome } from '@tabs/knowledge/lib/commit-queue';
import type { WorkflowReducer } from '@tabs/knowledge/lib/workflow-commit';
import { updateActor, removeActor } from '@tabs/knowledge/lib/step-edit';

const isExternal = (c: ActorType) => EXTERNAL_ACTORS.includes(c);

export default function ActorInspector({
  workflow,
  actor,
  canEdit,
  mutate,
  onDirtyChange,
  onSelectStep,
  onClose,
}: {
  workflow: Workflow;
  actor: Actor;
  canEdit: boolean;
  mutate: (reduce: WorkflowReducer) => Promise<CommitOutcome>;
  /** Report the draft state up, so the parent can guard every way out of here. */
  onDirtyChange: (state: { dirty: boolean; save: () => Promise<boolean> }) => void;
  /** Jump to a step that uses this actor (opens the visual flow with it selected). */
  onSelectStep: (stepId: string) => void;
  onClose: () => void;
}) {
  const used = stepsUsingActor(workflow, actor);
  const others = workflow.actors.filter((a) => a.id !== actor.id);

  const saved = {
    name: actor.name,
    category: actor.category,
    description: actor.description ?? '',
    prompt: actor.prompt ?? '',
  };
  const [name, setName] = useState(saved.name);
  const [category, setCategory] = useState<ActorType>(saved.category);
  const [description, setDescription] = useState(saved.description);
  const [prompt, setPrompt] = useState(saved.prompt);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>(others[0]?.id ?? '');

  const dirty = name.trim() !== saved.name.trim()
    || category !== saved.category
    || description.trim() !== saved.description.trim()
    || prompt.trim() !== saved.prompt.trim();

  /**
   * The AGENT.md the agent system will carry for this actor — the SCAFFOLD'S OWN builder
   * (`actorAgentMd`), never a second copy of the format, so what the author reads here is
   * byte-for-byte what `scaffoldSystem` writes. The draft prompt is previewed live; the
   * SAVED name and category drive the step lookup, because the steps only follow a rename
   * once it is saved and a draft name would blank the step list mid-typing.
   */
  const previewActor: Actor = { ...actor, prompt };
  const agentMd = actorAgentMd(workflow, previewActor);
  // An Agent actor the scaffold would emit NO agent for: the preview must say so, or a file
  // nobody will build reads as a promise. (`planAgents` also drops an actor whose every step
  // is set to manual in the handover panel — a choice made over there, not here.)
  const noAgentYet = used.length === 0;

  async function commit(reduce: WorkflowReducer): Promise<boolean> {
    setSaving(true);
    setErr('');
    const outcome = await mutate(reduce);
    setSaving(false);
    if (!outcome.ok) { setErr(outcome.error); return false; }
    return true;
  }

  /** One mutation: the actor's fields AND every step that references it. */
  async function save(): Promise<boolean> {
    if (!dirty) return true;
    if (!name.trim()) { setErr('An actor needs a name.'); return false; }
    // The prompt rides the SAME patch — one reducer, one commit, so the registry, the steps
    // that reference the actor and the agent's instructions never disagree.
    return commit((fresh) => updateActor(fresh, actor.id ?? '', { name, category, description, prompt }));
  }

  function revert() {
    setName(saved.name);
    setCategory(saved.category);
    setDescription(saved.description);
    setPrompt(saved.prompt);
    setErr('');
  }

  // The latest `save` closure, so the parent's guard always saves the CURRENT draft.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    onDirtyChange({ dirty, save: () => saveRef.current() });
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange({ dirty: false, save: async () => true }), [onDirtyChange]);

  async function doDelete(opts: { reassignTo?: string; clearSteps?: boolean }) {
    const ok = await commit((fresh) => removeActor(fresh, actor.id ?? '', opts));
    if (ok) { setDeleting(false); onClose(); }
  }

  return (
    <div className="actor-inspector">
      <div className="ai-head">
        <h3 className="ai-title">
          {actor.name}
          <span className={`badge ${isExternal(actor.category) ? 'muted' : 'ok'}`} style={{ marginLeft: 9 }}>
            {actor.category}{isExternal(actor.category) ? ' · external' : ''}
          </span>
          {dirty && <span className="ai-dirty" title="Unsaved changes"> • unsaved</span>}
        </h3>
        <button className="btn ghost sm" onClick={onClose}>Close ✕</button>
      </div>

      {err && <div className="error ai-error">{err}</div>}

      <div className="ai-grid">
        <label className="ai-field">
          <span className="ai-label">Name</span>
          <input type="text" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="ai-field">
          <span className="ai-label">Category</span>
          <select value={category} disabled={!canEdit} onChange={(e) => setCategory(e.target.value as ActorType)}>
            {ACTOR_TYPES.map((c) => (
              <option key={c} value={c}>{c}{isExternal(c) ? ' (external)' : ''}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="ai-field" style={{ marginTop: 12 }}>
        <span className="ai-label">Description</span>
        <textarea
          rows={3}
          value={description}
          disabled={!canEdit}
          placeholder="What this actor does in this process — e.g. Nightly REST ingestion of leads."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {/* ── An actor that IS an agent: its long prompt, and the AGENT.md it compiles into ── */}
      {category === 'Agent' && (
        <>
          <label className="ai-field" style={{ marginTop: 14 }}>
            <span className="ai-label">Prompt — this agent&rsquo;s instructions</span>
            <textarea
              className="ai-prompt mono"
              rows={14}
              value={prompt}
              disabled={!canEdit}
              placeholder={
                '# Triage Bot\n\nYou are the triage desk for inbound submissions.\n'
                + 'Work only from the governed context you are given…'
              }
              onChange={(e) => setPrompt(e.target.value)}
            />
            <span className="ai-hint muted">
              Markdown. It becomes the head of this agent&rsquo;s <code>AGENT.md</code>; the steps you
              assigned to this actor are appended below it automatically.
            </span>
          </label>

          <div className="ai-section-label">
            {noAgentYet ? 'AGENT.md — no agent yet, assign a step' : 'AGENT.md the agent system will carry'}
          </div>
          {noAgentYet && (
            <div className="muted ai-preview-note">
              No step uses this actor, so building an agent system from this workflow creates
              <strong> no agent</strong> for it. Assign it a step and this becomes its{' '}
              <code>AGENT.md</code>.
            </div>
          )}
          <pre className="ai-preview mono" aria-label="Generated AGENT.md preview">{agentMd}</pre>
        </>
      )}

      {canEdit && (
        <div className="ai-save-row">
          <button className="btn sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <span className="spin" /> : 'Save'}
          </button>
          <button className="btn ghost sm" disabled={!dirty || saving} onClick={revert}>Revert</button>
          <span className="ai-hint muted">
            {dirty
              ? 'Unsaved changes — Save renames this actor on every step that uses it.'
              : 'All changes saved.'}
          </span>
        </div>
      )}

      <div className="ai-section-label">Used by {used.length} step{used.length === 1 ? '' : 's'}</div>
      {used.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          No step uses this actor yet — pick it in a step&rsquo;s inspector to assign it.
        </div>
      ) : (
        <div className="ai-steps">
          {used.map((s) => (
            <button key={s.id} className="ai-step" onClick={() => onSelectStep(s.id)} title="Open this step">
              <span className="ai-step-title">{s.title}</span>
              <span className="mono ai-step-id">{s.id}</span>
              <span className="ai-step-go">→</span>
            </button>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="ai-delete">
          {!deleting ? (
            <button className="btn ghost sm ai-del-btn" disabled={saving} onClick={() => setDeleting(true)}>
              Delete actor
            </button>
          ) : used.length === 0 ? (
            <div className="ai-guard">
              <span>Delete “{actor.name}”? No step uses it.</span>
              <button className="btn sm" disabled={saving} onClick={() => void doDelete({})}>Delete</button>
              <button className="btn ghost sm" onClick={() => setDeleting(false)}>Cancel</button>
            </div>
          ) : (
            <div className="ai-guard ai-guard-col">
              <span>
                “{actor.name}” is used by {used.length} step{used.length === 1 ? '' : 's'}. What should happen to
                {used.length === 1 ? ' it' : ' them'}?
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {others.length > 0 && (
                  <>
                    <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                      {others.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} — {a.category}</option>
                      ))}
                    </select>
                    <button className="btn sm" disabled={saving || !reassignTo}
                      onClick={() => void doDelete({ reassignTo })}>
                      Reassign &amp; delete
                    </button>
                  </>
                )}
                <button className="btn ghost sm" disabled={saving}
                  onClick={() => void doDelete({ clearSteps: true })}>
                  Clear the steps &amp; delete
                </button>
                <button className="btn ghost sm" onClick={() => setDeleting(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{ActorInspectorStyles}</style>
    </div>
  );
}

const ActorInspectorStyles = `
.actor-inspector {
  border: 1px solid var(--gold-line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 18px 20px;
  margin-top: 14px;
}
.ai-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 10px; }
.ai-title {
  font-family: var(--font-head); font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.3px;
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
}
.ai-dirty { font-family: var(--font-body); font-size: 12px; font-weight: 500; color: var(--gold-text); }
.ai-guard {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12.5px;
  padding: 9px 11px; margin-bottom: 12px;
  border: 1px solid var(--gold-line); border-radius: 9px; background: var(--gold-soft);
}
.ai-guard-col { flex-direction: column; align-items: flex-start; }
.ai-guard select {
  font-family: var(--font-body); font-size: 12.5px; padding: 6px 8px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.ai-error { margin: 0 0 12px; }
.ai-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.ai-field { display: flex; flex-direction: column; gap: 5px; }
.ai-label { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-muted); }
.ai-field input, .ai-field select, .ai-field textarea {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.ai-prompt { min-height: 220px; line-height: 1.5; resize: vertical; }
.ai-preview-note { font-size: 12.5px; margin-bottom: 8px; }
.ai-preview {
  margin: 0; padding: 12px 14px; max-height: 340px; overflow: auto; white-space: pre-wrap;
  font-size: 12px; line-height: 1.55; color: var(--text-muted);
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg);
}
.ai-save-row { display: flex; align-items: center; gap: 9px; margin-top: 12px; flex-wrap: wrap; }
.ai-hint { font-size: 12px; }
.ai-section-label {
  font-family: var(--font-head); font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px;
  text-transform: uppercase; color: var(--gold-text); margin: 18px 0 8px;
}
.ai-steps { display: flex; flex-direction: column; gap: 7px; }
.ai-step {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
  padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  font-family: var(--font-body); color: var(--text);
}
.ai-step:hover { border-color: var(--gold-line); background: var(--gold-soft); }
.ai-step-title { font-size: 13px; flex: 1; }
.ai-step-id { font-size: 11px; color: var(--text-faint); }
.ai-step-go { color: var(--gold-text); }
.ai-delete { margin-top: 18px; }
.ai-del-btn { color: var(--danger); }
`;
