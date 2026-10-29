/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import StageAssistantChat from '@core/ui/core/StageAssistantChat';
import type { System } from '@tabs/agents/lib/system-schema';
import {
  setDescription, addOutput, setArtifactGrantLevel, setAgentInstructions,
} from '@tabs/agents/lib/simple-edit';
import { accessCap, clampAccess, type AccessLevel } from '@tabs/agents/lib/access-levels';
import type {
  AgentStageSuggestions, SuggestedAgentGrant, SuggestedOutput, SuggestedInstruction, AgentGrantKind,
} from '@tabs/agents/lib/assistant-suggestions';
import type { AgentStageId } from '@tabs/agents/lib/stages';

/**
 * AgentStageAssistant — the per-stage Agents assistant, mounted in EVERY stage body. It is
 * a thin wrapper over the shared `<StageAssistantChat>` chrome: it points at the AGENTS
 * assistant route, gives each stage its own quick-start prompts, and renders the AGENTS
 * suggestion cards whose Apply buttons call the SAME governed setters the builder uses (the
 * assistant only suggests — applying is a client-confirmed `onCommit` write).
 *
 * The Software builder's own mounts are untouched (they omit `endpoint`/`renderSuggestions`).
 */

/** The per-stage opener prompts — calm, one clear starting question each. */
const STARTERS: Record<AgentStageId, string[]> = {
  define: ['Sharpen my goal into one sentence', 'Suggest where the results should be stored'],
  grant: ['Which context should this team be granted?'],
  design: ['Propose a team of agents for this goal', 'Refine my agents’ instructions'],
  build: ['Explain what this build step does'],
  run: ['Explain what happens on a run', 'What should I look for in the results?'],
  evaluate: ['Assess the last run', 'Suggest instruction improvements'],
};

/** The one-line intro shown above the thread, per stage. */
const INTRO: Record<AgentStageId, string> = {
  define: 'Helps sharpen the goal and suggest where results go. It only suggests — you Apply.',
  grant: 'Suggests which governed context to grant. It only suggests — you Apply.',
  design: 'Proposes a team and refines instructions. It only suggests — you Apply.',
  build: 'Explains the build step in plain language.',
  run: 'Explains the run and what the results mean.',
  evaluate: 'Reads the last run and drafts honest instruction fixes. It only suggests — you Apply.',
};

/**
 * The proactive prompt fired ONCE on entering each stage (ref-guarded in StageAssistantChat),
 * so useful suggestions appear immediately. Structured stages (Define/Grant/Evaluate) ask for
 * the artifacts the cards apply; prose stages (Build/Run) get a light "what to check / what
 * this means". Design's team proposal is handled by the builder's own Proposed-team card, so
 * its auto-fire only refines — kept light. `null` = no auto-fire for that stage.
 */
const AUTO_SUGGEST: Record<AgentStageId, string | null> = {
  define: 'Suggest a sharper one-sentence goal and where the results should be stored.',
  grant: 'Which governed context should this team be granted for this goal?',
  design: 'Suggest refinements to my agents’ instructions for this goal.',
  build: 'In one or two lines, explain what this build step does and what a green build means.',
  run: 'In one or two lines, explain what happens on a run and what to look for in the results.',
  evaluate: 'Assess the last run and suggest concrete instruction improvements.',
};

/** Map an assistant grant kind to the `system.grants` field its grant lands in. */
function grantFieldFor(kind: AgentGrantKind): 'data' | 'knowledge' | 'files' | 'connections' | 'metrics' | 'plan' {
  if (kind === 'metric') return 'metrics';
  if (kind === 'operating-manual') return 'plan';

  return kind; // data | knowledge | files | connections
}

