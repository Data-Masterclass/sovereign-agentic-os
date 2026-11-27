/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The "this grant contains 0 files" warning, as catalog keys for the builder's own language
 * USER STORY: As a team author working in German or Polish I want the amber "this folder grant matches
 *             nothing" note — and where the items of that name actually are — in my language.
 * ARCHITECTURE:
 *   - Pure, client-safe. Mirrors `zeroMatchWarning` / `zeroMatchFolderGrants` in lib/grant-apply.ts,
 *     but returns `{ key, args }` (keys relative to the `agents` namespace, area `grants.empty`) instead
 *     of an English sentence. An argument may itself be a message (a folder or lane name), rendered first.
 *   - The English functions in grant-apply.ts stay as they are: the build verifier (lib/build/os-tools.ts)
 *     reports them to the model and the run, which stay English. The unit test proves this module renders
 *     byte-identical English through the catalog.
 */
import { normaliseFolderPath } from '@core/kernel/folders';
import type { System } from '@tabs/agents/lib/system-schema';
import {
  folderGrantCoverage, isOutputFolder,
  type FolderGrantCoverage, type FolderRef, type FolderedGrantKind, type GrantFeedSlice, type TreeItemRef,
} from '@tabs/agents/lib/grant-apply';

/** A catalog message; an argument may be another message that is rendered first. */
export type GrantMsg = { key: string; args?: Record<string, string | number | GrantMsg> };

/** `My files` / `Domain data` … */
function lane(scope: FolderRef['scope'], kind: FolderedGrantKind): GrantMsg {
  return { key: `grants.lane.${scope}.${kind}` };
}

/** How a folder grant is named to a person: `/invoices in Domain files` / `all of My files`. */
export function describeFolderGrantMessage(kind: FolderedGrantKind, f: FolderRef): GrantMsg {
  const path = normaliseFolderPath(f.path);
  return path === '/'
    ? { key: 'grants.folder.root', args: { lane: lane(f.scope, kind) } }
    : { key: 'grants.folder.path', args: { path, lane: lane(f.scope, kind) } };
}

/**
 * The sentences of a zero-match warning (one or two, joined with a space where shown), or null when
 * the grant covers items. Same rule and English as `zeroMatchWarning`.
 */
export function zeroMatchMessages(
  kind: FolderedGrantKind,
  cov: FolderGrantCoverage,
  subject: 'this' | 'named' = 'this',
): GrantMsg[] | null {
  if (cov.count > 0) return null;
  const head: GrantMsg = subject === 'this'
    ? { key: `grants.empty.this.${kind}` }
    : { key: `grants.empty.named.${kind}`, args: { folder: describeFolderGrantMessage(kind, cov.folder) } };
  if (!cov.elsewhere) return [head];
  const e = cov.elsewhere;
  const where: GrantMsg = normaliseFolderPath(e.path) === '/'
    ? lane(e.scope, kind)
    : { key: 'grants.folder.lanePath', args: { lane: lane(e.scope, kind), path: e.path } };
  return [head, { key: `grants.empty.elsewhere.${kind}`, args: { count: e.count, where } }];
}

/** One warning (as message sentences) per enabled folder grant known to match nothing — `zeroMatchFolderGrants`. */
export function zeroMatchFolderGrantMessages(system: System, kind: FolderedGrantKind, feed: GrantFeedSlice): GrantMsg[][] {
  const laneItems: TreeItemRef[] = feed.items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', scope: a.scope as FolderRef['scope'] }));
  const keyOf = (f: { path: string; scope: string }) => `${f.scope}:${normaliseFolderPath(f.path)}`;
  const outside = new Set((feed.folders ?? []).filter((f) => f.outsideDomain).map(keyOf));
  const out: GrantMsg[][] = [];
  for (const g of system.grants[kind]) {
    if (!g.folder || g.capability === 'Off' || g.capability === 'Blocked') continue;
    const f: FolderRef = { path: g.folder.path, scope: g.folder.scope };
    if (outside.has(keyOf(f)) || isOutputFolder(system, kind, f)) continue;
    const msgs = zeroMatchMessages(kind, folderGrantCoverage(f, laneItems), 'named');
    if (msgs) out.push(msgs);
  }
  return out;
}

/** Render a message tree with a translator (`t` from `useTranslations('agents')`, or a test catalog). */
export function renderGrantMsg(
  m: GrantMsg,
  translate: (key: string, args?: Record<string, string | number>) => string,
): string {
  const args: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.args ?? {})) args[k] = typeof v === 'object' ? renderGrantMsg(v, translate) : v;
  return translate(m.key, m.args ? args : undefined);
}

/** Render a warning's sentences as the one line the UI shows. */
export function renderGrantWarning(
  msgs: GrantMsg[],
  translate: (key: string, args?: Record<string, string | number>) => string,
): string {
  return msgs.map((m) => renderGrantMsg(m, translate)).join(' ');
}
