/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Clone this repository" — the one affordance every detail page mounts
 * USER STORY: As an engineer on any dataset, agent-system or dashboard detail page I want the
 *             exact `git clone` command for the domain's repository and a word about the token I
 *             need, so I can leave the UI and keep working in VS Code (E-R1.9, checklist E10).
 * ARCHITECTURE:
 *   - A SHELL. Every decidable thing lives in `core/infra/git-clone.ts` (pure, unit-tested); this
 *     file only renders. Lives in `core/ui/git-clone/` — deliberately NOT in `core/ui/git/`, which
 *     stream G owns — so the five tabs can mount it without two streams editing one directory.
 *   - The mount contract is one line: `<CloneRepository domain={d} filePath={p} />`. `filePath` is
 *     optional and adds the "open this file" link (T's engineering panel passes it).
 *   - The base URL comes from the BROWSER's own origin, so the command is correct for however the
 *     operator exposed the OS. No domain ⇒ renders nothing; no origin ⇒ renders nothing, never a
 *     half command.
 */
'use client';

import { useState } from 'react';
import { CLONE_TOKEN_HINT, cloneCommand, repoFileHref } from '@core/infra/git-clone';

export default function CloneRepository({
  domain,
  filePath,
  ref,
}: {
  domain?: string | null;
  filePath?: string | null;
  ref?: string;
}) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const command = cloneCommand(String(domain ?? ''), origin);
  if (!command) return null;
  const href = filePath ? repoFileHref(String(domain), filePath, ref) : null;

  return (
    <div className="card" style={{ padding: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Clone this repository</strong>
        <span className="muted" style={{ fontSize: 11 }}>git is the system of record</span>
      </div>
      <pre
        style={{ margin: '8px 0 4px', padding: 8, overflowX: 'auto', fontSize: 12 }}
        aria-label="git clone command"
      >
        {command}
      </pre>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className="btn-small"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a className="btn-small" href="/platform?section=tokens">
          Access tokens
        </a>
        {href ? (
          <a className="btn-small" href={href} title={filePath ?? undefined}>
            Open this file in the repo
          </a>
        ) : null}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
        {CLONE_TOKEN_HINT}
      </p>
    </div>
  );
}
