/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import MonacoFile, { type MonacoFileControl } from '@tabs/agents/ui/MonacoFile';
import { commitSystem } from '@tabs/agents/ui/commitSystem';
import { type System, type AgentSpec } from '@tabs/agents/lib/system-schema';
import { setAgentModel, setAgentTools } from '@tabs/agents/lib/canvas-edit';
import { setAgentRole } from '@tabs/agents/lib/simple-edit';
import { dirtyPaths } from '@tabs/agents/lib/agent-editor-view';
import { AGENT_MODEL_CHOICES, agentModelTier, modelChoiceLabel, type AgentModelChoice } from '@tabs/agents/lib/agent-model';

/**
 * Level 3 — the agent editor (one agent's native inputs): AGENT.md (behaviour),
 * MEMORY.md (durable memory), Tools (per-agent narrowing of the system grants —
 * narrow-only), the ONE model the agent runs on (Strong · Standard · Auto, `agent-model.ts`), and History (Langfuse +
 * file versions). Every field is the agent's REAL input — tool/model edits patch
 * the one system.yaml through the same file write the canvas + chat use.
 *
 * `variant="large"` is the same editor laid out for the big view (AgentEditorDialog):
 * the prompt editor fills most of the screen (AGENT.md / MEMORY.md tabs, both kept
 * mounted so switching never drops edits), the role is editable, and Tools & model
 * sit in a side column. Same sections, same save paths — no second editor.
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
  variant = 'drawer',
  onExpand,
  headActions,
  titleId,
  onDirtyChange,
  saveRef,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  isEntrypoint?: boolean;
  onSetEntrypoint?: () => void;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
  /** `drawer` (default) = the compact side drawer; `large` = the big editor view. */
  variant?: 'drawer' | 'large';
  /** Drawer only: show an "Open large editor" button. */
  onExpand?: () => void;
  /** Large only: extra head buttons from the host (e.g. the full-screen toggle). */
  headActions?: ReactNode;
  /** id for the title element, so a dialog host can point aria-labelledby at it. */
  titleId?: string;
  /** Large only: the files with unsaved edits (for the close guard). */
  onDirtyChange?: (paths: string[]) => void;
  /** Large only: receives a function that saves the file currently shown (Cmd/Ctrl+S). */
  saveRef?: MutableRefObject<(() => Promise<void>) | null>;
}) {
  const large = variant === 'large';
  const [sub, setSub] = useState<Sub>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const agent = useMemo(() => system.agents.find((a) => a.id === agentId), [system, agentId]);
  const agentPath = `agents/${agentId}/AGENT.md`;
  const memoryPath = `agents/${agentId}/MEMORY.md`;

  // The one source can change underneath the open files (a tool/model/role commit, a
  // Simple-card edit that landed just after opening). MonacoFile reloads a CLEAN buffer
  // on this signal and flags a dirty one instead of discarding it.
  const [reloadSignal, setReloadSignal] = useState(0);
  const seenSystem = useRef(system);
  useEffect(() => {
    if (seenSystem.current === system) return;
    seenSystem.current = system;
    setReloadSignal((n) => n + 1);
  }, [system]);

  // Large view: track unsaved files and expose "save the file on screen" to the host.
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const agentCtl = useRef<MonacoFileControl | null>(null);
  const memoryCtl = useRef<MonacoFileControl | null>(null);
  const markAgent = useCallback((d: boolean) => setDirty((m) => (m[agentPath] === d ? m : { ...m, [agentPath]: d })), [agentPath]);
  const markMemory = useCallback((d: boolean) => setDirty((m) => (m[memoryPath] === d ? m : { ...m, [memoryPath]: d })), [memoryPath]);
  useEffect(() => { onDirtyChange?.(dirtyPaths(dirty)); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!saveRef) return undefined;
    saveRef.current = async () => {
      const ctl = sub === 'memory' ? memoryCtl.current : sub === 'agent' ? agentCtl.current : null;
      await ctl?.save();
    };
    return () => { saveRef.current = null; };
  }, [saveRef, sub]);

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
      <div className={`agent-editor${large ? ' is-large' : ''}`}>
        <div className="error">Agent “{agentId}” is no longer in this system.</div>
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={onClose}>Close</button>
      </div>
    );
  }

  const effectiveTools = agent.tools ?? system.grants.tools;

  const toggleTool = (tool: string) => {
    const set = new Set(effectiveTools);
    if (set.has(tool)) set.delete(tool);
    else set.add(tool);
    void commit(setAgentTools(system, agent.id, [...set]), `Updated ${agent.id} tools`);
  };

  const changeModel = (model: AgentModelChoice) => {
    void commit(setAgentModel(system, agent.id, model), `${agent.id} runs on ${modelChoiceLabel(model)}`);
  };

  const toolsAndModel = (
    <ToolsAndModel system={system} agent={agent} canEdit={canEdit} busy={busy} onToggleTool={toggleTool} onChangeModel={changeModel} />
  );
  const status = msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ margin: '10px 0', fontSize: 12.5 }} role="status">{msg}</div> : null;
  const badges = (
    <>
      {(isEntrypoint ?? agent.id === system.entrypoint) ? (
        <span className="badge warn">START</span>
      ) : onSetEntrypoint ? (
        <button className="btn ghost sm" title="Make this the entrypoint (START)" onClick={onSetEntrypoint}>Make START</button>
      ) : null}
      {(agent.members?.length ?? 0) > 0 ? <span className="badge">supervisor</span> : null}
    </>
  );

  if (large) {
    return (
      <div className="agent-editor is-large">
        <div className="agent-editor-head">
          <div className="agent-editor-large-id">
            <h2 id={titleId} className="agent-editor-title" style={{ margin: 0 }}>{agent.id}</h2>
            <RoleField
              key={`${agent.id}:${agent.role}`}
              agentId={agent.id}
              role={agent.role}
              canEdit={canEdit && !busy}
              onSave={(role) => void commit(setAgentRole(system, agent.id, role), `Updated the role of ${agent.id}`)}
            />
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {badges}
            {headActions}
            <button className="btn ghost sm" onClick={onClose} aria-label="Close the agent editor (Esc)">✕ Close</button>
          </div>
        </div>
        {status}
        <div className="agent-editor-large-body">
          <section className="agent-editor-large-main" aria-label="Prompt">
            <div className="tabstrip" role="tablist" aria-label="Agent files" style={{ marginTop: 0 }}>
              <button role="tab" aria-selected={sub === 'agent'} className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>
                AGENT.md{dirty[agentPath] ? ' •' : ''}
              </button>
              <button role="tab" aria-selected={sub === 'memory'} className={sub === 'memory' ? 'active' : ''} onClick={() => setSub('memory')}>
                MEMORY.md{dirty[memoryPath] ? ' •' : ''}
              </button>
              <button role="tab" aria-selected={sub === 'history'} className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>History</button>
              <span className="hint agent-editor-keys" aria-hidden>⌘/Ctrl+S save · Esc close</span>
            </div>
            {/* Both files stay mounted so switching tabs never drops unsaved edits. */}
            <div className="agent-editor-large-pane" hidden={sub !== 'agent'} role="tabpanel" aria-label="AGENT.md — instructions">
              <MonacoFile systemId={systemId} path={agentPath} canEdit={canEdit} fill reloadSignal={reloadSignal} onSaved={onChanged} onDirtyChange={markAgent} controlRef={agentCtl} />
            </div>
            <div className="agent-editor-large-pane" hidden={sub !== 'memory'} role="tabpanel" aria-label="MEMORY.md — durable memory">
              <MonacoFile systemId={systemId} path={memoryPath} canEdit={canEdit} fill reloadSignal={reloadSignal} onSaved={onChanged} onDirtyChange={markMemory} controlRef={memoryCtl} />
            </div>
            {sub === 'history' ? <HistoryNote systemId={systemId} agentId={agent.id} /> : null}
          </section>
          <aside className="agent-editor-large-side" aria-label="Tools and model">{toolsAndModel}</aside>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-editor">
      <div className="agent-editor-head">
        <div>
          <div id={titleId} className="agent-editor-title">{agent.id}</div>
          <div className="muted" style={{ fontSize: 12 }}>{agent.role}</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {badges}
          {onExpand ? (
            <button className="btn ghost sm" onClick={onExpand} title="Open this agent in the large editor">⤢ Large editor</button>
          ) : null}
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="tabstrip" style={{ marginTop: 4 }}>
        <button className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>AGENT.md</button>
        <button className={sub === 'memory' ? 'active' : ''} onClick={() => setSub('memory')}>MEMORY.md</button>
        <button className={sub === 'tools' ? 'active' : ''} onClick={() => setSub('tools')}>Tools &amp; model</button>
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>History</button>
      </div>

      {status}

      {sub === 'agent' ? (
        <MonacoFile systemId={systemId} path={agentPath} canEdit={canEdit} height={320} reloadSignal={reloadSignal} onSaved={onChanged} />
      ) : null}

      {sub === 'memory' ? (
        <MonacoFile systemId={systemId} path={memoryPath} canEdit={canEdit} height={280} reloadSignal={reloadSignal} onSaved={onChanged} />
      ) : null}

      {sub === 'tools' ? toolsAndModel : null}

      {sub === 'history' ? <HistoryNote systemId={systemId} agentId={agent.id} /> : null}
    </div>
  );
}

