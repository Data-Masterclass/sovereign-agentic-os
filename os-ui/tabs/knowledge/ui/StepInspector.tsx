/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The step inspector — a controlled editor with an explicit Save
 * USER STORY: As a process owner I must be able to change a step's expert knowledge and SEE that it
 *             saved, instead of typing into a field that commits on blur and sometimes vanishes.
 * ARCHITECTURE:
 *   - CONTROLLED draft + one Save. The fields used to be uncontrolled with blur-commits, and the
 *     inspector was not keyed by step id, so switching steps showed the previous step's text.
 *   - Every commit is a REDUCER over the freshly-read document (`lib/workflow-commit.ts`), never a
 *     snapshot of this render's `workflow` prop: two quick edits used to make the later one revert
 *     the earlier. Each action folds the open draft in through `applyDraft`, so no path loses text.
 *   - `mutate` RESOLVES an outcome, so a failed commit keeps the draft and shows the error here.
 *   - Dirtiness is REPORTED UP (`onDirtyChange`): the unsaved-changes prompt lives in WorkflowView,
 *     which owns every way out of the inspector (another step, the same step, another panel).
 *   - Dirty is computed on NORMALISED drafts (`lib/step-draft.ts`) — the store trims titles, drops
 *     blank I/O lines and trims the note, so a raw comparison never cleared after a save.
 *   - Imports only `@core/*` and this tab; the pure mutations live in `lib/step-edit.ts`.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowStep, ActorType, LinkType, Actor } from '@tabs/knowledge/lib/schema';
