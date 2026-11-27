/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import type { System } from '@tabs/agents/lib/system-schema';
import { accessCap, AGENT_SAFETY_PRESETS } from '@tabs/agents/lib/access-levels';
import type { SafetyPreset } from '@tabs/agents/lib/system-schema';
import { useTranslations } from '@core/i18n/client';
import type { ResourceMember } from '@tabs/agents/lib/resource-groups';
import ChooseContextShell, { type ContextTypeDescriptor } from '@core/ui/core/ChooseContextShell';
import {
  AGENT_CONTEXT_TYPES,
  AGENT_CONTEXT_META,
  agentContextGrantedCount,
  type AgentContextType,
} from '@tabs/agents/lib/choose-context-meta';
import {
  FolderResourcePicker, ResourcePicker, AccessCapNote,
} from '@tabs/agents/ui/GrantPickers';

/**
 * The GRANT stage — the safety-preset card grid (moved verbatim from the old Define) +
 * the access-cap note, then the shared `<ChooseContextShell>` over the AGENTS context
 * descriptors. It matches the Software Choose-Context surface visually (same shell chrome)
 * while keeping the agents' own grant bodies (late-binding folder grants, access caps, the
 * medallion toggle) via the extracted pickers.
 *
 * Every grant edit still flows through the SAME `onCommit(nextSystem)` → `commitSystem`
 * path — no new persistence is introduced here.
 */

const PRESETS = AGENT_SAFETY_PRESETS;
const FOLDERED = new Set<AgentContextType>(['data', 'knowledge', 'files', 'workflows']);

/** The catalog key of a safety preset (`grants.stage.presets.<key>.*`). */
const PRESET_KEY = {
  'read-only': 'readOnly', 'read-propose': 'readPropose', 'read-bounded': 'readBounded', 'full-in-scope': 'fullInScope',
} as const satisfies Record<SafetyPreset, string>;

/** The catalog key of a resource member's label (`grants.stage.member.<key>`), by `ResourceMember.key`. */
const MEMBER_KEY: Record<string, 'operatingManual' | 'workflows' | 'knowledge' | 'files' | 'data' | 'connections' | 'metrics'> = {
  'operating-manual': 'operatingManual', workflows: 'workflows', knowledge: 'knowledge', files: 'files',
  data: 'data', connections: 'connections', metrics: 'metrics',
};

