/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { Workflow, WorkflowStep, ActorType, LinkType } from '@/lib/knowledge/schema';
import type { Gap } from '@/lib/knowledge/gaps';
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
} from '@/lib/knowledge/step-edit';

/**
 * Step inspector — the per-step editor over `workflow.md`. Every change produces a
 * NEW Workflow via the pure `step-edit` helpers and is committed through `mutate`
 * (the same one-source commit the swimlane + Monaco use). Surfaces a step's links
 * and flags any that reference a missing entity with a jump-to-build link.
 */

const ACTORS: ActorType[] = ['Human', 'Software', 'Agent'];
const LINK_TYPES: LinkType[] = ['data', 'app', 'agent', 'file'];

export default function StepInspector({
  workflow,
  step,
  gaps,
  canEdit,
  mutate,
  onClose,
}: {
  workflow: Workflow;
  step: WorkflowStep;
  gaps: Gap[];
  canEdit: boolean;
  mutate: (next: Workflow) => void;
  onClose: () => void;
}) {
  const stepGaps = gaps.filter((g) => g.stepId === step.id);
  const gapRefs = new Set(stepGaps.map((g) => `${g.link.type}:${g.link.ref}`));

  const [newLinkType, setNewLinkType] = useState<LinkType>('data');
  const [newLinkRef, setNewLinkRef] = useState('');
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [newRule, setNewRule] = useState('');
  const [newRuleHard, setNewRuleHard] = useState(false);

  const idx = workflow.steps.findIndex((s) => s.id === step.id);

  return (
    <div className="step-inspector">
      <div className="step-inspector-head">
        <h3 className="step-inspector-title">{step.title}</h3>
        <button className="btn ghost sm" onClick={onClose}>Close ✕</button>
      </div>

      {/* Title + actor + ordering */}
      <div className="si-grid">
        <label className="si-field">
          <span className="si-label">Title</span>
          <input
            type="text"
            defaultValue={step.title}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== step.title) {
                mutate(updateStep(workflow, step.id, { title: e.target.value }));
              }
            }}
          />
        </label>
        <label className="si-field">
          <span className="si-label">Actor</span>
          <select
            value={step.actor}
            disabled={!canEdit}
            onChange={(e) => mutate(updateStep(workflow, step.id, { actor: e.target.value as ActorType }))}
          >
            {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="si-field">
          <span className="si-label">Actor name</span>
          <input
            type="text"
            defaultValue={step.actor_name}
            placeholder="e.g. Loan Officer"
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== step.actor_name) {
                mutate(updateStep(workflow, step.id, { actor_name: e.target.value }));
              }
            }}
          />
        </label>
      </div>

      {canEdit && (
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <button className="btn ghost sm" disabled={idx <= 0} onClick={() => mutate(moveStep(workflow, step.id, -1))}>← Move earlier</button>
          <button className="btn ghost sm" disabled={idx >= workflow.steps.length - 1} onClick={() => mutate(moveStep(workflow, step.id, 1))}>Move later →</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto', color: 'var(--danger)' }}
            onClick={() => { mutate(removeStep(workflow, step.id)); onClose(); }}>Remove step</button>
        </div>
      )}

      {/* Inputs / outputs */}
      <div className="si-grid" style={{ marginTop: 14 }}>
        <label className="si-field">
          <span className="si-label">Inputs (one per line)</span>
          <textarea
            rows={3}
            defaultValue={step.inputs.join('\n')}
            disabled={!canEdit}
            onBlur={(e) => mutate(setStepIO(workflow, step.id, { inputs: e.target.value.split('\n') }))}
          />
        </label>
        <label className="si-field">
          <span className="si-label">Outputs (one per line)</span>
          <textarea
            rows={3}
            defaultValue={step.outputs.join('\n')}
            disabled={!canEdit}
            onBlur={(e) => mutate(setStepIO(workflow, step.id, { outputs: e.target.value.split('\n') }))}
          />
        </label>
      </div>

      {/* Links */}
      <div className="si-section-label">Links — the entities this step touches</div>
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
                    onClick={() => mutate(removeStepLink(workflow, step.id, { type: l.type, ref: l.ref }))}>✕</button>
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
            mutate(addStepLink(workflow, step.id, {
              type: newLinkType,
              ref: newLinkRef.trim(),
              ...(newLinkLabel.trim() ? { label: newLinkLabel.trim() } : {}),
            }));
            setNewLinkRef('');
            setNewLinkLabel('');
          }}
        >
          <select value={newLinkType} onChange={(e) => setNewLinkType(e.target.value as LinkType)}>
            {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="text" value={newLinkRef} onChange={(e) => setNewLinkRef(e.target.value)}
            placeholder="entity ref — e.g. sales.gold.orders / app://crm / sys_x / file:x.pdf" style={{ flex: 1 }} />
          <input type="text" value={newLinkLabel} onChange={(e) => setNewLinkLabel(e.target.value)}
            placeholder="label (optional)" style={{ width: 130 }} />
          <button className="btn ghost sm" type="submit" disabled={!newLinkRef.trim()}>+ Link</button>
        </form>
      )}

      {/* Step-level decision rules */}
      <div className="si-section-label">Step rules — soft guidance; mark hard for an OPA guardrail</div>
      {step.rules.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>No step rules yet.</div>
      ) : (
        <div className="si-rules">
          {step.rules.map((r) => (
            <div key={r.id} className={`si-rule${r.hard ? ' hard' : ''}`}>
              <span className={`badge ${r.hard ? 'warn' : 'muted'}`}>{r.hard ? '🔒 hard' : 'soft'}</span>
              <span className="si-rule-text">{r.text}</span>
              {canEdit && (
                <>
                  <button className="btn ghost sm" onClick={() => mutate(setStepRuleHard(workflow, step.id, r.id, !r.hard))}>
                    {r.hard ? 'Make soft' : 'Mark hard'}
                  </button>
                  <button className="si-link-x" title="Remove rule" onClick={() => mutate(removeStepRule(workflow, step.id, r.id))}>✕</button>
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
            mutate(addStepRule(workflow, step.id, { text: newRule.trim(), hard: newRuleHard }));
            setNewRule('');
            setNewRuleHard(false);
          }}
        >
          <input type="text" value={newRule} onChange={(e) => setNewRule(e.target.value)}
            placeholder="Add a decision rule for this step…" style={{ flex: 1 }} />
          <label className="si-hard-toggle">
            <input type="checkbox" checked={newRuleHard} onChange={(e) => setNewRuleHard(e.target.checked)} /> hard
          </label>
          <button className="btn ghost sm" type="submit" disabled={!newRule.trim()}>+ Rule</button>
        </form>
      )}

      {/* Inline tacit note */}
      <div className="si-section-label">Tacit note (inline) — practitioners&rsquo; know-how for this step</div>
      <textarea
        rows={2}
        defaultValue={step.tacit}
        disabled={!canEdit}
        placeholder="e.g. Officers often miss the date in section 4 — double-check."
        onBlur={(e) => { if (e.target.value !== step.tacit) mutate(updateStep(workflow, step.id, { tacit: e.target.value })); }}
        style={{ width: '100%' }}
      />

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
.si-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.si-field { display: flex; flex-direction: column; gap: 5px; }
.si-label { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-muted); }
.si-field input, .si-field select, .si-field textarea {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
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
`;
