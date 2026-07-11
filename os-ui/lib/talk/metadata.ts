/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PER-TAB METADATA — the compact, entitled-scope overview each copilot is grounded on.
 *
 * `getTabMetadata(tabId, user)` returns a structured summary of ONLY what the caller may
 * see (DLS-scoped): it reuses each tab's EXISTING governed `list_*` function — the same
 * visibility gate the tab's UI uses — so a copilot can never surface an artifact the user
 * isn't entitled to. The overview is small on purpose: it is PINNED into the model context
 * (always kept by the assembler), so it is a shape-of-the-scope map, not a data dump.
 *
 * Server-only (the `list_*` sources read the in-process governed stores).
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { listAskable } from '@/lib/data/store';
import { listWorkflows } from '@/lib/knowledge/store';
import { listFiles } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listConnectionsForUser } from '@/lib/connections/store';
import type { TabMetadata, TabMetadataSource, TalkCitation, TalkTabId } from './schema.ts';

/** A Principal is a CurrentUser minus `name` — the shape the data/knowledge/files stores take. */
type Principal = { id: string; domains: string[]; role: CurrentUser['role'] };
function principal(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}

/** Cap any one section so a large tenant can't blow the pinned overview past a sane size. */
const MAX_ROWS = 40;
function capped<T>(xs: T[]): { rows: T[]; more: number } {
  return { rows: xs.slice(0, MAX_ROWS), more: Math.max(0, xs.length - MAX_ROWS) };
}
function moreLine(more: number, noun: string): string[] {
  return more > 0 ? [`  …and ${more} more ${noun} you can access.`] : [];
}

// ------------------------------------------------------------------------ data --

function dataMetadata(user: CurrentUser): TabMetadata {
  const all = listAskable(principal(user));
  const { rows, more } = capped(all);
  const citations: TalkCitation[] = rows.map((d) => ({
    id: d.fqn,
    label: d.name,
    kind: 'dataset',
    href: `/data#${d.id}`,
  }));
  const lines =
    all.length === 0
      ? ['You can currently query no materialized datasets.']
      : [
          `You can query ${all.length} materialized dataset${all.length === 1 ? '' : 's'}:`,
          ...rows.map((d) => {
            const cols = d.columns.map((c) => c.name).slice(0, 24).join(', ');
            return `- "${d.name}" (${d.domain}/${d.tier}) → ${d.fqn}; columns: ${cols || '(undocumented)'}`;
          }),
          ...moreLine(more, 'datasets'),
        ];
  return { tabId: 'data', text: lines.join('\n'), citations };
}

// ------------------------------------------------------------------- knowledge --

function knowledgeMetadata(user: CurrentUser): TabMetadata {
  const g = listWorkflows(principal(user));
  const all = [...g.mine, ...g.domain, ...g.marketplace];
  const { rows, more } = capped(all);
  const citations: TalkCitation[] = rows.map((w) => ({
    id: w.id,
    label: w.title,
    kind: 'workflow',
    href: `/knowledge#${w.id}`,
  }));
  const lines =
    all.length === 0
      ? ['You can currently see no knowledge workflows.']
      : [
          `You can see ${all.length} knowledge workflow${all.length === 1 ? '' : 's'}:`,
          ...rows.map((w) => `- "${w.title}" (${w.domain}, ${w.visibility}, ${w.status})`),
          ...moreLine(more, 'workflows'),
        ];
  return { tabId: 'knowledge', text: lines.join('\n'), citations };
}

// ----------------------------------------------------------------------- files --

function filesMetadata(user: CurrentUser): TabMetadata {
  const g = listFiles(principal(user));
  const all = [...g.mine, ...g.domain, ...g.marketplace];
  const { rows, more } = capped(all);
  const citations: TalkCitation[] = rows.map((f) => ({
    id: f.id,
    label: f.name,
    kind: 'file',
    href: f.deepLink,
  }));
  const lines =
    all.length === 0
      ? ['You can currently see no files.']
      : [
          `You can see ${all.length} file${all.length === 1 ? '' : 's'}:`,
          ...rows.map((f) => {
            const tags = f.tags.length ? `; tags: ${f.tags.slice(0, 8).join(', ')}` : '';
            return `- "${f.name}" (${f.kind}, ${f.folder || 'root'})${tags}`;
          }),
          ...moreLine(more, 'files'),
        ];
  return { tabId: 'files', text: lines.join('\n'), citations };
}

// --------------------------------------------------------------------- metrics --

function metricsMetadata(user: CurrentUser): TabMetadata {
  const g = listMetrics(principal(user));
  const all = [...g.mine, ...g.domain, ...g.marketplace];
  const { rows, more } = capped(all);
  const citations: TalkCitation[] = rows.map((m) => ({
    id: m.id,
    label: m.name,
    kind: 'metric',
    href: `/metrics#${m.id}`,
  }));
  const lines =
    all.length === 0
      ? ['You can currently see no metric definitions.']
      : [
          `You can see ${all.length} metric${all.length === 1 ? '' : 's'}:`,
          ...rows.map((m) => `- "${m.name}" (${m.type}) over dataset "${m.datasetName}" (${m.tier})`),
          ...moreLine(more, 'metrics'),
        ];
  return { tabId: 'metrics', text: lines.join('\n'), citations };
}

// ----------------------------------------------------------------- connections --

async function connectionsMetadata(user: CurrentUser): Promise<TabMetadata> {
  const all = await listConnectionsForUser(user);
  const { rows, more } = capped(all);
  const citations: TalkCitation[] = rows.map((c) => ({
    id: c.id,
    label: c.name,
    kind: 'connection',
    href: `/connections#${c.id}`,
  }));
  const lines =
    all.length === 0
      ? ['You can currently see no connections.']
      : [
          `You can see ${all.length} connection${all.length === 1 ? '' : 's'}:`,
          ...rows.map((c) => {
            const caps = c.tools.map((t) => t.name).slice(0, 8).join(', ');
            return `- "${c.name}" (${c.connector}/${c.type}, ${c.mode})${caps ? `; tools: ${caps}` : ''}`;
          }),
          ...moreLine(more, 'connections'),
        ];
  return { tabId: 'connections', text: lines.join('\n'), citations };
}

// --------------------------------------------------------------------- resolve --

const SOURCES: Record<TalkTabId, TabMetadataSource> = {
  data: dataMetadata,
  knowledge: knowledgeMetadata,
  files: filesMetadata,
  metrics: metricsMetadata,
  connections: connectionsMetadata,
};

/** The entitled-scope, DLS-scoped metadata overview for one tab, run AS the caller. */
export function getTabMetadata(tabId: TalkTabId, user: CurrentUser): Promise<TabMetadata> | TabMetadata {
  return SOURCES[tabId](user);
}