export default function AgentStageAssistant({
  systemId, system, stage, canEdit, onCommit, autoSuggest = false,
}: {
  systemId: string;
  system: System;
  stage: AgentStageId;
  canEdit: boolean;
  onCommit: (next: System) => void;
  /**
   * When true, the assistant proactively fires this stage's suggestion prompt ONCE on entry
   * (ref-guarded per stage in StageAssistantChat). The builder passes this in EDIT mode so
   * every stage greets the user with suggestions; it stays off in read-only VIEW mode.
   */
  autoSuggest?: boolean;
}) {
  // --- Apply handlers — each folds a suggestion into the system via the SAME setters the
  //     builder controls use, then commits through the governed path. No-ops when read-only.
  const applyDescription = (text: string) => { if (canEdit) onCommit(setDescription(system, text)); };

  const applyOutputs = (outputs: SuggestedOutput[]) => {
    if (!canEdit) return;
    let next = system;
    for (const o of outputs) {
      next = addOutput(next, { kind: o.kind, name: o.name, folder: o.folder });
    }
    onCommit(next);
  };

  const applyGrants = (grants: SuggestedAgentGrant[]) => {
    if (!canEdit) return;
    const cap = accessCap(system.safetyPreset);
    let next = system;
    for (const g of grants) {
      const field = grantFieldFor(g.kind);
      // The assistant's proposed access is clamped to the system cap on apply (never widens).
      const level: AccessLevel = clampAccess(g.access ?? cap.default, cap);
      next = setArtifactGrantLevel(next, field, g.id, level);
    }
    onCommit(next);
  };

  const applyInstructions = (list: SuggestedInstruction[]) => {
    if (!canEdit) return;
    let next = system;
    for (const s of list) {
      // Only apply to an agent that actually exists (the route grounds ids, but guard anyway).
      if (next.agents.some((a) => a.id === s.agentId)) {
        next = setAgentInstructions(next, s.agentId, s.instruction);
      }
    }
    onCommit(next);
  };

  return (
    <StageAssistantChat
      appId={systemId}
      stage={stage}
      endpoint={`/api/agents/systems/${systemId}/assistant`}
      intro={INTRO[stage]}
      starters={STARTERS[stage]}
      autoFirePrompt={autoSuggest ? (AUTO_SUGGEST[stage] ?? undefined) : undefined}
      renderSuggestions={(raw, { dismiss, SuggestionCard }) => {
        const s = raw as AgentStageSuggestions;
        return (
          <>
            {/* Define — a sharpened goal sentence. */}
            {s.improvedDescription && canEdit ? (
              <SuggestionCard
                label="Suggested goal"
                applyLabel="Use this goal"
                onApply={() => applyDescription(s.improvedDescription!)}
                onDismiss={() => dismiss('improvedDescription')}
              >
                <p style={{ margin: 0 }}>{s.improvedDescription}</p>
              </SuggestionCard>
            ) : null}

            {/* Define — declared outputs. */}
            {s.suggestedOutputs?.length && canEdit ? (
              <SuggestionCard
                label={`Suggested outputs (${s.suggestedOutputs.length})`}
                applyLabel="Add outputs"
                onApply={() => applyOutputs(s.suggestedOutputs!)}
                onDismiss={() => dismiss('suggestedOutputs')}
              >
                <ul className="sac-list">
                  {s.suggestedOutputs.map((o, i) => (
                    <li key={`${o.kind}:${o.name}:${i}`}>
                      <span className="badge muted">{o.kind}</span> {o.name}
                      <span className="muted" style={{ fontSize: 12 }}> → 📁 {o.folder.path === '/' ? 'root' : o.folder.path} ({o.folder.scope === 'domain' ? 'Domain' : 'My'})</span>
                    </li>
                  ))}
                </ul>
              </SuggestionCard>
            ) : null}

            {/* Grant — context grants. */}
            {s.suggestedGrants?.length && canEdit ? (
              <SuggestionCard
                label={`Suggested context (${s.suggestedGrants.length})`}
                applyLabel="Grant all"
                onApply={() => applyGrants(s.suggestedGrants!)}
                onDismiss={() => dismiss('suggestedGrants')}
              >
                <ul className="sac-list">
                  {s.suggestedGrants.map((g, i) => (
                    <li key={`${g.kind}:${g.id}:${i}`}>
                      <span className="badge muted">{g.kind}</span>{' '}
                      <span className="mono" style={{ fontSize: 12 }}>{g.id}</span>
                      {g.access ? <span className="badge" style={{ marginLeft: 6 }}>{g.access}</span> : null}
                      {g.reason ? <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>— {g.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </SuggestionCard>
            ) : null}

            {/* Design / Evaluate — per-agent instruction drafts. (Design's proposedTeam is
                handled by the builder's dedicated Proposed-team review card, not here.) */}
            {s.suggestedInstructions?.length && canEdit ? (
              <SuggestionCard
                label={`Suggested instructions (${s.suggestedInstructions.length})`}
                applyLabel="Apply instructions"
                onApply={() => applyInstructions(s.suggestedInstructions!)}
                onDismiss={() => dismiss('suggestedInstructions')}
              >
                <ul className="sac-list">
                  {s.suggestedInstructions.map((it, i) => (
                    <li key={`${it.agentId}:${i}`}>
                      <span className="mono" style={{ fontSize: 12 }}>{it.agentId}</span>
                      <div className="muted" style={{ fontSize: 12 }}>{it.instruction}</div>
                    </li>
                  ))}
                </ul>
              </SuggestionCard>
            ) : null}
          </>
        );
      }}
    />
  );
}
