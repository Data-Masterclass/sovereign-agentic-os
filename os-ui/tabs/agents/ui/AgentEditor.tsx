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
import { dirtyPaths, ROLE_DRAFT_KEY } from '@tabs/agents/lib/agent-editor-view';
import { AGENT_MODEL_CHOICES, agentModelTier, modelChoiceLabel, type AgentModelChoice } from '@tabs/agents/lib/agent-model';
import { modelChoiceKey } from '@tabs/agents/lib/builder-labels';
import { useTranslations, useServerMessage } from '@core/i18n/client';

type AgentsT = ReturnType<typeof useTranslations<'agents'>>;

/** A model choice's name in the user's language ("Strong" / "Standard" / "Auto" in English). */
function choiceName(t: AgentsT, c: AgentModelChoice): string {
  const key = modelChoiceKey(c);
  return key ? t(key as Parameters<AgentsT>[0]) : modelChoiceLabel(c);
}

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
  initialDrafts,
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
  /** Drawer only: show an "Open large editor" button; receives the drawer's unsaved buffers (path → text). */
  onExpand?: (drafts: Record<string, string>) => void;
  /** Large only: extra head buttons from the host (e.g. the full-screen toggle). */
  headActions?: ReactNode;
  /** id for the title element, so a dialog host can point aria-labelledby at it. */
  titleId?: string;
  /** Large only: the files with unsaved edits (for the close guard). */
  onDirtyChange?: (paths: string[]) => void;
  /** Large only: receives a function that saves the file currently shown (Cmd/Ctrl+S). */
  saveRef?: MutableRefObject<(() => Promise<void>) | null>;
  /** Large only: unsaved buffers carried in from the drawer (path → text), applied on load. */
  initialDrafts?: Record<string, string>;
}) {
  const t = useTranslations('agents');
  const serverMsg = useServerMessage();
  const large = variant === 'large';
  const [sub, setSub] = useState<Sub>('agent');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [msg, setMsg] = useState('');
  const agent = useMemo(() => system.agents.find((a) => a.id === agentId), [system, agentId]);
  const agentPath = `agents/${agentId}/AGENT.md`;
  const memoryPath = `agents/${agentId}/MEMORY.md`;

  // The open files follow THIS agent's projected content in the one source
  // (`sourceContent`): a Simple-card edit that lands after opening reloads a clean
  // buffer; a tool/model/role commit leaves the files alone (no false alarm).

  // Unsaved files + role draft, and "save what is on screen" for the host (Cmd/Ctrl+S).
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const agentCtl = useRef<MonacoFileControl | null>(null);
  const memoryCtl = useRef<MonacoFileControl | null>(null);
  const markAgent = useCallback((d: boolean) => setDirty((m) => (m[agentPath] === d ? m : { ...m, [agentPath]: d })), [agentPath]);
  const markMemory = useCallback((d: boolean) => setDirty((m) => (m[memoryPath] === d ? m : { ...m, [memoryPath]: d })), [memoryPath]);

  // The role draft lives here (not in the input) so it survives a busy commit and the
  // close guard sees it. It follows the source only while it is not being edited.
  const sourceRole = agent?.role ?? '';
  const [roleDraft, setRoleDraft] = useState(sourceRole);
  const roleBase = useRef(sourceRole);
  useEffect(() => {
    setRoleDraft((d) => (d === roleBase.current ? sourceRole : d));
    roleBase.current = sourceRole;
  }, [sourceRole]);
  const roleDirty = large && roleDraft.trim() !== sourceRole.trim();

  useEffect(() => {
    onDirtyChange?.(dirtyPaths({ ...dirty, [ROLE_DRAFT_KEY]: roleDirty }));
  }, [dirty, roleDirty, onDirtyChange]);

  const commit = useCallback(
    async (next: System, note: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMsg('');
      try {
        await commitSystem(systemId, next, serverMsg);
        // Await the parent reload so the next edit builds from the fresh source
        // (no stale-base lost update on rapid tool/model toggles).
        await onChanged();
        setMsg(`✓ ${note}`);
      } catch (e) {
        setMsg(`✗ ${(e as Error).message}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [systemId, onChanged],
  );

  const saveRole = useCallback(async () => {
    if (!agent || !roleDirty) return;
    await commit(setAgentRole(system, agent.id, roleDraft), t('editor.notes.role', { id: agent.id }));
  }, [agent, roleDirty, commit, system, roleDraft, t]);

  useEffect(() => {
    if (!saveRef) return undefined;
    saveRef.current = async () => {
      const ctl = sub === 'memory' ? memoryCtl.current : sub === 'agent' ? agentCtl.current : null;
      await ctl?.save();
      await saveRole();
    };
    return () => { saveRef.current = null; };
  }, [saveRef, sub, saveRole]);

  if (!agent) {
    return (
      <div className={`agent-editor${large ? ' is-large' : ''}`}>
        <div className="error">{t('editor.notFound', { id: agentId })}</div>
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={onClose}>{t('editor.close')}</button>
      </div>
    );
  }

  const effectiveTools = agent.tools ?? system.grants.tools;

  const toggleTool = (tool: string) => {
    const set = new Set(effectiveTools);
    if (set.has(tool)) set.delete(tool);
    else set.add(tool);
    void commit(setAgentTools(system, agent.id, [...set]), t('editor.notes.tools', { id: agent.id }));
  };

  const changeModel = (model: AgentModelChoice) => {
    void commit(setAgentModel(system, agent.id, model), t('editor.notes.model', { id: agent.id, model: choiceName(t, model) }));
  };

  const toolsAndModel = (
    <ToolsAndModel system={system} agent={agent} canEdit={canEdit} busy={busy} onToggleTool={toggleTool} onChangeModel={changeModel} />
  );
  const status = msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ margin: '10px 0', fontSize: 12.5 }} role="status">{msg}</div> : null;
  const badges = (
    <>
      {(isEntrypoint ?? agent.id === system.entrypoint) ? (
        <span className="badge warn">{t('editor.start')}</span>
      ) : onSetEntrypoint ? (
        <button className="btn ghost sm" title={t('editor.makeStartTitle')} onClick={onSetEntrypoint}>{t('editor.makeStart')}</button>
      ) : null}
      {(agent.members?.length ?? 0) > 0 ? <span className="badge">{t('editor.supervisor')}</span> : null}
    </>
  );

  if (large) {
    return (
      <div className="agent-editor is-large">
        <div className="agent-editor-head">
          <div className="agent-editor-large-id">
            <h2 id={titleId} className="agent-editor-title" style={{ margin: 0 }}>{agent.id}</h2>
            <RoleField
              agentId={agent.id}
              value={roleDraft}
              canEdit={canEdit}
              busy={busy}
              onChange={setRoleDraft}
              onSave={() => void saveRole()}
            />
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {badges}
            {headActions}
            <button className="btn ghost sm" onClick={onClose} aria-label={t('editor.closeAria')}>{t('editor.closeLarge')}</button>
          </div>
        </div>
        {status}
        <div className="agent-editor-large-body">
          <section className="agent-editor-large-main" aria-label={t('editor.promptAria')}>
            <div className="tabstrip" role="tablist" aria-label={t('editor.filesAria')} style={{ marginTop: 0 }}>
              <button role="tab" aria-selected={sub === 'agent'} className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>
                {/* i18n-ignore — a literal file name */}
                AGENT.md{dirty[agentPath] ? ' •' : ''}
              </button>
              <button role="tab" aria-selected={sub === 'memory'} className={sub === 'memory' ? 'active' : ''} onClick={() => setSub('memory')}>
                {/* i18n-ignore — a literal file name */}
                MEMORY.md{dirty[memoryPath] ? ' •' : ''}
              </button>
              <button role="tab" aria-selected={sub === 'history'} className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>{t('editor.tabs.history')}</button>
              <span className="hint agent-editor-keys" aria-hidden>{t('editor.keys')}</span>
            </div>
            {/* Both files stay mounted so switching tabs never drops unsaved edits. */}
            <div className="agent-editor-large-pane" hidden={sub !== 'agent'} role="tabpanel" aria-label={t('editor.agentPaneAria')}>
              <MonacoFile systemId={systemId} path={agentPath} canEdit={canEdit} fill sourceContent={agent.agent_md} initialDraft={initialDrafts?.[agentPath]} onSaved={onChanged} onDirtyChange={markAgent} controlRef={agentCtl} />
            </div>
            <div className="agent-editor-large-pane" hidden={sub !== 'memory'} role="tabpanel" aria-label={t('editor.memoryPaneAria')}>
              <MonacoFile systemId={systemId} path={memoryPath} canEdit={canEdit} fill sourceContent={agent.memory_md} initialDraft={initialDrafts?.[memoryPath]} onSaved={onChanged} onDirtyChange={markMemory} controlRef={memoryCtl} />
            </div>
            {sub === 'history' ? <HistoryNote systemId={systemId} agentId={agent.id} /> : null}
          </section>
          <aside className="agent-editor-large-side" aria-label={t('editor.sideAria')}>{toolsAndModel}</aside>
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
            <button
              className="btn ghost sm"
              data-agent-editor-return=""
              onClick={() => {
                // Carry the drawer's unsaved buffer into the large editor instead of dropping it.
                const drafts: Record<string, string> = {};
                const a = agentCtl.current?.draft();
                const m = memoryCtl.current?.draft();
                if (a != null) drafts[agentPath] = a;
                if (m != null) drafts[memoryPath] = m;
                onExpand(drafts);
              }}
              title={t('editor.largeTitle')}
            >
              {t('editor.large')}
            </button>
          ) : null}
          <button className="btn ghost sm" onClick={onClose}>{t('editor.close')}</button>
        </div>
      </div>

      <div className="tabstrip" style={{ marginTop: 4 }}>
        {/* i18n-ignore — a literal file name */}
        <button className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>AGENT.md</button>
        {/* i18n-ignore — a literal file name */}
        <button className={sub === 'memory' ? 'active' : ''} onClick={() => setSub('memory')}>MEMORY.md</button>
        <button className={sub === 'tools' ? 'active' : ''} onClick={() => setSub('tools')}>{t('editor.tabs.tools')}</button>
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>{t('editor.tabs.history')}</button>
      </div>

      {status}

      {sub === 'agent' ? (
        <MonacoFile systemId={systemId} path={agentPath} canEdit={canEdit} height={320} sourceContent={agent.agent_md} onSaved={onChanged} controlRef={agentCtl} />
      ) : null}

      {sub === 'memory' ? (
        <MonacoFile systemId={systemId} path={memoryPath} canEdit={canEdit} height={280} sourceContent={agent.memory_md} onSaved={onChanged} controlRef={memoryCtl} />
      ) : null}

      {sub === 'tools' ? toolsAndModel : null}

      {sub === 'history' ? <HistoryNote systemId={systemId} agentId={agent.id} /> : null}
    </div>
  );
}

/**
 * The role line, editable in the large view; saved on blur / Enter / Cmd+S through
 * system.yaml. Stays mounted (read-only, not swapped out) while a save is in flight,
 * so the draft is never lost.
 */
function RoleField({ agentId, value, canEdit, busy, onChange, onSave }: {
  agentId: string; value: string; canEdit: boolean; busy: boolean; onChange: (v: string) => void; onSave: () => void;
}) {
  const t = useTranslations('agents');
  if (!canEdit) return <div className="muted" style={{ fontSize: 12.5 }}>{value || t('editor.noRole')}</div>;
  return (
    <input
      type="text"
      className="agent-editor-role"
      aria-label={t('editor.roleAria', { id: agentId })}
      aria-busy={busy || undefined}
      readOnly={busy}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => { if (!busy) onSave(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!busy) onSave(); } }}
      placeholder={t('editor.rolePlaceholder')}
    />
  );
}

function HistoryNote({ systemId, agentId }: { systemId: string; agentId: string }) {
  const t = useTranslations('agents');
  return (
    <div className="agent-history">
      <p className="hint" style={{ marginTop: 12 }}>
        {t.rich('editor.history', { id: `${systemId}:${agentId}`, mono: (c) => <span className="mono">{c}</span> })}
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
  const t = useTranslations('agents');
  const choice: AgentModelChoice = agent.model ?? 'strong';
  const HINTS: Record<AgentModelChoice, string> = {
    strong: t('editor.model.hints.strong'),
    standard: t('editor.model.hints.standard'),
    auto: t('editor.model.hints.auto'),
  };
  const missingCount = system.grants.tools.filter((tool) => !effectiveTools.includes(tool)).length;
  return (
    <div className="agent-grants">
      <div className="section-title" style={{ marginTop: 12 }}>{t('editor.tools.title')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {narrowed ? t('editor.tools.introNarrowed') : t('editor.tools.introInherits')}
      </p>
      {narrowed && missingCount > 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>
          {t.rich('editor.tools.notEnabled', { count: missingCount, strong: (c) => <strong>{c}</strong> })}
        </p>
      ) : null}
      {system.grants.tools.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{t('editor.tools.none')}</div>
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

      <div className="section-title">{t('editor.model.title')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('editor.model.intro')}
      </p>
      <div className="rt-seg" role="group" aria-label={t('editor.model.aria')}>
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
              {choiceName(t, c)}
            </button>
          );
        })}
      </div>
      <div className="model-facet" style={{ marginTop: 8 }}>
        {choice === 'auto' ? (
          agent.model_resolved ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {/* model_reason is generated at Build and stored with the agent: shown as is. */}
              {agent.model_reason
                ? t.rich('editor.model.autoChoseReason', { model: choiceName(t, agentModelTier(agent)), reason: agent.model_reason, strong: (c) => <strong>{c}</strong> })
                : t.rich('editor.model.autoChose', { model: choiceName(t, agentModelTier(agent)), strong: (c) => <strong>{c}</strong> })}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t('editor.model.undecided')}
            </div>
          )
        ) : null}
        <p className="hint rt-seg-hint" style={{ marginTop: 6 }}>{HINTS[choice]} {choice === 'auto' ? t('editor.model.decidedAtBuild') : t('editor.model.takesEffect')}</p>
      </div>
    </div>
  );
}

/** In-box (sovereign) vs hosted (external API) badge for a model. */
function ProvenanceBadge({ provenance }: { provenance: 'internal' | 'external' }) {
  const t = useTranslations('agents');
  return provenance === 'internal' ? (
    <span className="badge ok" title={t('editor.provenance.internalTitle')}>{t('editor.provenance.internal')}</span>
  ) : (
    <span className="badge warn" title={t('editor.provenance.externalTitle')}>{t('editor.provenance.external')}</span>
  );
}
