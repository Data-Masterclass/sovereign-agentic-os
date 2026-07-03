/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import TutorialLink from '@/components/tutorials/TutorialLink';
import { listTutorials } from '@/lib/tutorials/registry';
import type { GoldenPathKey } from '@/lib/tutorials/types';

/**
 * Tutorials hub — the single place to find and launch every golden-path
 * tutorial. Each tutorial opens as an overlay in place (TutorialProvider in
 * the root layout handles it), so you never lose your position.
 *
 * The same tutorials are reachable from the Home card ("How it works") and
 * each tab header ("Tutorial") — this page is the discovery index.
 */

const GROUPS: { heading: string; keys: GoldenPathKey[] }[] = [
  {
    heading: 'Work with data',
    keys: ['data', 'knowledge', 'connections', 'metrics', 'dashboards'],
  },
  {
    heading: 'Build & automate',
    keys: ['agents', 'software', 'science'],
  },
  {
    heading: 'Manage & share',
    keys: ['big-bets', 'marketplace'],
  },
];

// Stable icon per golden path (one glyph, on-brand palette).
const PATH_ICON: Record<GoldenPathKey, string> = {
  data: '▤',
  knowledge: '❦',
  connections: '⇄',
  metrics: '∑',
  dashboards: '▦',
  agents: '✦',
  software: '⌘',
  science: '∿',
  'big-bets': '◆',
  marketplace: '⊞',
};

export default function TutorialsPage() {
  const allTutorials = listTutorials();
  const byKey = Object.fromEntries(allTutorials.map((t) => [t.key, t]));

  return (
    <>
      <PageHeader
        title="Tutorials"
        crumb="illustrated guides · walk me through it · safe sandbox"
      />
      <div className="content">
        <p className="lead">
          One illustrated tutorial per golden path. Each opens as an{' '}
          <strong>overlay</strong> so you never lose your place, guides you
          step-by-step on the <strong>real tab</strong>, and lets you practice
          safely in a <strong>personal sandbox</strong> before doing it for real.
        </p>

        {GROUPS.map((group) => (
          <div key={group.heading}>
            <div className="section-title">{group.heading}</div>
            <div className="grid">
              {group.keys.map((key) => {
                const def = byKey[key];
                if (!def) return null;
                return (
                  <div className="card" key={key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        className="ico"
                        style={{ fontSize: 20, color: 'var(--teal)', flexShrink: 0 }}
                      >
                        {PATH_ICON[key]}
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                          {def.title}
                        </div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>
                          {def.tagline}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <TutorialLink tutorial={key} variant="card" />
                      {def.sandbox?.anchor ? (
                        <span className="hint" style={{ fontSize: 11 }}>
                          Sandbox available
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="hint" style={{ marginTop: 28, fontSize: 12.5, lineHeight: 1.6 }}>
          <strong>Two entry points, one source:</strong> every tutorial here is
          the same one you reach from the tab&apos;s <em>Tutorial</em> link or
          the Home card&apos;s <em>How it works</em> link — they can never drift.
          Walk-throughs run on the real tab under your OPA/RLS identity; the
          sandbox lane keeps practice off governed data.
        </div>
      </div>
    </>
  );
}