/** The role line, editable in the large view; commits on blur / Enter through system.yaml. */
function RoleField({ agentId, role, canEdit, onSave }: { agentId: string; role: string; canEdit: boolean; onSave: (role: string) => void }) {
  const [value, setValue] = useState(role);
  const save = () => { if (value.trim() !== role.trim()) onSave(value); };
  if (!canEdit) return <div className="muted" style={{ fontSize: 12.5 }}>{role || 'no role yet'}</div>;
  return (
    <input
      type="text"
      className="agent-editor-role"
      aria-label={`Role of ${agentId}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
      placeholder="Role — e.g. Analyst: reads sources and explains the findings"
    />
  );
}

function HistoryNote({ systemId, agentId }: { systemId: string; agentId: string }) {
  return (
    <div className="agent-history">
      <p className="hint" style={{ marginTop: 12 }}>
        Every action this agent takes is checked against policy and recorded. See its runs in
        Monitoring under <span className="mono">{systemId}:{agentId}</span>.
      </p>
    </div>
  );
}

/** Tools (narrow-only) + the one model — shared by the drawer tab and the large view's side column. */
function ToolsAndModel({
  system, agent, canEdit, busy, onToggleTool, onChangeModel,
}: {
  system: System;
  agent: AgentSpec;
  canEdit: boolean;
  busy: boolean;
  onToggleTool: (tool: string) => void;
  onChangeModel: (model: AgentModelChoice) => void;
}) {
  const effectiveTools = agent.tools ?? system.grants.tools;
  const narrowed = agent.tools !== undefined;
  // No field = Strong (systems made before the choice existed).
  const choice: AgentModelChoice = agent.model ?? 'strong';
  const HINTS: Record<AgentModelChoice, string> = {
    strong: 'Best for judgement, planning, writing and anything that changes data.',
    standard: 'Good for reading, looking things up and short, direct tasks.',
    auto: 'The OS picks Strong or Standard from this agent\'s instructions and tools at each Build.',
  };
  return (
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
                onChange={() => onToggleTool(tool)}
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
              onClick={() => { if (!active) onChangeModel(c); }}
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
