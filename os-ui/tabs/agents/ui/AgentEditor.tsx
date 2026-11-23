/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import MonacoFile from '@tabs/agents/ui/MonacoFile';
import { commitSystem } from '@tabs/agents/ui/commitSystem';
import { type System } from '@tabs/agents/lib/system-schema';
import { setAgentModel, setAgentTools } from '@tabs/agents/lib/canvas-edit';
import { AGENT_MODEL_CHOICES, agentModelTier, modelChoiceLabel, type AgentModelChoice } from '@tabs/agents/lib/agent-model';

/**
 * Level 3 — the agent editor (one agent's native inputs): AGENT.md (behaviour),
 * MEMORY.md (durable memory), Tools (per-agent narrowing of the system grants —
 * narrow-only), the ONE model the agent runs on (Strong · Standard · Auto, `agent-model.ts`), and History (Langfuse +
 * file versions). Every field is the agent's REAL input — tool/model edits patch
 * the one system.yaml through the same file write the canvas + chat use.
 */

type Sub = 'agent' | 'memory' | 'tools' | 'history';

export default function AgentEditor({
  systemId,
  system,
  agentId,
  canEdit,
  isEntrypoint,
  onSetEntrypoint,
  onChanged,
  onClose,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  isEntrypoint?: boolean;
  onSetEntrypoint?: () => void;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<Sub>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const agent = useMemo(() => system.agents.find((a) => a.id === agentId), [system, agentId]);

  const commit = useCallback(
    async (next: System, note: string) => {
      if (busy) return;
      setBusy(true);
      setMsg('');
      try {
        await commitSystem(systemId, next);
        // Await the parent reload so the next edit builds from the fresh source
        // (no stale-base lost update on rapid tool/model toggles).
        await onChanged();
        setMsg(`✓ ${note}`);
      } catch (e) {
        setMsg(`✗ ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, systemId, onChanged],
  );

  if (!agent) {
    return (
      <div className="agent-editor">
        <div className="error">Agent “{agentId}” is no longer in this system.</div>
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={onClose}>Close</button>
      </div>
    );
  }

  const effectiveTools = agent.tools ?? system.grants.tools;
  const narrowed = agent.tools !== undefined;

  const toggleTool = (tool: string) => {
    const set = new Set(effectiveTools);
    if (set.has(tool)) set.delete(tool);
    else set.add(tool);
    void commit(setAgentTools(system, agent.id, [...set]), `Updated ${agent.id} tools`);
  };

  const changeModel = (model: AgentModelChoice) => {
    void commit(setAgentModel(system, agent.id, model), `${agent.id} runs on ${modelChoiceLabel(model)}`);
  };

  return (
    <div className="agent-editor">
      <div className="agent-editor-head">
        <div>
          <div className="agent-editor-title">{agent.id}</div>
          <div className="muted" style={{ fontSize: 12 }}>{agent.role}</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {(isEntrypoint ?? agent.id === system.entrypoint) ? (
            <span className="badge warn">START</span>
          ) : onSetEntrypoint ? (
            <button className="btn ghost sm" title="Make this the entrypoint (START)" onClick={onSetEntrypoint}>Make START</button>
          ) : null}
          {(agent.members?.length ?? 0) > 0 ? <span className="badge">supervisor</span> : null}
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="tabstrip" style={{ marginTop: 4 }}>
        <button className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>AGENT.md</button>
        <button className={sub === 'memory' ? 'active' : ''} onClick={() => setSub('memory')}>MEMORY.md</button>
        <button className={sub === 'tools' ? 'active' : ''} onClick={() => setSub('tools')}>Tools &amp; model</button>
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>History</button>
      </div>

      {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ margin: '10px 0', fontSize: 12.5 }}>{msg}</div> : null}

      {sub === 'agent' ? (
        <MonacoFile systemId={systemId} path={`agents/${agent.id}/AGENT.md`} canEdit={canEdit} height={320} onSaved={onChanged} />
      ) : null}

      {sub === 'memory' ? (
        <MonacoFile systemId={systemId} path={`agents/${agent.id}/MEMORY.md`} canEdit={canEdit} height={280} onSaved={onChanged} />
      ) : null}

      {sub === 'tools' ? (
        <div className="agent-grants">
          <div className="section-title" style={{ marginTop: 12 }}>Tools (narrow-only)</div>
          <p className="hint" style={{ marginTop: 0 }}>
            The agent sees only the in-scope tools. Selection is a subset of the system grants — an
            agent can never broaden its authority (the compiler enforces this).
            {narrowed ? ' This agent is narrowed.' : ' Inheriting all system grants.'}
          </p>
          {narrowed && system.grants.tools.some((t) => !effectiveTools.includes(t)) ? (
            <p className="hint" style={{ marginTop: 0 }}>
              <strong>{system.grants.tools.filter((t) => !effectiveTools.includes(t)).length} team tools not enabled for this agent.</strong>{' '}
              A tool you grant to the team later reaches this agent only when you tick it here.
            </p>
          ) : null}
          {system.grants.tools.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>The system has no tool grants yet — add some in Grants &amp; routing.</div>
          ) : (
            <div className="chk-grid">
              {system.grants.tools.map((tool) => (
                <label key={tool} className="chk">
                  <input
                    type="checkbox"
                    checked={effectiveTools.includes(tool)}
                    disabled={!canEdit || busy}
                    onChange={() => toggleTool(tool)}
                  />
                  <span className="mono">{tool}</span>
                </label>
              ))}
            </div>
          )}

          <div className="section-title">Which model this agent uses</div>
          <p className="hint" style={{ marginTop: 0 }}>
            The agent uses this one model for its whole run. Strong is the most capable. Standard is faster and costs
            less. Auto lets the OS choose one of the two when you press Build, and tells you why.
          </p>
          {(() => {
            // No field = Strong (systems made before the choice existed).
            const choice: AgentModelChoice = agent.model ?? 'strong';
            const HINTS: Record<AgentModelChoice, string> = {
              strong: 'Best for judgement, planning, writing and anything that changes data.',
              standard: 'Good for reading, looking things up and short, direct tasks.',
              auto: 'The OS picks Strong or Standard from this agent\'s instructions and tools at each Build.',
            };
            return (
              <>
                <div className="rt-seg" role="group" aria-label="Model">
                  {AGENT_MODEL_CHOICES.map((c) => {
                    const active = c === choice;
                    return (
                      <button
                        key={c}
                        type="button"
                        className={`rt-seg-opt${active ? ' active' : ''}`}
                        aria-pressed={active}
                        disabled={!canEdit || busy}
                        onClick={() => { if (!active) changeModel(c); }}
                      >
                        {modelChoiceLabel(c)}
                      </button>
                    );
                  })}
                </div>
                <div className="model-facet" style={{ marginTop: 8 }}>
                  {choice === 'auto' ? (
                    agent.model_resolved ? (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        Auto chose <strong>{modelChoiceLabel(agentModelTier(agent))}</strong>
                        {agent.model_reason ? <> — {agent.model_reason}</> : null}. Pick Strong or Standard above to override.
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        Not decided yet: the OS chooses at the next Build. Until then the agent uses Strong.
                      </div>
                    )
                  ) : null}
                  <p className="hint rt-seg-hint" style={{ marginTop: 6 }}>{HINTS[choice]} {choice === 'auto' ? 'Auto is decided when you press Build.' : 'Takes effect when you save.'}</p>
                </div>
              </>
            );
          })()}
        </div>
      ) : null}

      {sub === 'history' ? (
        <div className="agent-history">
          <p className="hint" style={{ marginTop: 12 }}>
            Every action this agent takes is checked against policy and recorded. See its runs in
            Monitoring under <span className="mono">{systemId}:{agent.id}</span>.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** In-box (sovereign) vs hosted (external API) badge for a model. */
function ProvenanceBadge({ provenance }: { provenance: 'internal' | 'external' }) {
  return provenance === 'internal' ? (
    <span className="badge ok" title="Runs in-box on the sovereign cluster — no data leaves.">in-box · sovereign</span>
  ) : (
    <span className="badge warn" title="Runs on a hosted API — the call leaves the box.">hosted · external</span>
  );
}
