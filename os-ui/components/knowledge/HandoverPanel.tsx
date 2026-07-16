/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { Workflow, WorkflowStep } from '@/lib/knowledge/schema';
import ActionButton from '@/components/core/ActionButton';

/**
 * Handovers-out panel — how this workflow flows into the rest of the OS:
 *   1. BUILD AN AGENT — suggest a graph scaffold from the steps, with a per-step
 *      AUGMENT (agent-assisted) / AUTOMATE (agent-run) / MANUAL choice; create it
 *      in the Agents tab (the whole workflow attaches as governed context).
 *   2. ATTACH AS CONTEXT — the ref other tabs (Data / Agents / Software) use to
 *      pull this workflow in as AI context while building.
 * Execution lives in the Agents tab; Knowledge only hands off the design.
 */

type Disposition = 'manual' | 'augment' | 'automate';

const DISPOSITIONS: { value: Disposition; label: string; hint: string }[] = [
  { value: 'manual', label: 'Manual', hint: 'human/software handoff' },
  { value: 'augment', label: 'Augment', hint: 'agent assists a human' },
  { value: 'automate', label: 'Automate', hint: 'agent runs the step' },
];

function defaultDisp(step: WorkflowStep): Disposition {
  return step.actor === 'Agent' ? 'automate' : 'manual';
}

export default function HandoverPanel({
  workflow,
  workflowId,
  canEdit,
}: {
  workflow: Workflow;
  workflowId: string;
  canEdit: boolean;
}) {
  const [disp, setDisp] = useState<Record<string, Disposition>>(
    Object.fromEntries(workflow.steps.map((s) => [s.id, defaultDisp(s)])),
  );
  const [created, setCreated] = useState<{ systemId: string } | null>(null);
  const [error, setError] = useState('');

  const agentCount = Object.values(disp).filter((d) => d !== 'manual').length;

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
      const msg = data.error ?? 'Failed to create agent system';
      setError(msg);
      throw new Error(msg);
    }
    setCreated({ systemId: data.systemId });
  }

  const attachRef = `knowledge:workflow:${workflowId}`;

  return (
    <div className="ho-panel">
      {/* ── Build an agent ── */}
      <div className="section-title" style={{ marginTop: 0 }}>Build an agent from this workflow</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Choose how each step is handled. Augment/automate steps become agents; the rest stay
        human/software handoffs. The whole workflow attaches as the agent&rsquo;s governed context.
      </p>

      {workflow.steps.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>Add steps first to scaffold an agent.</div>
      ) : (
        <div className="ho-steps">
          {workflow.steps.map((s) => (
            <div key={s.id} className="ho-step">
              <div className="ho-step-info">
                <span className="ho-step-title">{s.title}</span>
                <span className="muted" style={{ fontSize: 11 }}>{s.actor}{s.actor_name ? ` · ${s.actor_name}` : ''}</span>
              </div>
              <div className="ho-disp" role="group" aria-label={`Disposition for ${s.title}`}>
                {DISPOSITIONS.map((d) => (
                  <button
                    key={d.value}
                    className={`ho-disp-btn${disp[s.id] === d.value ? ' active' : ''}`}
                    disabled={!canEdit}
                    title={d.hint}
                    onClick={() => setDisp((m) => ({ ...m, [s.id]: d.value }))}
                  >
                    {d.label}
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
            successToast="Agent system created — open it in the Agents tab"
          >
            {`Create agent system (${agentCount} agent${agentCount === 1 ? '' : 's'})`}
          </ActionButton>
          <span className="muted" style={{ fontSize: 12 }}>
            {agentCount === 0 ? 'No agentified steps — a coordinator with the workflow as context will be created.' : 'Opens in the Agents tab to refine + run.'}
          </span>
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {created && (
        <div className="hint" style={{ marginTop: 12, color: 'var(--teal)' }}>
          ✓ Agent system created. <a href="/agents" className="ho-link">Open the Agents tab →</a>
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 11 }}>{created.systemId}</span>
        </div>
      )}

      {/* ── Attach as context ── */}
      <div className="section-title" style={{ marginTop: 28 }}>Attach as context</div>
      <p className="hint" style={{ marginTop: 0 }}>
        When you build a data product, agent, or app, the OS auto-suggests relevant workflows —
        attach this one to give that build the workflow as governed AI context. The reference:
      </p>
      <div className="ho-attach">
        <code className="mono">{attachRef}</code>
        <button
          className="btn ghost sm"
          onClick={() => { void navigator.clipboard?.writeText(attachRef); }}
        >
          Copy ref
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Adding the ref to a consumer&rsquo;s knowledge grants lets its <code>retrieve</code> tool serve
        this workflow&rsquo;s steps, rules and tacit notes — OPA/DLS-scoped to the user.
      </p>

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
