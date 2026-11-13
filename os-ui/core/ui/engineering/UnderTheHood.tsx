/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view (UI)
 * FEATURE:    The "Under the hood" panel — one tab per tool, the real artefact, the command
 * USER STORY: As an engineer I open one panel on any object the OS built and read the tools' own
 *             artefacts in the tools' own words, with the deep link and the command I would run
 *             myself — and when a section cannot be filled it tells me why (T1, T2, T6, T7).
 * ARCHITECTURE:
 *   - ONE component for every kind (plan D25): it fetches `/api/engineering/<kind>/<id>`, which
 *     calls the same function `get_engineering_view` calls, and renders the structure it gets. It
 *     holds NO per-kind knowledge, so a new kind needs no change here.
 *   - Every string the user reads comes from `panel.ts` or from the view itself; the component
 *     invents none, which is what makes the vocabulary rule testable without React.
 *   - The git head BADGE is stream G's component: the detail page passes it in as `gitBadge` and
 *     this panel composes it (checklist T6) — it never draws a second badge.
 */
'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { EngineeringKind, EngineeringSection, EngineeringView } from '@core/engineering/types';
import {
  CAVEATS_HEADING,
  COMMANDS_HEADING,
  EXPORT_HEADING,
  PANEL_ERROR_PREFIX,
  PANEL_LOADING,
  PANEL_SUBTITLE,
  PANEL_TITLE,
  emptyText,
  orderedSections,
  tabCaption,
  unresolvedText,
} from '@core/ui/engineering/panel';
import { GraphDiagram } from '@core/ui/engineering/GraphDiagram';
import { useApi } from '@core/ui/useApi';

const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

function Artefacts({ section }: { section: EngineeringSection }) {
  return (
    <>
      {section.artefacts.map((a, i) => (
        <div key={`${a.noun}-${a.name}-${i}`} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{a.noun}</span>
            <code style={{ fontFamily: mono, fontSize: 12.5, color: 'var(--text)' }}>{a.name}</code>
            {a.repoPath ? <code style={{ fontFamily: mono, fontSize: 11.5, color: 'var(--text-muted)' }}>{a.repoPath}</code> : null}
          </div>
          {a.facts?.length ? (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
              {a.facts.map((f) => (
                <span key={f.label} style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {f.label}: <code style={{ fontFamily: mono }}>{f.value}</code>
                </span>
              ))}
            </div>
          ) : null}
          {a.body !== undefined && a.body.length > 0 ? (
            <pre
              style={{
                margin: '6px 0 0',
                padding: 10,
                maxHeight: 360,
                overflow: 'auto',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontFamily: mono,
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre',
              }}
            >
              {a.body}
            </pre>
          ) : null}
          {a.note ? <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{a.note}</p> : null}
        </div>
      ))}
    </>
  );
}

function SectionBody({ section, gitBadge }: { section: EngineeringSection; gitBadge?: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>{section.title}</h4>
        {section.tool === 'git' && gitBadge ? gitBadge : null}
      </div>
      {section.unavailable ? (
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{emptyText(section)}</p>
      ) : null}
      <Artefacts section={section} />
      {section.graph ? (
        <div style={{ marginTop: 14 }}>
          <GraphDiagram graph={section.graph} />
        </div>
      ) : null}
      {section.links.length ? (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
          {section.links.map((l) =>
            l.url ? (
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                {l.label} ↗
              </a>
            ) : (
              <span key={l.label} style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                {unresolvedText(l.unresolvedReason ?? '')}
              </span>
            ),
          )}
        </div>
      ) : null}
      {section.commands.length ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{COMMANDS_HEADING}</div>
          {section.commands.map((c) => (
            <div key={c.command} style={{ marginTop: 6 }}>
              <pre style={{ margin: 0, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontFamily: mono, fontSize: 12, overflowX: 'auto' }}>
                {c.command}
              </pre>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.description}</span>
            </div>
          ))}
        </div>
      ) : null}
      {section.caveats?.length ? (
        <div style={{ marginTop: 14, borderLeft: '2px solid var(--gold-line)', paddingLeft: 10 }}>
          <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{CAVEATS_HEADING}</div>
          {section.caveats.map((c, i) => (
            <p key={i} style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{c}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The fetch + the tabs. Mounted only while the panel is open, so closing it costs nothing. */
function HoodBody({ kind, id, gitBadge }: { kind: EngineeringKind; id: string; gitBadge?: ReactNode }) {
  const { data, loading, error } = useApi<EngineeringView>(`/api/engineering/${kind}/${encodeURIComponent(id)}`);
  const sections = useMemo(() => (data ? orderedSections(data) : []), [data]);
  const [active, setActive] = useState(0);
  const section = sections[Math.min(active, Math.max(0, sections.length - 1))];
  return (
    <div style={{ padding: '0 16px 16px' }}>
      {loading ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{PANEL_LOADING}</p> : null}
      {error ? <p style={{ fontSize: 13, color: 'var(--danger)' }}>{PANEL_ERROR_PREFIX}{error}</p> : null}
      {data ? (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
            {sections.map((s, i) => (
              <button
                key={s.tool}
                type="button"
                onClick={() => setActive(i)}
                style={{
                  fontFamily: mono,
                  fontSize: 12.5,
                  padding: '4px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  border: `1px solid ${i === active ? 'var(--border-strong)' : 'transparent'}`,
                  background: i === active ? 'var(--bg-elevated)' : 'transparent',
                  color: s.unavailable ? 'var(--text-faint)' : 'var(--text)',
                }}
              >
                {tabCaption(s)}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>{section ? <SectionBody section={section} gitBadge={gitBadge} /> : null}</div>
          {data.export ? (
            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{EXPORT_HEADING}</div>
              <div style={{ marginTop: 4, fontSize: 13 }}>
                {data.export.href ? (
                  <a href={data.export.href} style={{ fontSize: 13 }}>
                    {data.export.label} ↓
                  </a>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                    {data.export.label}: {data.export.unresolvedReason}
                  </span>
                )}
              </div>
              {data.export.commands.map((c) => (
                <pre key={c} style={{ margin: '6px 0 0', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontFamily: mono, fontSize: 12, overflowX: 'auto' }}>
                  {c}
                </pre>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The panel. One line on a detail page:
 *   `<UnderTheHood kind="dataset" id={datasetId} />`
 * and, where stream G's badge is already on the page, `gitBadge={<GitHeadBadge … />}`.
 */
export function UnderTheHood({ kind, id, gitBadge }: { kind: EngineeringKind; id: string; gitBadge?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ marginTop: 24, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--panel)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, padding: '14px 16px', cursor: 'pointer', color: 'var(--text)' }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>{PANEL_TITLE}</span>
        <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-faint)' }}>{open ? '▴' : '▾'}</span>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)', maxWidth: '72ch' }}>{PANEL_SUBTITLE}</p>
      </button>
      {open ? <HoodBody kind={kind} id={id} gitBadge={gitBadge} /> : null}
    </section>
  );
}
