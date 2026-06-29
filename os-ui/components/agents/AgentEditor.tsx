/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import MonacoFile from './MonacoFile';
import { commitSystem } from './commitSystem';
import { type System } from '@/lib/agents/system-schema';
import { setAgentModel, setAgentTools } from '@/lib/agents/canvas-edit';

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
  models,
  modelsSource,
  onChanged,
  onClose,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  models: string[];
  modelsSource: 'litellm' | 'offline' | null;
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
          {agent.id === system.entrypoint ? <span className="badge warn">entrypoint</span> : null}
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

          <div className="section-title">Model routing</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Per-agent model is a LiteLLM <span className="mono">model_name</span> (no endpoint in the UI).
            Leave on activity routing for cheap-first (Ministral light · STACKIT Qwen reasoning/vision).
            {modelsSource === 'offline' ? ' LiteLLM is unreachable — showing the install tier defaults.' : ''}
          </p>
          <select
            value={agent.model ?? ''}
            disabled={!canEdit || busy}
            onChange={(e) => changeModel(e.target.value)}
            style={{ minWidth: 260 }}
          >
            <option value="">Activity routing (workspace default)</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {agent.model && !models.includes(agent.model) ? <option value={agent.model}>{agent.model} (current)</option> : null}
          </select>
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
