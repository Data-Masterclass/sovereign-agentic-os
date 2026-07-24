/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * One-time first-login prompt shown ONLY to a multi-domain user who hasn't yet
 * made a domain choice. Picking a domain focuses the OS on it; "All domains"
 * keeps the cross-domain view. Either way the choice is remembered, so this
 * never appears again. Single-domain users never see it (the caller gates on
 * `allDomains.length > 1`).
 */
export function DomainStartPrompt({ allDomains, onDone }: { allDomains: string[]; onDone?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(domain: string | null) {
    setBusy(domain ?? '__all__');
    try {
      await fetch('/api/session/active-domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      onDone?.();
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="domain-prompt-backdrop" role="dialog" aria-modal="true" aria-label="Choose your operating domain">
      <div className="domain-prompt">
        <h2>Where do you want to work?</h2>
        <p>
          You belong to several domains. Pick the one to operate in — your lists focus on it and new
          work is filed there. You can switch anytime from the sidebar.
        </p>
        <button className="domain-prompt-opt" disabled={busy !== null} onClick={() => choose(null)}>
          <span className="domain-prompt-dot all" />
          <span>
            <strong>All domains</strong>
            <em>See and work across everything (default)</em>
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
