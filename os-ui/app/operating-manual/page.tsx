/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import type { DomainKnowledge } from '@/lib/knowledge/schema';
import type { ManualScope } from '@/lib/knowledge/manual';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import VersionHistory from '@/components/lifecycle/VersionHistory';

/**
 * The Operating Manual tab. One guided-sections card (overview / glossary / goals /
 * key context) at THREE scopes, each governed independently server-side:
 *   • My      — a personal manual; only you read + edit it.
 *   • Domain  — your domain's shared manual; everyone reads, domain admins edit.
 *   • Company — the org-wide manual; everyone reads, a platform admin edits.
 * The edit affordance appears only when the API says the caller may edit
 * (`canEdit`); everyone else sees a calm, read-only view.
 */

type ScopeDef = { key: ManualScope; label: string; blurb: string; readOnlyNote: string };

const SCOPES: ScopeDef[] = [
  {
    key: 'my',
    label: 'My Operating Manual',
    blurb: 'Your personal operating manual — how you work, your context. Private to you.',
    readOnlyNote: '',
  },
  {
    key: 'domain',
    label: 'Domain',
    blurb: 'Pinned as base context for every agent in this domain. Keep it short and current.',
    readOnlyNote: 'Read-only — a domain admin keeps the domain manual current.',
  },
  {
    key: 'company',
    label: 'Company',
    blurb: 'The organisation-wide operating manual — shared by every domain.',
    readOnlyNote: 'Read-only — a platform admin keeps the company manual current.',
  },
];

const SECTION_PLACEHOLDERS: Record<string, string> = {
  overview:
    'A short description — what this covers, who it serves, and what makes it distinct…',
  glossary:
    'Key terms and their definitions — e.g.\n\n**Data Product:** A certified, shared dataset in the marketplace.',
  goals:
    'Current objectives — e.g.\n\n- Reduce submission error rate below 0.1%\n- Achieve 48h SLA on bank submissions',
  context:
    'Background knowledge agents need — key partners, systems, constraints, deadlines…',
};

type ManualPayload = DomainKnowledge & { canEdit: boolean };

export default function OperatingManualPage() {
  const [scope, setScope] = useState<ManualScope>('domain');
  const [card, setCard] = useState<ManualPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [history, setHistory] = useState(false);

  const def = SCOPES.find((s) => s.key === scope)!;

  const load = useCallback(async () => {
    setLoading(true);
    setEditingSection(null);
    setMsg('');
    setHistory(false);
    try {
      const res = await fetch(`/api/knowledge/manual/${scope}`, { cache: 'no-store' });
      if (res.ok) setCard(await res.json());
      else setCard(null);
    } catch {
      setCard(null);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(id: string) {
    const sec = card?.sections.find((s) => s.id === id);
    setDraft(sec?.content ?? '');
    setEditingSection(id);
    setMsg('');
  }

  async function saveDraft() {
    if (!editingSection || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/knowledge/manual/${scope}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sections: [{ id: editingSection, content: draft }] }),
      });
      if (res.ok) {
        setCard(await res.json());
        setEditingSection(null);
        setMsg('Saved.');
        setTimeout(() => setMsg(''), 2000);
      } else {
        setMsg('Could not save — please retry.');
      }
    } catch {
      setMsg('Could not save — please retry.');
    } finally {
      setSaving(false);
    }
  }

  const canEdit = !!card?.canEdit;

  return (
    <ConfirmProvider>
      <PageHeader title="Operating Manual" crumb="how this org · domain · you actually work" />
      <div className="content">

        {/* My · Domain · Company scope switcher */}
        <div className="seg" style={{ marginTop: 18 }}>
          {SCOPES.map((s) => (
            <button key={s.key} type="button" className={scope === s.key ? 'on' : ''} onClick={() => setScope(s.key)}>
              {s.label}
            </button>
          ))}
        </div>

        <p className="hint" style={{ marginTop: 12, marginBottom: 4 }}>{def.blurb}</p>

        {loading ? (
          <div className="stub-page" style={{ marginTop: 18 }}><span className="spin" /> Loading…</div>
        ) : card ? (
          <div style={{ marginTop: 8 }}>
            {!canEdit && def.readOnlyNote && (
              <p className="hint" style={{ marginTop: 0, marginBottom: 8, fontStyle: 'italic' }}>{def.readOnlyNote}</p>
            )}
            {card.sections.map((section) => (
              <div key={section.id} className="om-section">
                <div className="om-section-head">
                  <span className="om-section-label">{section.title}</span>
                  {canEdit && editingSection !== section.id && (
                    <button className="btn ghost sm" onClick={() => startEdit(section.id)}>Edit</button>
                  )}
                </div>
                {canEdit && editingSection === section.id ? (
                  <>
                    <textarea
                      className="om-section-editor"
                      rows={6}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={SECTION_PLACEHOLDERS[section.id]}
                      autoFocus
                    />
                    <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                      <button className="btn ghost sm" onClick={() => setEditingSection(null)} disabled={saving}>Cancel</button>
                      <button className="btn sm" onClick={() => void saveDraft()} disabled={saving}>
                        {saving ? <span className="spin" /> : 'Save'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="om-section-body">
                    {section.content ? (
                      <pre className="om-prose">{section.content}</pre>
                    ) : (
                      <span className="muted" style={{ fontSize: 13, fontStyle: 'italic' }}>
                        {SECTION_PLACEHOLDERS[section.id]}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {msg && (
              msg === 'Saved.'
                ? <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{msg}</div>
                : <div className="error" style={{ marginTop: 8 }}>{msg}</div>
            )}

            {/* Version history for the whole card (restore is edit-gated server-side). */}
            <div className="lc-actions row" style={{ gap: 8, alignItems: 'center', marginTop: 12 }}>
              <button
                type="button"
                className={`btn ghost sm${history ? ' on' : ''}`}
                onClick={() => setHistory((v) => !v)}
                aria-expanded={history}
              >
                {history ? 'Hide history' : 'Version history'}
              </button>
            </div>
            {history && (
              <div className="lc-history-panel">
                <VersionHistory
                  basePath={`/api/knowledge/manual/${scope}`}
                  name={def.key === 'my' ? def.label : `${def.label} operating manual`}
                  onRestored={() => void load()}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="stub-page" style={{ marginTop: 18 }}>Could not load this operating manual.</div>
        )}

      </div>

      <style>{OperatingManualStyles}</style>
    </ConfirmProvider>
  );
}

const OperatingManualStyles = `
.om-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin-top: 14px;
  background: var(--panel);
}
.om-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.om-section-label {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--gold-text);
}
.om-section-editor {
  width: 100%;
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.6;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  resize: vertical;
}
.om-section-body { margin-top: 2px; }
.om-prose {
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  color: var(--text);
}
`;
