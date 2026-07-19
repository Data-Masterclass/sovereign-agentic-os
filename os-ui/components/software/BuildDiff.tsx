/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';

/** Mirrors lib/software/build-changeset.ts FileChange (kept local to avoid a server import). */
export type FileChange = {
  path: string;
  kind: 'added' | 'modified' | 'removed';
  before: string;
  after: string;
};

/** Split a line diff into add/remove/context rows — a tiny LCS-free line compare. */
type Row = { sign: ' ' | '+' | '-'; text: string };

/**
 * A minimal, dependency-free line diff. Not an optimal LCS — it walks both sides
 * and, when they diverge, emits the removed run then the added run. Good enough
 * for the legible before/after a Build run produces; no external diff lib.
 */
function lineDiff(before: string, after: string): Row[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ sign: ' ', text: a[i] });
      i++;
      j++;
      continue;
    }
    // Find the next matching anchor within a small window to resync.
    const nextMatchInB = j < b.length ? a.indexOf(b[j], i) : -1;
    const nextMatchInA = i < a.length ? b.indexOf(a[i], j) : -1;
    if (nextMatchInB !== -1 && (nextMatchInA === -1 || nextMatchInB - i <= nextMatchInA - j)) {
      // Lines removed up to the anchor.
      while (i < nextMatchInB) rows.push({ sign: '-', text: a[i++] });
    } else if (nextMatchInA !== -1) {
      // Lines added up to the anchor.
      while (j < nextMatchInA) rows.push({ sign: '+', text: b[j++] });
    } else {
      if (i < a.length) rows.push({ sign: '-', text: a[i++] });
      if (j < b.length) rows.push({ sign: '+', text: b[j++] });
    }
  }
  return rows;
}

function KindBadge({ kind }: { kind: FileChange['kind'] }) {
  const cls = kind === 'added' ? 'ok' : kind === 'removed' ? 'warn' : 'muted';
  return <span className={`badge ${cls}`}>{kind}</span>;
}

function DiffBody({ change }: { change: FileChange }) {
  const rows = useMemo(() => lineDiff(change.before, change.after), [change.before, change.after]);
  return (
    <pre className="answer mono sw-diff-body" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
      {rows.map((r, idx) => (
        <div
          key={idx}
          style={{
            background:
              r.sign === '+' ? 'color-mix(in srgb, var(--ok, #16a34a) 12%, transparent)'
                : r.sign === '-' ? 'color-mix(in srgb, var(--danger, #b42318) 12%, transparent)'
                : 'transparent',
            paddingInline: 6,
          }}
        >
          <span style={{ opacity: 0.5, userSelect: 'none' }}>{r.sign} </span>
          {r.text || ' '}
        </div>
      ))}
    </pre>
  );
}

/**
 * The per-run CHANGESET surfaced inline in the Build stage: the files the last
 * Build run actually changed, as expandable before/after diffs. Clean, legible,
 * real committed content — never prose.
 */
export default function BuildDiff({ changes, summary }: { changes: FileChange[]; summary: string }) {
  // First file open by default so the change is visible without a click.
  const [open, setOpen] = useState<Record<string, boolean>>(() => (changes[0] ? { [changes[0].path]: true } : {}));
  if (changes.length === 0) return null;

  return (
    <div className="grant-block" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="comp-label" style={{ margin: 0 }}>Changes this run</div>
        <span className="muted" style={{ fontSize: 12 }}>{summary}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
        {changes.map((c) => {
          const isOpen = !!open[c.path];
          return (
            <li key={c.path} style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="code-fileitem"
                onClick={() => setOpen((o) => ({ ...o, [c.path]: !o[c.path] }))}
                aria-expanded={isOpen}
                style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', textAlign: 'left' }}
              >
                <span style={{ opacity: 0.5, width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                <span className="mono" style={{ fontSize: 12, flex: 1 }}>{c.path}</span>
                <KindBadge kind={c.kind} />
              </button>
              {isOpen ? <DiffBody change={c} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
