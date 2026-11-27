/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { TEMPLATES, type TemplateKey } from '@tabs/agents/lib/templates';
import { getUrlParam } from '@core/kernel/url-params';
import { useToast } from '@core/ui/core/Toast';
import { useTranslations, useServerMessage } from '@core/i18n/client';

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
  const t = useTranslations('agents');
  const msg = useServerMessage();

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
      if (!res.ok) throw new Error(msg(body, t('newSystem.createFailed')));
      setName('');
      toast.success(t('newSystem.created', { name: teamName }));
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
    <div className="card new-system">
      <h3 style={{ marginTop: 0 }}>{t('newSystem.title')}</h3>
      <p className="hint" style={{ marginTop: 0 }}>{t('newSystem.hint')}</p>

      <div className="tmpl-grid">
        {TEMPLATES.map((tpl) => (
          <button
            key={tpl.key}
            type="button"
            className={`tmpl-card${template === tpl.key ? ' active' : ''}`}
            aria-pressed={template === tpl.key}
            onClick={() => setTemplate(tpl.key)}
          >
            <span className="tmpl-label">{t(`newSystem.templates.${tpl.key}.label`)}</span>
            <span className="tmpl-blurb">{t(`newSystem.templates.${tpl.key}.blurb`)}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder={t('newSystem.placeholder')}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={create} disabled={creating || !name.trim()}>
          {creating ? <span className="spin" /> : t('newSystem.create')}
        </button>
      </div>
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}
