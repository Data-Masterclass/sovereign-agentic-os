/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { renderMermaid } from '@/lib/knowledge/mermaid';
import type { Workflow } from '@/lib/knowledge/schema';

/**
 * Mermaid preview — the DERIVED, read-only third surface (locked decision: the
 * markdown + the visual swimlane are the two EDITABLE surfaces; Mermaid is
 * generated one-way from them). We emit the diagram SOURCE (pure `renderMermaid`)
 * rather than bundling the heavy mermaid runtime, keeping the OS air-gap clean —
 * the source renders in Forgejo/any markdown viewer and is copy-pasteable. This is
 * honest about being a derived artifact, not a second editor.
 */
export default function MermaidPreview({ workflow }: { workflow: Workflow }) {
  const [copied, setCopied] = useState(false);
  const src = renderMermaid(workflow);

  async function copy() {
    try {
      await navigator.clipboard.writeText('```mermaid\n' + src + '\n```');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked; ignore */ }
  }

  return (
    <div className="mmd-wrap">
      <div className="mmd-head">
        <span className="muted" style={{ fontSize: 12 }}>
          Derived diagram — generated from the steps (read-only)
        </span>
        <button className="btn ghost sm" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy Mermaid'}
        </button>
      </div>
      <pre className="mmd-src">{src}</pre>
      <style>{`
        .mmd-wrap {
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--panel);
          padding: 12px 14px;
        }
        .mmd-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .mmd-src {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
          margin: 0;
          color: var(--text-muted);
          max-height: 320px;
          overflow: auto;
        }
      `}</style>
    </div>
  );
}
