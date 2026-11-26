/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    DomainStartPrompt — the first-login "where do you want to work?" domain picker
 * USER STORY: As a user who belongs to several domains I want to choose my working domain once,
 *             or keep all domains, so that my lists and new work are scoped to it.
 * ARCHITECTURE:
 *   - Rendered by `core/ui/Sidebar.tsx`. The caller decides when to show it (more than one domain
 *     and no choice made yet).
 *   - POSTs the choice to `/api/session/active-domain` (null = all domains), then reloads the
 *     page so every tab re-scopes.
 * I18N:       converted (wave 1) — strings from `shell.domainPrompt.*`.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from '@core/i18n/client';

/**
 * One-time first-login prompt shown ONLY to a multi-domain user who hasn't yet
 * made a domain choice. Picking a domain focuses the OS on it; "All domains"
 * keeps the cross-domain view. Either way the choice is remembered, so this
 * never appears again. Single-domain users never see it (the caller gates on
 * `allDomains.length > 1`).
 */
export function DomainStartPrompt({ allDomains }: { allDomains: string[] }) {
  const t = useTranslations('shell');
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(domain: string | null) {
    setBusy(domain ?? '__all__');
    try {
      await fetch('/api/session/active-domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      // Hard reload so every tab re-scopes to the chosen domain.
      window.location.reload();
    } catch {
      setBusy(null);
    }
  }

  return (
    <div className="domain-prompt-backdrop" role="dialog" aria-modal="true" aria-label={t('domainPrompt.aria')}>
      <div className="domain-prompt">
        <h2>{t('domainPrompt.title')}</h2>
        <p>{t('domainPrompt.body')}</p>
        <button className="domain-prompt-opt" disabled={busy !== null} onClick={() => choose(null)}>
          <span className="domain-prompt-dot all" />
          <span>
            <strong>{t('domain.all')}</strong>
            <em>{t('domainPrompt.allHint')}</em>
          </span>
        </button>
        {allDomains.map((d) => (
          <button key={d} className="domain-prompt-opt" disabled={busy !== null} onClick={() => choose(d)}>
            <span className="domain-prompt-dot" />
            <span>
              <strong>{d}</strong>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
