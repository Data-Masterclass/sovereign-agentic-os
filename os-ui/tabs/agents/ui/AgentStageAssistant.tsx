/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import StageAssistantChat from '@core/ui/core/StageAssistantChat';
import { useTranslations } from '@core/i18n/client';
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

/**
 * The per-stage opener prompts — calm, one clear starting question each. Keys of `agents.stage.starters`;
 * a chip shows its text and sends it as the user's own message, so both are in the user's language.
 */
const STARTERS: Record<AgentStageId, ('defineGoal' | 'defineOutputs' | 'grantContext' | 'designTeam' | 'designRefine' | 'buildExplain' | 'runExplain' | 'runResults' | 'evaluateAssess' | 'evaluateImprove')[]> = {
  define: ['defineGoal', 'defineOutputs'],
  grant: ['grantContext'],
  design: ['designTeam', 'designRefine'],
  build: ['buildExplain'],
  run: ['runExplain', 'runResults'],
  evaluate: ['evaluateAssess', 'evaluateImprove'],
};

/** The one-line intro shown above the thread, per stage: `agents.stage.intro.<stage>`. */

/**
 * The proactive prompt fired ONCE on entering each stage (ref-guarded in StageAssistantChat),
 * so useful suggestions appear immediately. Structured stages (Define/Grant/Evaluate) ask for
 * the artifacts the cards apply; prose stages (Build/Run) get a light "what to check / what
 * this means". Design's team proposal is handled by the builder's own Proposed-team card, so
 * its auto-fire only refines — kept light. The text is `agents.stage.auto.<stage>` (it shows in the thread as the
 * user's message, so it is in the user's language). `false` = no auto-fire for that stage.
 */
const AUTO_SUGGEST: Record<AgentStageId, boolean> = {
  define: true,
  grant: true,
  design: true,
  build: true,
  run: true,
  evaluate: true,
};

/** Map an assistant grant kind to the `system.grants` field its grant lands in. */
function grantFieldFor(kind: AgentGrantKind): 'data' | 'knowledge' | 'workflows' | 'files' | 'connections' | 'metrics' | 'plan' {
  if (kind === 'metric') return 'metrics';
  if (kind === 'operating-manual') return 'plan';

  return kind; // data | knowledge | workflows | files | connections
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
  const t = useTranslations('agents');
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
      intro={t(`stage.intro.${stage}`)}
      starters={STARTERS[stage].map((k) => t(`stage.starters.${k}`))}
      autoFirePrompt={autoSuggest && AUTO_SUGGEST[stage] ? t(`stage.auto.${stage}`) : undefined}
      renderSuggestions={(raw, { dismiss, SuggestionCard }) => {
        const s = raw as AgentStageSuggestions;
        return (
          <>
            {/* Define — a sharpened goal sentence. */}
            {s.improvedDescription && canEdit ? (
              <SuggestionCard
                label={t('stage.cards.goal')}
                applyLabel={t('stage.cards.useGoal')}
                onApply={() => applyDescription(s.improvedDescription!)}
                onDismiss={() => dismiss('improvedDescription')}
              >
                <p style={{ margin: 0 }}>{s.improvedDescription}</p>
              </SuggestionCard>
            ) : null}

            {/* Define — declared outputs. */}
            {s.suggestedOutputs?.length && canEdit ? (
              <SuggestionCard
                label={t('stage.cards.outputs', { count: s.suggestedOutputs.length })}
                applyLabel={t('stage.cards.addOutputs')}
                onApply={() => applyOutputs(s.suggestedOutputs!)}
                onDismiss={() => dismiss('suggestedOutputs')}
              >
                <ul className="sac-list">
                  {s.suggestedOutputs.map((o, i) => (
                    <li key={`${o.kind}:${o.name}:${i}`}>
                      <span className="badge muted">{o.kind}</span> {o.name}
                      <span className="muted" style={{ fontSize: 12 }}>{' '}{t('stage.cards.folder', { path: o.folder.path === '/' ? t('stage.cards.root') : o.folder.path, scope: o.folder.scope === 'domain' ? t('stage.cards.scopeDomain') : t('stage.cards.scopeMy') })}</span>
                    </li>
                  ))}
                </ul>
              </SuggestionCard>
            ) : null}

            {/* Grant — context grants. */}
            {s.suggestedGrants?.length && canEdit ? (
              <SuggestionCard
                label={t('stage.cards.context', { count: s.suggestedGrants.length })}
                applyLabel={t('stage.cards.grantAll')}
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
                label={t('stage.cards.instructions', { count: s.suggestedInstructions.length })}
                applyLabel={t('stage.cards.applyInstructions')}
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