import { ACTOR_TYPES, EXTERNAL_ACTORS } from '@tabs/knowledge/lib/schema';
import type { Gap } from '@tabs/knowledge/lib/gaps';
import type { ActorWarning } from '@tabs/knowledge/lib/actor-registry';
import type { CommitOutcome } from '@tabs/knowledge/lib/commit-queue';
import type { WorkflowReducer } from '@tabs/knowledge/lib/workflow-commit';
import { stepDraftFrom, stepDraftDirty, subFormDirty, type StepDraft } from '@tabs/knowledge/lib/step-draft';
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
import { useTranslations } from '@core/i18n/client';
import { useActorLabels } from '@tabs/knowledge/ui/useActorLabels';

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
  onDirtyChange,
  onClose,
}: {
  workflow: Workflow;
  step: WorkflowStep;
  gaps: Gap[];
  /** Set when this step names an actor the registry does not hold. */
  actorWarning?: ActorWarning;
  canEdit: boolean;
  mutate: (reduce: WorkflowReducer) => Promise<CommitOutcome>;
  /** Report the draft state up, so the parent can guard every way out of here. */
  onDirtyChange: (state: { dirty: boolean; save: () => Promise<boolean> }) => void;
  onClose: () => void;
}) {
  const t = useTranslations('knowledge');
  const { category, categoryOption, linkType } = useActorLabels();
  const stepGaps = gaps.filter((g) => g.stepId === step.id);
  const gapRefs = new Set(stepGaps.map((g) => `${g.link.type}:${g.link.ref}`));

  // The registry entry (if any) that matches this step's current (category, name).
  const currentActor = workflow.actors.find(
    (a) => a.category === step.actor && a.name.trim().toLowerCase() === step.actor_name.trim().toLowerCase(),
  );

  // --- the controlled draft (the saved step is the baseline) ------------------
  const saved = stepDraftFrom(step, currentActor ? actorOptionValue(currentActor) : '');
  const [draft, setDraft] = useState<StepDraft>(saved);
  const set = (patch: Partial<StepDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

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
  /** The step's own fields — what Save commits. */
  const draftDirty = stepDraftDirty(draft, saved);
  /** The little add-a-link / add-a-rule / new-actor forms: text that is not committed yet. */
  const subFormsDirty = subFormDirty([newLinkRef, newLinkLabel, newRule, naName, naDesc]);
  const dirty = draftDirty || subFormsDirty;

  /** Fold the open draft into a workflow — every commit from here carries it. */
  function applyDraft(base: Workflow): Workflow {
    let next = updateStep(base, step.id, { title: draft.title, tacit: draft.tacit });
    next = setStepIO(next, step.id, {
      inputs: draft.inputs.split('\n'),
      outputs: draft.outputs.split('\n'),
    });
    if (draft.actorValue !== saved.actorValue) {
      const picked = base.actors.find((a) => actorOptionValue(a) === draft.actorValue);
      if (picked) next = setStepActorFromRegistry(next, step.id, picked);
    }
    return next;
  }

  async function commit(reduce: WorkflowReducer): Promise<boolean> {
    setSaving(true);
    setErr('');
    const outcome = await mutate(reduce);
    setSaving(false);
    if (!outcome.ok) { setErr(outcome.error); return false; }
    return true;
  }

  /** Commit every field above in one go. The ONLY path that saves the text fields. */
  async function save(): Promise<boolean> {
    if (!draftDirty) return true; // a half-typed sub-form has nothing to commit
    if (!draft.title.trim()) { setErr(t('step.titleRequired')); return false; }
    return commit((fresh) => applyDraft(fresh));
  }

  function revert() {
    setDraft(saved);
    clearSubForms();
    setErr('');
  }

  function clearSubForms() {
    setNewLinkRef(''); setNewLinkLabel('');
    setNewRule(''); setNewRuleHard(false);
    setNaName(''); setNaDesc(''); setNaCategory('Human'); setAddingActor(false);
  }

  /**
   * Stop reporting a draft, now. Used by "Remove step": the step is gone, so a guard
   * that still believed this inspector was dirty would try to "Save & continue" into a
   * step that no longer exists.
   */
  function discardDraft() {
    setDraft(saved);
    clearSubForms();
    onDirtyChange({ dirty: false, save: async () => true });
  }

  // The latest `save` closure, so the parent's guard always saves the CURRENT draft.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    onDirtyChange({ dirty, save: () => saveRef.current() });
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange({ dirty: false, save: async () => true }), [onDirtyChange]);

  function selectActor(value: string) {
    if (value === '__new__') { setAddingActor(true); return; }
    set({ actorValue: value });
  }

  async function submitNewActor(e: React.FormEvent) {
    e.preventDefault();
    const name = naName.trim();
    if (!name) return;
    // One commit over the FRESH document: the open draft + the new registry actor + this
    // step pointing at it.
    const ok = await commit((fresh) => {
      const withActor = addActor(applyDraft(fresh), {
        name,
        category: naCategory,
        ...(naDesc.trim() ? { description: naDesc.trim() } : {}),
      });
      const added = withActor.actors.find(
        (a) => a.category === naCategory && a.name.trim().toLowerCase() === name.toLowerCase(),
      );
      return added ? setStepActorFromRegistry(withActor, step.id, added) : withActor;
    });
    if (!ok) return;
    setAddingActor(false);
    setNaName(''); setNaCategory('Human'); setNaDesc('');
  }

  return (
    <div className="step-inspector">
      <div className="step-inspector-head">
        <h3 className="step-inspector-title">
          {step.title}
          {dirty && <span className="si-dirty" title={t('editor.unsavedTitle')}> {t('editor.unsaved')}</span>}
        </h3>
        <button className="btn ghost sm" onClick={onClose}>{t('editor.close')}</button>
      </div>

      {err && <div className="error si-error">{err}</div>}

      {actorWarning && (
        <div className="si-warn">
          ⚠ {t(actorWarning.messageKey, { name: actorWarning.actorName, category: category(actorWarning.actorCategory) })}
        </div>
      )}

      {/* Title + actor */}
      <div className="si-grid">
        <label className="si-field">
          <span className="si-label">{t('step.title')}</span>
          <input type="text" value={draft.title} disabled={!canEdit} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="si-field">
          <span className="si-label">{t('step.actor')}</span>
          <select value={draft.actorValue} disabled={!canEdit} onChange={(e) => selectActor(e.target.value)}>
            {!draft.actorValue && (
              <option value="" disabled>
                {step.actor_name ? t('step.actorNotInRegistry', { category: category(step.actor), name: step.actor_name }) : t('step.chooseActor')}
              </option>
            )}
            {workflow.actors.map((a) => (
              <option key={actorOptionValue(a)} value={actorOptionValue(a)}>
                {isExternal(a.category)
                  ? t('step.actorOptionExternal', { name: a.name, category: category(a.category) })
                  : t('step.actorOption', { name: a.name, category: category(a.category) })}
              </option>
            ))}
            {canEdit && <option value="__new__">{t('step.newActor')}</option>}
          </select>
        </label>
      </div>

      {/* Inline "＋ New actor" — create a registry actor (all 5 categories,
          optional description) and select it for this step without leaving here. */}
      {canEdit && addingActor && (
        <form className="si-new-actor" onSubmit={(e) => void submitNewActor(e)}>
          <div className="si-grid" style={{ marginTop: 4 }}>
            <label className="si-field">
              <span className="si-label">{t('step.name')}</span>
              <input type="text" value={naName} autoFocus onChange={(e) => setNaName(e.target.value)}
                placeholder={t('step.namePlaceholder')} />
            </label>
            <label className="si-field">
              <span className="si-label">{t('step.category')}</span>
              <select value={naCategory} onChange={(e) => setNaCategory(e.target.value as ActorType)}>
                {ACTOR_TYPES.map((a) => (
                  <option key={a} value={a}>{categoryOption(a)}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="si-field" style={{ marginTop: 10 }}>
            <span className="si-label">{t('step.descOptional')}</span>
            <input type="text" value={naDesc} onChange={(e) => setNaDesc(e.target.value)}
              placeholder={t('step.descPlaceholder')} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn sm" type="submit" disabled={!naName.trim() || saving}>{t('step.addSelect')}</button>
            <button className="btn ghost sm" type="button" onClick={() => setAddingActor(false)}>{t('editor.cancel')}</button>
          </div>
        </form>
      )}
      {currentActor?.description && !addingActor && (
        <p className="si-actor-desc muted">{currentActor.description}</p>
      )}

      {/* Inputs / outputs */}
      <div className="si-grid" style={{ marginTop: 14 }}>
        <label className="si-field">
          <span className="si-label">{t('step.inputs')}</span>
          <textarea rows={3} value={draft.inputs} disabled={!canEdit} onChange={(e) => set({ inputs: e.target.value })} />
        </label>
        <label className="si-field">
          <span className="si-label">{t('step.outputs')}</span>
          <textarea rows={3} value={draft.outputs} disabled={!canEdit} onChange={(e) => set({ outputs: e.target.value })} />
        </label>
      </div>

      {/* Inline expert-knowledge note (stored as the step's `tacit` field) */}
      <div className="si-section-label">{t('step.tacit')}</div>
      <textarea
        rows={3}
        value={draft.tacit}
        disabled={!canEdit}
        placeholder={t('step.tacitPlaceholder')}
        onChange={(e) => set({ tacit: e.target.value })}
        style={{ width: '100%' }}
      />

      {/* The one Save for every field above */}
      {canEdit && (
        <div className="si-save-row">
          <button className="btn sm" disabled={!draftDirty || saving} onClick={() => void save()}>
            {saving ? <span className="spin" /> : t('editor.save')}</button>
          <button className="btn ghost sm" disabled={!dirty || saving} onClick={revert}>{t('editor.revert')}</button>
          <span className="si-save-hint muted">
            {draftDirty
              ? t('step.unsavedHint')
              : subFormsDirty
                ? t('step.subFormHint')
                : t('editor.allSaved')}
          </span>
        </div>
      )}

      {canEdit && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn ghost sm" disabled={idx <= 0 || saving}
            onClick={() => void commit((fresh) => moveStep(applyDraft(fresh), step.id, -1))}>{t('step.moveEarlier')}</button>
          <button className="btn ghost sm" disabled={idx >= workflow.steps.length - 1 || saving}
            onClick={() => void commit((fresh) => moveStep(applyDraft(fresh), step.id, 1))}>{t('step.moveLater')}</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto', color: 'var(--danger)' }} disabled={saving}
            onClick={() => {
              void commit((fresh) => removeStep(fresh, step.id)).then((ok) => {
                if (!ok) return;
                discardDraft();
                onClose();
              });
            }}>
            {t('step.remove')}
          </button>
        </div>
      )}

      {/* Links */}
      <div className="si-section-label">{t('step.links')}</div>
      {step.links.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>{t('step.noLinks')}</div>
      ) : (
        <div className="si-links">
          {step.links.map((l) => {
            const isGap = gapRefs.has(`${l.type}:${l.ref}`);
            const gap = stepGaps.find((g) => g.link.type === l.type && g.link.ref === l.ref);
            return (
              <div key={`${l.type}:${l.ref}`} className={`si-link${isGap ? ' gap' : ''}`}>
                <span className={`badge ${isGap ? 'err' : 'muted'}`}>{linkType(l.type)}</span>
                <span className="si-link-ref mono">{l.label || l.ref}</span>
                {isGap && gap ? (
                  <a className="btn ghost sm si-jump" href={gap.buildHref}>
                    {t('step.missing', { tab: t(`buildTab.${gap.buildTab}`) })}
                  </a>
                ) : (
                  <span className="badge ok" style={{ fontSize: 10 }}>{t('step.resolved')}</span>
                )}
                {canEdit && (
                  <button className="si-link-x" title={t('step.removeLink')} disabled={saving}
                    onClick={() => void commit((fresh) => removeStepLink(applyDraft(fresh), step.id, { type: l.type, ref: l.ref }))}>✕</button>
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
            void commit((fresh) => addStepLink(applyDraft(fresh), step.id, {
              type: newLinkType,
              ref: newLinkRef.trim(),
              ...(newLinkLabel.trim() ? { label: newLinkLabel.trim() } : {}),
            })).then((ok) => { if (ok) { setNewLinkRef(''); setNewLinkLabel(''); } });
          }}
        >
          <select value={newLinkType} onChange={(e) => setNewLinkType(e.target.value as LinkType)}>
            {LINK_TYPES.map((lt) => <option key={lt} value={lt}>{linkType(lt)}</option>)}
          </select>
          <input type="text" value={newLinkRef} onChange={(e) => setNewLinkRef(e.target.value)}
            placeholder={t('step.linkRefPlaceholder')} style={{ flex: 1 }} />
          <input type="text" value={newLinkLabel} onChange={(e) => setNewLinkLabel(e.target.value)}
            placeholder={t('step.linkLabelPlaceholder')} style={{ width: 130 }} />
          <button className="btn ghost sm" type="submit" disabled={!newLinkRef.trim() || saving}>{t('step.addLink')}</button>
        </form>
      )}

      {/* Step-level decision rules */}
      <div className="si-section-label">{t('step.rules')}</div>
      {step.rules.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>{t('step.noRules')}</div>
      ) : (
        <div className="si-rules">
          {step.rules.map((r) => (
            <div key={r.id} className={`si-rule${r.hard ? ' hard' : ''}`}>
              <span className={`badge ${r.hard ? 'warn' : 'muted'}`}>{r.hard ? t('rule.hard') : t('rule.soft')}</span>
              <span className="si-rule-text">{r.text}</span>
              {canEdit && (
                <>
                  <button className="btn ghost sm" disabled={saving}
                    onClick={() => void commit((fresh) => setStepRuleHard(applyDraft(fresh), step.id, r.id, !r.hard))}>
                    {r.hard ? t('rule.makeSoft') : t('rule.markHard')}
                  </button>
                  <button className="si-link-x" title={t('step.removeRule')} disabled={saving}
                    onClick={() => void commit((fresh) => removeStepRule(applyDraft(fresh), step.id, r.id))}>✕</button>
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
            void commit((fresh) => addStepRule(applyDraft(fresh), step.id, { text: newRule.trim(), hard: newRuleHard }))
              .then((ok) => { if (ok) { setNewRule(''); setNewRuleHard(false); } });
          }}
        >
          <input type="text" value={newRule} onChange={(e) => setNewRule(e.target.value)}
            placeholder={t('step.addRulePlaceholder')} style={{ flex: 1 }} />
          <label className="si-hard-toggle">
            <input type="checkbox" checked={newRuleHard} onChange={(e) => setNewRuleHard(e.target.checked)} /> {t('rule.hardToggle')}
          </label>
          <button className="btn ghost sm" type="submit" disabled={!newRule.trim() || saving}>{t('rule.add')}</button>
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
.si-link-x:disabled { cursor: default; opacity: 0.5; }
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
