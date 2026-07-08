/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import MonacoFile from './MonacoFile';
import { commitSystem } from './commitSystem';
import { type System } from '@/lib/agents/system-schema';
import { setAgentModel, setAgentTools } from '@/lib/agents/canvas-edit';
import { MODEL_MODES, modeForModel, modelInfo, type ModelMode } from '@/lib/agents/routing';

/**
 * Level 3 — the agent editor (one agent's native inputs): AGENT.md (behaviour),
 * MEMORY.md (durable memory), Tools (per-agent narrowing of the system grants —
 * narrow-only), Model routing (a per-agent LiteLLM model_name picked live from
 * /api/agents/models, or fall back to activity routing), and History (Langfuse +
 * file versions). Every field is the agent's REAL input — tool/model edits patch
 * the one system.yaml through the same file write the canvas + chat use.
 */

type Sub = 'agent' | 'memory' | 'tools' | 'history';

export default function AgentEditor({
  systemId,
  system,
  agentId,
  canEdit,
  roles,
  isEntrypoint,
  onSetEntrypoint,
  onChanged,
  onClose,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  /** The LIVE platform-admin role models the Standard/Reasoning segments pin to. */
  roles: { reasoning: string; standard: string };
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

  const changeModel = (model: string) => {
    void commit(setAgentModel(system, agent.id, model || null), model ? `Routed ${agent.id} → ${model}` : `Cleared ${agent.id} model override`);
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

          <div className="section-title">How this agent thinks</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Choose the thinking mode — we handle the model routing and fallback for you.
          </p>
          {(() => {
            // The pin each segment writes = the LIVE platform-admin role model
            // (Standard / Reasoning), so an agent tracks the admin's role→alias
            // choice. Auto clears the pin (workspace routing decides).
            const pinFor = (mode: ModelMode): string | null =>
              mode === 'reasoning' ? roles.reasoning : mode === 'execution' ? roles.standard : null;
            // Which segment the agent's current pin lights up: match the effective
            // role aliases first (admin may re-point them), else the tier heuristic.
            const activeMode: ModelMode = !agent.model
              ? 'auto'
              : agent.model === roles.reasoning
                ? 'reasoning'
                : agent.model === roles.standard
                  ? 'execution'
                  : modeForModel(agent.model);
            const activeChoice = MODEL_MODES.find((m) => m.mode === activeMode)!;
            const activePin = pinFor(activeMode);
            const shown = activePin ? modelInfo(activePin) : null;
            return (
              <>
                <div className="rt-seg" role="group" aria-label="Thinking mode">
                  {MODEL_MODES.map((m) => {
                    const active = m.mode === activeMode;
                    return (
                      <button
                        key={m.mode}
                        type="button"
                        className={`rt-seg-opt${active ? ' active' : ''}`}
                        aria-pressed={active}
                        disabled={!canEdit || busy}
                        onClick={() => { if (!active) changeModel(pinFor(m.mode) ?? ''); }}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
                <div className="model-facet" style={{ marginTop: 8 }}>
                  {shown ? (
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="model-name mono">{shown.display}</span>
                      {shown.params && shown.params !== '—' ? <span className="badge muted">{shown.params}</span> : null}
                      <ProvenanceBadge provenance={shown.provenance} />
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Workspace routing decides per task — cheap-first (Standard for light work, in-box
                      Reasoning for planning).
                    </div>
                  )}
                  <p className="hint rt-seg-hint" style={{ marginTop: 6 }}>{activeChoice.hint}</p>
                </div>
              </>
            );
          })()}
        </div>
      ) : null}

      {sub === 'history' ? (
        <div className="agent-history">
          <p className="hint" style={{ marginTop: 12 }}>
            Every tool call this agent makes is forced through the governed gateway (LiteLLM → OPA →
            Langfuse). Run the system or press Build to generate traces; they appear in Monitoring
            (Langfuse) under principal <span className="mono">{systemId}:{agent.id}</span>. File
            versions are tracked in the system’s Forgejo repo.
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
