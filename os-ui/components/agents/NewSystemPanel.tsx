/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { TEMPLATES, type TemplateKey } from '@/lib/agents/templates';
import { getUrlParam } from '@/lib/core/url-params';
import { useToast } from '@/components/core/Toast';

/**
 * Create a new agent system, guided. Pick a plain-language starter template
 * (server-authored — the API never accepts client yaml) then name it. Lands under
 * Personal with a tuned single-agent starter so a course participant begins from
 * something useful, not a blank canvas. Reused on the landing AND in the rail's
 * "+ New" pane so the create-flow keeps the same layout.
 */
export default function NewSystemPanel({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState(() => getUrlParam('name') ?? '');
  const [template, setTemplate] = useState<TemplateKey>('blank');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const toast = useToast();

  const create = async () => {
    if (!name.trim() || creating) return;
    const teamName = name.trim();
    setCreating(true);
    setErr('');
    try {
      const res = await fetch('/api/agents/systems', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, template }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not create the system');
      setName('');
      toast.success(`"${teamName}" created`);
      onCreated(body.id);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="card new-system" {...anchorAttr(ANCHORS.agents.define)}>
      <h3 style={{ marginTop: 0 }}>New agent system</h3>
      <p className="hint" style={{ marginTop: 0 }}>Pick a starting point — you can change everything after.</p>

      <div className="tmpl-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tmpl-card${template === t.key ? ' active' : ''}`}
            aria-pressed={template === t.key}
            onClick={() => setTemplate(t.key)}
          >
            <span className="tmpl-label">{t.label}</span>
            <span className="tmpl-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder="Name it — e.g. Renewals desk"
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={create} disabled={creating || !name.trim()}>
          {creating ? <span className="spin" /> : 'Create'}
        </button>
      </div>
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}