export default function GrantStage({
  systemId, system, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const t = useTranslations('agents');
  const preset = system.safetyPreset ?? 'read-only';
  const cap = accessCap(system.safetyPreset);
  // A member's label in the user's language; an unknown member keeps its English label.
  const memberLabel = (m: ResourceMember) => (MEMBER_KEY[m.key] ? t(`grants.stage.member.${MEMBER_KEY[m.key]}`) : m.label);

  // Count grants of a member's grant channel, for the collapsed-row badge. Workflows and
  // Knowledge each have their own list (`grants.workflows`, `grants.knowledge`).
  const grantCountByField = (field: ResourceMember['field']): number => {
    if (!field) return 0;
    return (system.grants[field] ?? []).length;
  };

  // Map each agents context type to a shared ChooseContextShell descriptor. The shell owns
  // the collapse row, badge, lazy fetch + focus-refresh; we supply the grant body + create-new.
  const types: ContextTypeDescriptor[] = AGENT_CONTEXT_TYPES.map((type) => {
    const meta = AGENT_CONTEXT_META[type];
    return {
      key: type,
      label: t(`grants.stage.context.${type}.label`),
      blurb: t(`grants.stage.context.${type}.blurb`),
      grantedCount: agentContextGrantedCount(type, grantCountByField),
      // The agents pickers fetch their OWN system-scoped feed internally (they always did),
      // so the shell's loadAvailable is a no-op — the picker body owns the fetch + render.
      loadAvailable: async () => ({ items: [] }),
      renderPicker: () => {
        if (meta.members) {
          // Plan Items — the sub-kinds (Operating Model) as one row with a labelled
          // ResourcePicker each, all writing the shared `plan` list.
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {meta.members.map((m) => (
                <div key={m.key} className="sb-grant-cat">
                  <div className="sb-grant-cat-title">{memberLabel(m)}</div>
                  <ResourcePicker
                    systemId={systemId} system={system}
                    kind={m.field as 'plan'}
                    feedKind={m.feedKind as 'operating-manual'}

                    label={memberLabel(m)}
                    hideLabel
                    canEdit={canEdit} onCommit={onCommit}
                  />
                </div>
              ))}
            </div>
          );
        }
        const m = meta.member!;
        if (FOLDERED.has(type)) {
          // Foldered kinds (data · knowledge · files) + Workflows (its own feed, no folders).
          return (
            <FolderResourcePicker
              systemId={systemId} system={system}
              kind={m.feedKind as 'data' | 'knowledge' | 'workflows' | 'files'}
              label={memberLabel(m)}
              hideLabel
              canEdit={canEdit} onCommit={onCommit}
            />
          );
        }
        // Flat kinds — Connections · Metrics.
        return (
          <ResourcePicker
            systemId={systemId} system={system}
            kind={m.field as 'connections' | 'metrics'}
            feedKind={m.feedKind as 'connections' | 'metric'}
            label={memberLabel(m)}
            hideLabel
            canEdit={canEdit} onCommit={onCommit}
          />
        );
      },
      createNew: meta.createMode
        ? { mode: meta.createMode, render: () => <GrantCreateNew type={type} /> }
        : undefined,
    };
  });

  return (
    <div className="sb-grant-stage">
      {/* Safety / rights preset — the card grid, moved verbatim from the old Define. */}
      <div className="sb-resources">
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('grants.stage.presetTitle')}</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {t('grants.stage.presetHint')}
        </p>
        <div className="rs-preset-grid">
          {PRESETS.map((p) => {
            const selected = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canEdit}
                className={`rs-preset-option${selected ? ' rs-preset-option--selected' : ''}`}
                onClick={() => canEdit && !selected && onCommit({ ...system, safetyPreset: p.id })}
              >
                <div className="rs-preset-top">
                  <span className="rs-preset-name">{t(`grants.stage.presets.${PRESET_KEY[p.id]}.label`)}</span>
                  {selected && <span className="rs-preset-check" aria-hidden>✓</span>}
                </div>
                <p className="rs-preset-consequence">{t(`grants.stage.presets.${PRESET_KEY[p.id]}.consequence`)}</p>
              </button>
            );
          })}
        </div>
        <p className="hint" role="note" style={{ marginTop: 8, marginBottom: 0 }}>{t('grants.stage.runtimeNote')}</p>
      </div>

      {/* What your team can use — the Choose-Context surface. */}
      <div className="sb-resources" style={{ marginTop: 16 }}>
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('grants.stage.useTitle')}</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {t('grants.stage.useHint')}
        </p>
        <AccessCapNote cap={cap} preset={system.safetyPreset} />
        <ChooseContextShell types={types} />
      </div>
    </div>
  );
}

/**
 * The "Create new" body for a grant type. Deep-link types point at their own tab (the shell
 * re-fetches its feed on window focus so the new artifact shows to grant); the derived type
 * (Metrics) explains the dataset→metric sequence and points at the Data tab.
 */
function GrantCreateNew({ type }: { type: AgentContextType }) {
  const t = useTranslations('agents');
  const meta = AGENT_CONTEXT_META[type];
  // Only the types with a create-new carry a note (Workflows + Plan Items have none).
  const createNote = type === 'workflows' || type === 'plan' ? meta.createNote : t(`grants.stage.context.${type}.createNote`);

  if (meta.createMode === 'derived') {
    return (
      <div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{createNote}</p>
        <Link className="btn ghost sm" href="/data" target="_blank" rel="noopener">{t('grants.stage.openData')}</Link>
      </div>
    );
  }

  const href =
    meta.createTab === 'connections' ? '/connections'
    : meta.createTab === 'files' ? '/files'
    : meta.createTab === 'knowledge' ? '/knowledge'
    : '/data';
  return (
    <div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{createNote}</p>
      <Link className="btn sm" href={href} target="_blank" rel="noopener">{t('grants.stage.tabLink', { label: t(`grants.stage.context.${type}.label`) })}</Link>
      <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>{t('grants.stage.returnHint')}</p>
    </div>
  );
}
