/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ALL = '__all__';

/**
 * The active operating-domain picker in the sidebar. Selecting a domain scopes
 * every tab's lists to it AND files new artifacts there; "All domains" restores
 * the cross-domain view. The choice is remembered (cookie) across logins.
 */
export function DomainSwitcher({
  allDomains,
  activeDomain,
  onChanged,
}: {
  allDomains: string[];
  activeDomain: string | null;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const value = activeDomain ?? ALL;

  async function pick(next: string) {
    const domain = next === ALL ? null : next;
    setBusy(true);
    try {
      await fetch('/api/session/active-domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      onChanged?.();
      router.refresh(); // re-render server components against the new scope
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="domain-switch" title="Choose the domain you operate in">
      <span className="domain-switch-label">Operating in</span>
      <select
        className="domain-switch-select"
        value={value}
        disabled={busy}
        onChange={(e) => pick(e.target.value)}
      >
        <option value={ALL}>All domains</option>
        {allDomains.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </label>
  );
}
