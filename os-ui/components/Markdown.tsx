/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <Markdown> — renders GFM markdown from LLM responses.
 *
 * Security: raw HTML passthrough is deliberately disabled (react-markdown default).
 * Tables scroll horizontally on overflow. Links open in a new tab.
 * Typography and colours are driven by the app's CSS variables so it blends in
 * with the rest of the OS UI rather than imposing its own opinionated theme.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentPropsWithoutRef } from 'react';

type Props = { children: string; muted?: boolean };

export default function Markdown({ children, muted = false }: Props) {
  return (
    <div className={`md-body${muted ? ' md-muted' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links — always open externally, never trust href from LLM for navigation.
          a: ({ href, children: kids, ...rest }: ComponentPropsWithoutRef<'a'>) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {kids}
            </a>
          ),
          // Wrap tables so they scroll on overflow without breaking the layout.
          table: ({ children: kids, ...rest }: ComponentPropsWithoutRef<'table'>) => (
            <div className="md-table-wrap">
              <table {...rest}>{kids}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>

      <style jsx>{`
        .md-body {
          color: var(--text);
          font-size: 1rem;
          line-height: 1.65;
        }
        .md-muted {
          color: var(--text-muted);
          font-size: 0.85rem;
          line-height: 1.6;
        }

        /* ── headings: scaled down so they don't overpower the chat bubble ── */
        .md-body :global(h1),
        .md-body :global(h2),
        .md-body :global(h3),
        .md-body :global(h4),
        .md-body :global(h5),
        .md-body :global(h6) {
          font-weight: 600;
          line-height: 1.3;
          margin: 1em 0 0.35em;
          color: var(--text);
        }
        .md-body :global(h1) { font-size: 1.2rem; }
        .md-body :global(h2) { font-size: 1.1rem; }
        .md-body :global(h3) { font-size: 1rem; }
        .md-body :global(h4),
        .md-body :global(h5),
        .md-body :global(h6) { font-size: 0.9rem; }

        /* ── paragraphs ── */
        .md-body :global(p) {
          margin: 0.55em 0;
        }
        .md-body :global(p:first-child) { margin-top: 0; }
        .md-body :global(p:last-child)  { margin-bottom: 0; }

        /* ── lists ── */
        .md-body :global(ul),
        .md-body :global(ol) {
          margin: 0.45em 0;
          padding-left: 1.4em;
        }
        .md-body :global(li) { margin: 0.2em 0; }
        .md-body :global(li > p) { margin: 0; }

        /* ── inline code ── */
        .md-body :global(code) {
          font-family: 'Berkeley Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
          font-size: 0.82em;
          background: var(--bg-elevated, var(--panel));
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 0.12em 0.38em;
          color: var(--text);
        }

        /* ── code blocks ── */
        .md-body :global(pre) {
          background: var(--bg-elevated, var(--panel));
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px 14px;
          overflow-x: auto;
          margin: 0.7em 0;
        }
        .md-body :global(pre > code) {
          background: transparent;
          border: none;
          padding: 0;
          font-size: 0.8rem;
          line-height: 1.55;
        }

        /* ── blockquote ── */
        .md-body :global(blockquote) {
          margin: 0.6em 0;
          padding: 8px 14px;
          border-left: 3px solid var(--border);
          background: var(--tile, var(--panel));
          border-radius: 0 6px 6px 0;
          color: var(--text-muted);
        }
        .md-body :global(blockquote p) { margin: 0; }

        /* ── horizontal rule ── */
        .md-body :global(hr) {
          border: none;
          border-top: 1px solid var(--border);
          margin: 1em 0;
        }

        /* ── links ── */
        .md-body :global(a) {
          color: var(--gold-text, var(--accent));
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-thickness: 1px;
        }
        .md-body :global(a:hover) { opacity: 0.8; }

        /* ── GFM tables ── */
        .md-table-wrap {
          overflow-x: auto;
          margin: 0.8em 0;
          border-radius: 6px;
          border: 1px solid var(--border);
        }
        .md-body :global(table) {
          border-collapse: collapse;
          width: 100%;
          font-size: 0.88rem;
          min-width: 420px;
        }
        .md-body :global(th),
        .md-body :global(td) {
          padding: 7px 12px;
          text-align: left;
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        .md-body :global(th) {
          font-weight: 600;
          background: var(--tile, var(--panel));
          color: var(--text);
          border-bottom: 2px solid var(--border);
        }
        .md-body :global(tr:last-child td) { border-bottom: none; }
        .md-body :global(tr:hover td) { background: var(--hover, rgba(255,255,255,0.03)); }

        /* ── GFM task-list checkboxes ── */
        .md-body :global(input[type='checkbox']) {
          margin-right: 6px;
          accent-color: var(--gold-text, var(--accent));
        }

        /* ── GFM strikethrough ── */
        .md-body :global(del) { opacity: 0.55; }

        /* ── strong / em ── */
        .md-body :global(strong) { font-weight: 600; }
        .md-body :global(em)     { font-style: italic; }
      `}</style>
    </div>
  );
}
