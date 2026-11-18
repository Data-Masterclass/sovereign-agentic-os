/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The step inspector — a controlled editor with an explicit Save
 * USER STORY: As a process owner I must be able to change a step's expert knowledge and SEE that it
 *             saved, instead of typing into a field that commits on blur and sometimes vanishes.
 * ARCHITECTURE:
 *   - CONTROLLED draft + one Save. The fields used to be `defaultValue` + `onBlur`, and the
 *     inspector was not keyed by step id, so switching steps showed the previous step's text and a
 *     blur-commit arriving during another commit was dropped (WorkflowView's old `actingRef`).
 *   - `mutate` now RESOLVES an outcome, so a failed commit keeps the draft and shows the error here
 *     rather than only in the page banner.
 *   - Every action (add a link, add a rule, add an actor) commits the open draft WITH it through
 *     `applyDraft`, so no path through the inspector can lose typed text.
 *   - Imports only `@core/*` and this tab; the pure mutations live in `lib/step-edit.ts`.
 */
'use client';

import { useState } from 'react';
import type { Workflow, WorkflowStep, ActorType, LinkType, Actor } from '@tabs/knowledge/lib/schema';
import { ACTOR_TYPES, EXTERNAL_ACTORS } from '@tabs/knowledge/lib/schema';
import type { Gap } from '@tabs/knowledge/lib/gaps';
import type { ActorWarning } from '@tabs/knowledge/lib/actor-registry';
import type { CommitOutcome } from '@tabs/knowledge/lib/commit-queue';
import {
  updateStep,
  setStepIO,
  addStepLink,
  removeStepLink,
  addStepRule,
  setStepRuleHard,
  removeStepRule,
  removeStep,
  moveStep,
  addActor,
  setStepActorFromRegistry,
} from '@tabs/knowledge/lib/step-edit';

const LINK_TYPES: LinkType[] = ['data', 'app', 'agent', 'file'];

const isExternal = (c: ActorType) => EXTERNAL_ACTORS.includes(c);

/** Stable option value for a registry actor (category + name uniquely identify one). */
const actorOptionValue = (a: Actor) => `${a.category}::${a.name}`;

export default function StepInspector({
  workflow,
  step,
  gaps,
  actorWarning,
  canEdit,
  mutate,
  onClose,
}: {
  workflow: Workflow;
  step: WorkflowStep;
  gaps: Gap[];
  /** Set when this step names an actor the registry does not hold. */
  actorWarning?: ActorWarning;
  canEdit: boolean;
  mutate: (next: Workflow) => Promise<CommitOutcome>;
  onClose: () => void;
}) {
  const stepGaps = gaps.filter((g) => g.stepId === step.id);
  const gapRefs = new Set(stepGaps.map((g) => `${g.link.type}:${g.link.ref}`));

  // The registry entry (if any) that matches this step's current (category, name).
  const currentActor = workflow.actors.find(
    (a) => a.category === step.actor && a.name.trim().toLowerCase() === step.actor_name.trim().toLowerCase(),
  );

  // --- the controlled draft (the saved step is the baseline) ------------------
  const saved = {
    title: step.title,
    actorValue: currentActor ? actorOptionValue(currentActor) : '',
    inputs: step.inputs.join('\n'),
    outputs: step.outputs.join('\n'),
    tacit: step.tacit,
  };
  const [title, setTitle] = useState(saved.title);
  const [actorValue, setActorValue] = useState(saved.actorValue);
  const [inputs, setInputs] = useState(saved.inputs);
  const [outputs, setOutputs] = useState(saved.outputs);
  const [tacit, setTacit] = useState(saved.tacit);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);

  const [newLinkType, setNewLinkType] = useState<LinkType>('data');
  const [newLinkRef, setNewLinkRef] = useState('');
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [newRule, setNewRule] = useState('');
  const [newRuleHard, setNewRuleHard] = useState(false);

  // Inline "＋ New actor" form (adds to the registry + selects it for this step).
  const [addingActor, setAddingActor] = useState(false);
  const [naName, setNaName] = useState('');
  const [naCategory, setNaCategory] = useState<ActorType>('Human');
  const [naDesc, setNaDesc] = useState('');

  const idx = workflow.steps.findIndex((s) => s.id === step.id);

  const dirty =
    title !== saved.title ||
    actorValue !== saved.actorValue ||
    inputs !== saved.inputs ||
    outputs !== saved.outputs ||
    tacit !== saved.tacit;

  /** Fold the open draft into a workflow — every commit from here carries it. */
  function applyDraft(base: Workflow): Workflow {
    let next = updateStep(base, step.id, { title, tacit });
    next = setStepIO(next, step.id, { inputs: inputs.split('\n'), outputs: outputs.split('\n') });
    if (actorValue !== saved.actorValue) {
      const picked = workflow.actors.find((a) => actorOptionValue(a) === actorValue);
      if (picked) next = setStepActorFromRegistry(next, step.id, picked);
    }
    return next;
  }

  async function commit(next: Workflow) {
    setSaving(true);
    setErr('');
    const outcome = await mutate(next);
    setSaving(false);
    if (!outcome.ok) setErr(outcome.error);
    return outcome.ok;
  }

  function revert() {
    setTitle(saved.title);
    setActorValue(saved.actorValue);
    setInputs(saved.inputs);
    setOutputs(saved.outputs);
    setTacit(saved.tacit);
    setErr('');
  }

  function requestClose() {
    if (dirty) { setConfirmClose(true); return; }
    onClose();
  }

  function selectActor(value: string) {
    if (value === '__new__') { setAddingActor(true); return; }
    setActorValue(value);
  }

  /** Commit every field above in one go. The ONLY path that saves the text fields. */
  async function save(): Promise<boolean> {
    if (!dirty) return true;
    return commit(applyDraft(workflow));
  }

  async function submitNewActor(e: React.FormEvent) {
    e.preventDefault();
    const name = naName.trim();
    if (!name) return;
    // One commit: the open draft + the new registry actor + this step pointing at it.
    const withActor = addActor(applyDraft(workflow), {
      name,
      category: naCategory,
      ...(naDesc.trim() ? { description: naDesc.trim() } : {}),
    });
    const added = withActor.actors.find(
      (a) => a.category === naCategory && a.name.trim().toLowerCase() === name.toLowerCase(),
    );
    const ok = await commit(added ? setStepActorFromRegistry(withActor, step.id, added) : withActor);
    if (!ok) return;
    setAddingActor(false);
    setNaName(''); setNaCategory('Human'); setNaDesc('');
  }

  return (
    <div className="step-inspector">
      <div className="step-inspector-head">
        <h3 className="step-inspector-title">
          {step.title}
          {dirty && <span className="si-dirty" title="Unsaved changes"> • unsaved</span>}
        </h3>
        <button className="btn ghost sm" onClick={requestClose}>Close ✕</button>
      </div>

      {confirmClose && (
        <div className="si-guard">
          <span>This step has unsaved changes.</span>
          <button className="btn sm" onClick={() => { setConfirmClose(false); void save(); }}>Save &amp; close</button>
          <button className="btn ghost sm" onClick={() => { setConfirmClose(false); onClose(); }}>Discard changes</button>
          <button className="btn ghost sm" onClick={() => setConfirmClose(false)}>Keep editing</button>
        </div>
      )}

      {err && <div className="error si-error">{err}</div>}

      {actorWarning && (
        <div className="si-warn">
          ⚠ {actorWarning.message}
        </div>
      )}

      {/* Title + actor */}
      <div className="si-grid">
        <label className="si-field">
          <span className="si-label">Title</span>
          <input type="text" value={title} disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="si-field">
          <span className="si-label">Actor</span>
          <select value={actorValue} disabled={!canEdit} onChange={(e) => selectActor(e.target.value)}>
            {!actorValue && (
              <option value="" disabled>
                {step.actor_name ? `${step.actor}: ${step.actor_name} (not in the registry)` : 'Choose an actor…'}
              </option>
            )}
            {workflow.actors.map((a) => (
              <option key={actorOptionValue(a)} value={actorOptionValue(a)}>
                {a.name} — {a.category}{isExternal(a.category) ? ' · external' : ''}
              </option>
            ))}
            {canEdit && <option value="__new__">＋ New actor…</option>}
          </select>
        </label>
      </div>

      {/* Inline "＋ New actor" — create a registry actor (all 5 categories,
          optional description) and select it for this step without leaving here. */}
      {canEdit && addingActor && (
        <form className="si-new-actor" onSubmit={(e) => void submitNewActor(e)}>
          <div className="si-grid" style={{ marginTop: 4 }}>
            <label className="si-field">
              <span className="si-label">Name</span>
              <input type="text" value={naName} autoFocus onChange={(e) => setNaName(e.target.value)}
                placeholder="e.g. Salesforce API" />
            </label>
            <label className="si-field">
              <span className="si-label">Category</span>
              <select value={naCategory} onChange={(e) => setNaCategory(e.target.value as ActorType)}>
                {ACTOR_TYPES.map((a) => (
                  <option key={a} value={a}>{a}{isExternal(a) ? ' (external)' : ''}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="si-field" style={{ marginTop: 10 }}>
            <span className="si-label">Description (optional)</span>
            <input type="text" value={naDesc} onChange={(e) => setNaDesc(e.target.value)}
              placeholder="e.g. Nightly REST ingestion" />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn sm" type="submit" disabled={!naName.trim() || saving}>Add &amp; select</button>
            <button className="btn ghost sm" type="button" onClick={() => setAddingActor(false)}>Cancel</button>
          </div>
        </form>
      )}
      {currentActor?.description && !addingActor && (
        <p className="si-actor-desc muted">{currentActor.description}</p>
      )}

      {/* Inputs / outputs */}
      <div className="si-grid" style={{ marginTop: 14 }}>
        <label className="si-field">
          <span className="si-label">Inputs (one per line)</span>
          <textarea rows={3} value={inputs} disabled={!canEdit} onChange={(e) => setInputs(e.target.value)} />
        </label>
        <label className="si-field">
          <span className="si-label">Outputs (one per line)</span>
          <textarea rows={3} value={outputs} disabled={!canEdit} onChange={(e) => setOutputs(e.target.value)} />
        </label>
      </div>

      {/* Inline expert-knowledge note (stored as the step's `tacit` field) */}
      <div className="si-section-label">Expert knowledge (inline)</div>
      <textarea
        rows={3}
        value={tacit}
        disabled={!canEdit}
        placeholder="e.g. Officers often miss the date in section 4 — double-check."
        onChange={(e) => setTacit(e.target.value)}
        style={{ width: '100%' }}
      />

      {/* The one Save for every field above */}
      {canEdit && (
        <div className="si-save-row">
          <button className="btn sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <span className="spin" /> : 'Save'}</button>
          <button className="btn ghost sm" disabled={!dirty || saving} onClick={revert}>Revert</button>
          <span className="si-save-hint muted">
            {dirty ? 'Unsaved changes — press Save to commit them to workflow.md.' : 'All changes saved.'}
          </span>
        </div>
      )}

      {canEdit && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn ghost sm" disabled={idx <= 0 || saving}
            onClick={() => void commit(moveStep(applyDraft(workflow), step.id, -1))}>← Move earlier</button>
          <button className="btn ghost sm" disabled={idx >= workflow.steps.length - 1 || saving}
            onClick={() => void commit(moveStep(applyDraft(workflow), step.id, 1))}>Move later →</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto', color: 'var(--danger)' }} disabled={saving}
            onClick={() => { void commit(removeStep(workflow, step.id)).then((ok) => { if (ok) onClose(); }); }}>
            Remove step
          </button>
        </div>
      )}

      {/* Links */}
      <div className="si-section-label">Links</div>
      {step.links.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>No links yet.</div>
      ) : (
        <div className="si-links">
          {step.links.map((l) => {
            const isGap = gapRefs.has(`${l.type}:${l.ref}`);
            const gap = stepGaps.find((g) => g.link.type === l.type && g.link.ref === l.ref);
            return (
              <div key={`${l.type}:${l.ref}`} className={`si-link${isGap ? ' gap' : ''}`}>
                <span className={`badge ${isGap ? 'err' : 'muted'}`}>{l.type}</span>
                <span className="si-link-ref mono">{l.label || l.ref}</span>
                {isGap && gap ? (
                  <a className="btn ghost sm si-jump" href={gap.buildHref}>
                    ⚠ Missing — build in {gap.buildTab} →
                  </a>
                ) : (
                  <span className="badge ok" style={{ fontSize: 10 }}>resolved</span>
                )}
                {canEdit && (
                  <button className="si-link-x" title="Remove link"
                    onClick={() => void commit(removeStepLink(applyDraft(workflow), step.id, { type: l.type, ref: l.ref }))}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <form
          className="si-add-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newLinkRef.trim()) return;
            void commit(addStepLink(applyDraft(workflow), step.id, {
              type: newLinkType,
              ref: newLinkRef.trim(),
              ...(newLinkLabel.trim() ? { label: newLinkLabel.trim() } : {}),
            })).then((ok) => { if (ok) { setNewLinkRef(''); setNewLinkLabel(''); } });
          }}
        >
          <select value={newLinkType} onChange={(e) => setNewLinkType(e.target.value as LinkType)}>
            {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="text" value={newLinkRef} onChange={(e) => setNewLinkRef(e.target.value)}
            placeholder="entity ref — e.g. sales.gold.orders / app://crm / sys_x / file:x.pdf" style={{ flex: 1 }} />
          <input type="text" value={newLinkLabel} onChange={(e) => setNewLinkLabel(e.target.value)}
            placeholder="label (optional)" style={{ width: 130 }} />
          <button className="btn ghost sm" type="submit" disabled={!newLinkRef.trim() || saving}>+ Link</button>
        </form>
      )}

      {/* Step-level decision rules */}
      <div className="si-section-label">Business rules (this step)</div>
      {step.rules.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>No business rules for this step yet.</div>
      ) : (
        <div className="si-rules">
          {step.rules.map((r) => (
            <div key={r.id} className={`si-rule${r.hard ? ' hard' : ''}`}>
              <span className={`badge ${r.hard ? 'warn' : 'muted'}`}>{r.hard ? '🔒 hard' : 'soft'}</span>
              <span className="si-rule-text">{r.text}</span>
              {canEdit && (
                <>
                  <button className="btn ghost sm"
                    onClick={() => void commit(setStepRuleHard(applyDraft(workflow), step.id, r.id, !r.hard))}>
                    {r.hard ? 'Make soft' : 'Mark hard'}
                  </button>
                  <button className="si-link-x" title="Remove rule"
                    onClick={() => void commit(removeStepRule(applyDraft(workflow), step.id, r.id))}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <form
          className="si-add-rule"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newRule.trim()) return;
            void commit(addStepRule(applyDraft(workflow), step.id, { text: newRule.trim(), hard: newRuleHard }))
              .then((ok) => { if (ok) { setNewRule(''); setNewRuleHard(false); } });
          }}
        >
          <input type="text" value={newRule} onChange={(e) => setNewRule(e.target.value)}
            placeholder="Add a business rule for this step…" style={{ flex: 1 }} />
          <label className="si-hard-toggle">
            <input type="checkbox" checked={newRuleHard} onChange={(e) => setNewRuleHard(e.target.checked)} /> hard
          </label>
          <button className="btn ghost sm" type="submit" disabled={!newRule.trim() || saving}>+ Rule</button>
        </form>
      )}

      <style>{StepInspectorStyles}</style>
    </div>
  );
}

const StepInspectorStyles = `
.step-inspector {
  border: 1px solid var(--gold-line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 18px 20px;
  margin-top: 14px;
}
.step-inspector-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
.step-inspector-title {
  font-family: var(--font-head); font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.3px;
}
.si-dirty { font-family: var(--font-body); font-size: 12px; font-weight: 500; color: var(--gold-text); }
.si-guard {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12.5px;
  padding: 9px 11px; margin-bottom: 12px;
  border: 1px solid var(--gold-line); border-radius: 9px; background: var(--gold-soft);
}
.si-error { margin: 0 0 12px; }
.si-warn {
  font-size: 12.5px; padding: 9px 11px; margin-bottom: 12px; border-radius: 9px;
  border: 1px solid rgba(192,57,43,0.4); background: rgba(192,57,43,0.05); color: var(--text);
}
.si-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.si-field { display: flex; flex-direction: column; gap: 5px; }
.si-label { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-muted); }
.si-field input, .si-field select, .si-field textarea {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.si-save-row { display: flex; align-items: center; gap: 9px; margin-top: 12px; flex-wrap: wrap; }
.si-save-hint { font-size: 12px; }
.si-section-label {
  font-family: var(--font-head); font-size: 11.5px; font-weight: 600; letter-spacing: 0.6px;
  text-transform: uppercase; color: var(--gold-text); margin: 18px 0 8px;
}
.si-links, .si-rules { display: flex; flex-direction: column; gap: 7px; }
.si-link, .si-rule {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
}
.si-link.gap { border-color: rgba(192,57,43,0.4); background: rgba(192,57,43,0.05); }
.si-rule.hard { border-color: var(--gold-line); background: var(--gold-soft); }
.si-link-ref { font-size: 12px; flex: 1; word-break: break-all; }
.si-rule-text { font-size: 13px; flex: 1; }
.si-jump { margin-left: auto; color: var(--danger); white-space: nowrap; }
.si-link-x {
  background: none; border: none; cursor: pointer; color: var(--text-faint);
  font-size: 13px; padding: 2px 4px; line-height: 1;
}
.si-link-x:hover { color: var(--danger); }
.si-add-link, .si-add-rule { display: flex; gap: 8px; margin-top: 9px; align-items: center; flex-wrap: wrap; }
.si-add-link input, .si-add-link select, .si-add-rule input {
  font-family: var(--font-body); font-size: 12.5px; padding: 6px 8px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.si-hard-toggle { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); }
.si-new-actor {
  margin-top: 10px; padding: 12px 14px;
  border: 1px dashed var(--gold-line); border-radius: 10px; background: var(--gold-soft);
}
.si-new-actor input, .si-new-actor select {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.si-actor-desc { font-size: 12.5px; margin: 6px 2px 0; }
`;
