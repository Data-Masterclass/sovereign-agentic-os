/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Fragment, type ReactNode } from 'react';
import type { OsClient } from '@/lib/app-sdk/index.ts';
import type { LandingConfig, RecordsTableConfig } from '@/lib/software/appspec/patterns.ts';
import type { AppFunction } from '@/lib/software/appspec/functions-schema.ts';
import { KpiCards } from './KpiCards.tsx';
import { TableViewRenderer } from './TableViewRenderer.tsx';

/**
 * Render the `landing` pattern: a composed home page of ordered blocks — prose (a SAFE markdown
 * subset), a KPI row (reusing the shared `KpiCards`), and a featured table (reusing the flagship
 * `TableViewRenderer`). No `dangerouslySetInnerHTML`: the markdown is parsed into React nodes so
 * an author's prose can never inject script/HTML. Each block composes its own governed fetch.
 */

/** Inline markdown: **bold**, *italic*, `code`. Split-and-map into React nodes (no raw HTML). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return out;
}

/** A safe, tiny markdown block renderer: #/##/### headings, - bullets, blank-line paragraphs. */
function Markdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;
  const flushList = () => {
    if (list.length === 0) return;
    nodes.push(
      <ul key={key++} style={{ margin: '4px 0 4px 20px', color: 'var(--sb-text-muted)', lineHeight: 1.6 }}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) {
      flushList();
      nodes.push(<h4 key={key++} style={{ fontFamily: 'var(--sb-font-head)', fontSize: 15, margin: '10px 0 2px' }}>{inline(line.slice(4))}</h4>);
    } else if (line.startsWith('## ')) {
      flushList();
      nodes.push(<h3 key={key++} style={{ fontFamily: 'var(--sb-font-head)', fontSize: 19, margin: '12px 0 4px' }}>{inline(line.slice(3))}</h3>);
    } else if (line.startsWith('# ')) {
      flushList();
      nodes.push(<h2 key={key++} style={{ fontFamily: 'var(--sb-font-head)', fontSize: 26, fontWeight: 600, letterSpacing: '-0.5px', margin: '4px 0 6px' }}>{inline(line.slice(2))}</h2>);
    } else if (line.startsWith('- ')) {
      list.push(line.slice(2));
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      nodes.push(<p key={key++} style={{ margin: '4px 0', color: 'var(--sb-text-muted)', lineHeight: 1.6 }}>{inline(line)}</p>);
    }
  }
  flushList();
  return <div>{nodes}</div>;
}

export function LandingRenderer({ view, os, functions }: { view: LandingConfig; os: OsClient; functions?: AppFunction[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 960 }}>
      {view.blocks.map((block, i) => {
        if (block.kind === 'markdown') return <Markdown key={i} content={block.content} />;
        if (block.kind === 'kpi') return <KpiCards key={i} cards={block.cards} os={os} functions={functions} />;
        // table — reuse the flagship table renderer with a records-table config shape.
        const cfg: RecordsTableConfig = { source: block.source, columns: block.columns };
        return <TableViewRenderer key={i} view={cfg} os={os} />;
      })}
    </div>
  );
}
