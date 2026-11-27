/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { Workflow } from '@tabs/knowledge/lib/schema';
import { defaultDisposition, planAgents, type Disposition } from '@tabs/knowledge/lib/actor-prompt';
import ActionButton from '@core/ui/core/ActionButton';
import { useTranslations, useServerMessage } from '@core/i18n/client';
import { useActorLabels } from '@tabs/knowledge/ui/useActorLabels';

/**
 * Handovers-out panel — how this workflow flows into the rest of the OS:
 *   1. BUILD AN AGENT — suggest a graph scaffold from the steps, with a per-step
 *      AUGMENT (agent-assisted) / AUTOMATE (agent-run) / MANUAL choice; create it
 *      in the Agents tab (the whole workflow attaches as governed context). The agent
 *      COUNT and the per-step "agent <id>" hint come from `planAgents` — the very plan
 *      `scaffoldSystem` builds — because an Agent ACTOR's steps fold into ONE agent and
 *      counting non-manual steps would promise the user more agents than they get.
 *   2. ATTACH AS CONTEXT — the ref other tabs (Data / Agents / Software) use to
 *      pull this workflow in as AI context while building.
 * Execution lives in the Agents tab; Knowledge only hands off the design.
 */

// Labels and hints are `knowledge.handover.disposition.<value>.{label,hint}`.
const DISPOSITIONS: Disposition[] = ['manual', 'augment', 'automate'];

export default function HandoverPanel({
  workflow,
  workflowId,
  canEdit,
}: {
  workflow: Workflow;
  workflowId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('knowledge');
  const serverMsg = useServerMessage();
  const { category } = useActorLabels();
  const [disp, setDisp] = useState<Record<string, Disposition>>(
    Object.fromEntries(workflow.steps.map((s) => [s.id, defaultDisposition(s)])),
  );
  const [created, setCreated] = useState<{ systemId: string } | null>(null);
  const [error, setError] = useState('');

  // The SAME plan the scaffold builds, so the count on the button is the number of agents
  // the user will actually get: every step of one Agent actor folds into that actor's agent.
  const plan = planAgents(workflow, disp);
  const agentCount = plan.actorAgents.length + plan.stepAgents.length;
  // A MANUAL step is a human/software handoff: it does not run in an agent, even when its
  // actor has one. (An actor agent's AGENT.md still MENTIONS the step — the prompt is the
  // actor's whole brief — but saying "agent <id>" on a manual row read as "this runs there".)
  const agentForStep = (stepId: string): string | undefined =>
    disp[stepId] === 'manual'
      ? undefined
      : plan.actorAgents.find((a) => a.steps.some((s) => s.id === stepId))?.agentId
        ?? plan.stepAgents.find((s) => s.step.id === stepId)?.agentId;

  // Returns a promise so <ActionButton> can drive busy → ✓/error + the success toast.
  // We throw on failure; ActionButton catches it and toasts the message, and we also
  // keep the inline error/created panels for the persistent, in-context detail.
  async function createAgent() {
    setError('');
    const res = await fetch(`/api/knowledge/workflows/${workflowId}/scaffold-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispositions: disp, create: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = serverMsg(data, t('handover.createFailed'));
      setError(msg);
      throw new Error(msg);
    }
    setCreated({ systemId: data.systemId });
  }

  const attachRef = `knowledge:workflow:${workflowId}`;

  return (
    <div className="ho-panel">
      {/* ── Build an agent ── */}
      <div className="section-title" style={{ marginTop: 0 }}>{t('handover.buildTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t.rich('handover.buildIntro', { em: (c) => <em>{c}</em> })}
      </p>

      {workflow.steps.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{t('handover.noSteps')}</div>
      ) : (
        <div className="ho-steps">
          {workflow.steps.map((s) => (
            <div key={s.id} className="ho-step">
              <div className="ho-step-info">
                <span className="ho-step-title">{s.title}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {category(s.actor)}{s.actor_name ? ` · ${s.actor_name}` : ''}
                  {agentForStep(s.id)
                    ? t.rich('handover.stepAgent', { id: agentForStep(s.id) ?? '', mono: (c) => <span className="mono">{c}</span> })
                    : null}
                </span>
              </div>
              <div className="ho-disp" role="group" aria-label={t('handover.dispositionFor', { title: s.title })}>
                {DISPOSITIONS.map((d) => (
                  <button
                    key={d}
                    className={`ho-disp-btn${disp[s.id] === d ? ' active' : ''}`}
                    disabled={!canEdit}
                    title={t(`handover.disposition.${d}.hint`)}
                    onClick={() => setDisp((m) => ({ ...m, [s.id]: d }))}
                  >
                    {t(`handover.disposition.${d}.label`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {canEdit && workflow.steps.length > 0 && (
        <div className="row" style={{ marginTop: 14, alignItems: 'center', gap: 12 }}>
          <ActionButton
            onAction={createAgent}
            successToast={t('handover.createdToast')}
          >
            {t('handover.create', { count: agentCount })}
          </ActionButton>
          <span className="muted" style={{ fontSize: 12 }}>
            {agentCount === 0 ? t('handover.noAgentSteps') : t('handover.opensInAgents')}
          </span>
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {created && (
        <div className="hint" style={{ marginTop: 12, color: 'var(--teal)' }}>
          {t.rich('handover.created', { link: (c) => <a href="/agents" className="ho-link">{c}</a> })}
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 11 }}>{created.systemId}</span>
        </div>
      )}

      {/* ── Attach as context ── */}
      <div className="section-title" style={{ marginTop: 28 }}>{t('handover.attachTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('handover.attachIntro')}
      </p>
      <div className="ho-attach">
        <code className="mono">{attachRef}</code>
        <button
          className="btn ghost sm"
          onClick={() => { void navigator.clipboard?.writeText(attachRef); }}
        >
          {t('handover.copyRef')}
        </button>
      </div>

      <style>{HandoverStyles}</style>
    </div>
  );
}

const HandoverStyles = `
.ho-steps { display: flex; flex-direction: column; gap: 8px; }
.ho-step {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
}
.ho-step-info { display: flex; flex-direction: column; gap: 2px; }
.ho-step-title { font-size: 13.5px; font-weight: 600; }
.ho-disp { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 8px; overflow: hidden; }
.ho-disp-btn {
  background: var(--bg-input); color: var(--text-muted); border: none; cursor: pointer;
  font-size: 12px; padding: 6px 11px; font-family: var(--font-body);
  border-right: 1px solid var(--border);
}
.ho-disp-btn:last-child { border-right: none; }
.ho-disp-btn.active { background: var(--gold-soft); color: var(--gold-text); font-weight: 600; }
.ho-disp-btn:disabled { cursor: default; opacity: 0.6; }
.ho-link { color: var(--teal); font-weight: 600; }
.ho-attach {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
}
.ho-attach code { font-size: 12.5px; flex: 1; }
`;
