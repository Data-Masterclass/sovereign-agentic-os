/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { Workflow } from '@tabs/knowledge/lib/schema';
import { addWorkflowRule, setWorkflowRuleHard, removeWorkflowRule } from '@tabs/knowledge/lib/rules-edit';
import type { WorkflowReducer } from '@tabs/knowledge/lib/workflow-commit';
import { useToast } from '@core/ui/core/Toast';
import { useTranslations } from '@core/i18n/client';

/**
 * Decision-rules panel — the WORKFLOW-level rules (step rules are edited in the
 * StepInspector). Rules are SOFT by default (prose the agent follows); marking one
 * HARD compiles it to an enforced OPA guardrail. "Compile & apply guardrails" runs
 * the apply→verify against OPA (live-try → honest offline mock) and shows the ✓/✗
 * the same way the agents Build table does — the OPA/Rego machinery stays hidden.
 */

type ApplyRow = {
  applied: boolean;
  verified: boolean;
  status: 'ok' | 'fail' | 'none';
  policy: 'opa-live' | 'opa-bundle';
  detail: string;
  error?: string;
};
type Guardrail = { id: string; level: 'workflow' | 'step'; stepId?: string; stepTitle?: string; text: string };
type ApplyResult = { compiled: { guardrails: Guardrail[] }; apply: ApplyRow };

export default function RulesPanel({
  workflow,
  workflowId,
  canEdit,
  mutate,
}: {
  workflow: Workflow;
  workflowId: string;
  canEdit: boolean;
  /** A commit is a reducer over the FRESH document — never a snapshot of this render. */
  mutate: (reduce: WorkflowReducer) => void;
}) {
  const [newRule, setNewRule] = useState('');
  const [newHard, setNewHard] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [applyErr, setApplyErr] = useState('');
  const toast = useToast();
  const t = useTranslations('knowledge');

  const workflowRules = workflow.rules.filter((r) => r.scope === 'workflow');
  const hardCount = workflowRules.filter((r) => r.hard).length
    + workflow.steps.reduce((n, s) => n + s.rules.filter((r) => r.hard).length, 0);

  async function applyGuardrails() {
    setApplying(true);
    setApplyErr('');
    setResult(null);
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}/guardrails`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error ?? t('rules.applyFailed');
        setApplyErr(msg); toast.error(msg);
      } else {
        setResult(data);
        const applied = (data as ApplyResult).apply;
        if (applied?.status === 'ok') toast.success(t('rules.appliedToast'));
        else if (applied?.status === 'none') toast.success(t('rules.nothingToast'));
        else toast.error(applied?.error ?? applied?.detail ?? t('rules.notVerified'));
      }
    } catch (e) {
      const msg = (e as Error).message;
      setApplyErr(msg); toast.error(msg);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rules-panel">
      <p className="hint" style={{ marginTop: 0 }}>
        {t.rich('rules.intro', { strong: (c) => <strong>{c}</strong> })}
      </p>

      <div className="section-title">{t('rules.title')}</div>
      {workflowRules.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{t('rules.empty')}</div>
      ) : (
        <div className="rp-rules">
          {workflowRules.map((r) => (
            <div key={r.id} className={`rp-rule${r.hard ? ' hard' : ''}`}>
              <span className={`badge ${r.hard ? 'warn' : 'muted'}`}>{r.hard ? t('rule.hard') : t('rule.soft')}</span>
              <span className="rp-rule-text">{r.text}</span>
              {canEdit && (
                <>
                  <button className="btn ghost sm" onClick={() => mutate((fresh) => setWorkflowRuleHard(fresh, r.id, !r.hard))}>
                    {r.hard ? t('rule.makeSoft') : t('rule.markHard')}
                  </button>
                  <button className="rp-x" title={t('rule.remove')} onClick={() => mutate((fresh) => removeWorkflowRule(fresh, r.id))}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <form
          className="rp-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newRule.trim()) return;
            mutate((fresh) => addWorkflowRule(fresh, { text: newRule.trim(), hard: newHard }));
            setNewRule('');
            setNewHard(false);
          }}
        >
          <input type="text" value={newRule} onChange={(e) => setNewRule(e.target.value)}
            placeholder={t('rules.addPlaceholder')} style={{ flex: 1 }} />
          <label className="rp-hard-toggle">
            <input type="checkbox" checked={newHard} onChange={(e) => setNewHard(e.target.checked)} /> {t('rule.hardToggle')}
          </label>
          <button className="btn ghost sm" type="submit" disabled={!newRule.trim()}>{t('rule.add')}</button>
        </form>
      )}

      {/* Guardrail apply */}
      <div className="section-title" style={{ marginTop: 24 }}>{t('rules.guardrailsTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {hardCount > 0
          ? t('rules.hardCount', { count: hardCount })
          : t('rules.noHard')}
      </p>
      {canEdit && (
        <button className="btn" onClick={() => void applyGuardrails()} disabled={applying || hardCount === 0}>
          {applying ? <span className="spin" /> : t('rules.apply')}
        </button>
      )}

      {applyErr && <div className="error" style={{ marginTop: 12 }}>{applyErr}</div>}

      {result && (
        <div className="rp-result" style={{ marginTop: 14 }}>
          <div className={`rp-result-head ${result.apply.status === 'ok' ? 'ok' : result.apply.status === 'none' ? '' : 'fail'}`}>
            <span className="rp-result-badge">{result.apply.status === 'ok' ? '✓' : result.apply.status === 'none' ? '–' : '✗'}</span>
            <span>
              {result.apply.status === 'ok' ? t('rules.result.ok') : result.apply.status === 'none' ? t('rules.result.none') : t('rules.result.fail')}
              {' · '}
              <span className="muted">{result.apply.policy === 'opa-bundle' ? t('rules.policy.bundle') : t('rules.policy.live')}</span>
            </span>
          </div>
          <div className="rp-result-detail">{result.apply.detail}</div>
          {result.apply.error && <div className="error" style={{ marginTop: 8 }}>{result.apply.error}</div>}
          {result.compiled.guardrails.length > 0 && (
            <ul className="rp-guardrail-list">
              {result.compiled.guardrails.map((g) => (
                <li key={g.id}>
                  <span className="badge muted" style={{ fontSize: 10 }}>{g.level === 'step' ? t('rules.levelStep', { title: g.stepTitle ?? g.stepId ?? '' }) : t('rules.levelWorkflow')}</span>
                  {' '}{g.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <style>{RulesStyles}</style>
    </div>
  );
}

const RulesStyles = `
.rp-rules { display: flex; flex-direction: column; gap: 7px; margin-top: 8px; }
.rp-rule {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
}
.rp-rule.hard { border-color: var(--gold-line); background: var(--gold-soft); }
.rp-rule-text { font-size: 13.5px; flex: 1; }
.rp-x { background: none; border: none; cursor: pointer; color: var(--text-faint); font-size: 13px; padding: 2px 4px; }
.rp-x:hover { color: var(--danger); }
.rp-add { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
.rp-add input[type=text] {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text); border: 1px solid var(--border-strong); border-radius: 8px;
}
.rp-hard-toggle { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); }
.rp-result { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; background: var(--panel); }
.rp-result-head { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 600; }
.rp-result-head.ok { color: var(--teal); }
.rp-result-head.fail { color: var(--danger); }
.rp-result-badge { font-size: 16px; }
.rp-result-detail { font-size: 13px; color: var(--text-muted); margin-top: 8px; }
.rp-guardrail-list { margin: 10px 0 0; padding-left: 18px; font-size: 13px; display: flex; flex-direction: column; gap: 5px; }
`;
