/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import type { System } from '@tabs/agents/lib/system-schema';
import { accessCap, AGENT_SAFETY_PRESETS } from '@tabs/agents/lib/access-levels';
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

export default function GrantStage({
  systemId, system, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const preset = system.safetyPreset ?? 'read-only';
  const cap = accessCap(system.safetyPreset);

  // Count grants of a member's grant channel, for the collapsed-row badge. Workflows and
  // Knowledge share the `knowledge` list but split by id family, so we honour idFamily.
  const grantCountByField = (field: ResourceMember['field'], idFamily?: ResourceMember['idFamily']): number => {
    if (!field) return 0;
    const list = system.grants[field] ?? [];
    if (field === 'knowledge' && idFamily) {
      const isWf = (id: string) => id.startsWith('wf_');
      return list.filter((g) => (idFamily === 'workflow' ? isWf(g.id ?? '') : !isWf(g.id ?? ''))).length;
    }
    return list.length;
  };

  // Map each agents context type to a shared ChooseContextShell descriptor. The shell owns
  // the collapse row, badge, lazy fetch + focus-refresh; we supply the grant body + create-new.
  const types: ContextTypeDescriptor[] = AGENT_CONTEXT_TYPES.map((type) => {
    const meta = AGENT_CONTEXT_META[type];
    return {
      key: type,
      label: meta.label,
      blurb: meta.blurb,
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
                  <div className="sb-grant-cat-title">{m.label}</div>
                  <ResourcePicker
                    systemId={systemId} system={system}
                    kind={m.field as 'plan'}
                    feedKind={m.feedKind as 'operating-manual'}

                    label={m.label}
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
          // Foldered kinds (data · knowledge · files) + Workflows (knowledge feed, wf_ family).
          return (
            <FolderResourcePicker
              systemId={systemId} system={system}
              kind={m.feedKind as 'data' | 'knowledge' | 'files'}
              idFamily={m.idFamily}
              label={m.label}
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
            label={m.label}
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
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>What this team is allowed to do</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          The safety preset bounds every agent — pick the least power the job needs.
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
                  <span className="rs-preset-name">{p.label}</span>
                  {selected && <span className="rs-preset-check" aria-hidden>✓</span>}
                </div>
                <p className="rs-preset-consequence">{p.consequence}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* What your team can use — the Choose-Context surface. */}
      <div className="sb-resources" style={{ marginTop: 16 }}>
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>What your team can use</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Give the whole team the resources it needs — every agent shares these. Expand a type
          to grant existing items or create a new one. The matching tools are granted automatically.
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
  const meta = AGENT_CONTEXT_META[type];

  if (meta.createMode === 'derived') {
    return (
      <div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{meta.createNote}</p>
        <Link className="btn ghost sm" href="/data" target="_blank" rel="noopener">Open the Data tab →</Link>
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
      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{meta.createNote}</p>
      <Link className="btn sm" href={href} target="_blank" rel="noopener">{meta.label} tab →</Link>
      <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>Created it? Return to this tab — the list refreshes so you can grant it.</p>
    </div>
  );
}
