/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The Grant step knows when everything granted is an empty folder
 * USER STORY: As a team author I granted a folder that holds nothing (wrong lane, wrong
 *             letter case); the Grant step shows an amber "!" that says so — whether or not I
 *             have opened the Grant stage in this visit.
 * ARCHITECTURE:
 *   - The count needs the grantable feed (`…/grants/available?kind=`), which the grant
 *     pickers load only while they are mounted. A rail that depended on that would be about
 *     navigation again, so the builder loads the feed itself — ONLY for the kinds that
 *     actually hold an enabled folder grant, and again only when those grants change.
 *   - The rule is the pure `zeroMatchFolderGrants` (lib/grant-apply.ts), the same one the
 *     picker shows at its chips; this hook only fetches and applies it.
 *   - Unknown is never reported as empty: until a feed has loaded, or if it fails to load,
 *     that kind contributes no warning.
 *   - The sentences are rendered in the builder's language (`zeroMatchFolderGrantMessages` in
 *     lib/grant-messages.ts — same rule and, in English, the same words as `zeroMatchFolderGrants`).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { System } from '@tabs/agents/lib/system-schema';
import {
  FOLDERED_GRANT_KINDS, type FolderedGrantKind, type GrantFeedSlice,
} from '@tabs/agents/lib/grant-apply';
import { zeroMatchFolderGrantMessages, renderGrantWarning } from '@tabs/agents/lib/grant-messages';
import { useTranslations } from '@core/i18n/client';

type Feeds = Partial<Record<FolderedGrantKind, GrantFeedSlice>>;

/** One sentence per enabled folder grant that is known to match no item today. */
export function useEmptyGrants(systemId: string, system: System): string[] {
  const t = useTranslations('agents');
  // Which kinds need a feed, and a key that changes exactly when their folder grants do.
  const wanted = FOLDERED_GRANT_KINDS.filter((kind) =>
    system.grants[kind].some((g) => g.folder && g.capability !== 'Off' && g.capability !== 'Blocked'));
  const key = wanted
    .map((kind) => `${kind}=${system.grants[kind].filter((g) => g.folder).map((g) => `${g.folder!.scope}:${g.folder!.path}`).join(',')}`)
    .join('|');

  const kindsKey = wanted.join(',');

  const [loaded, setLoaded] = useState<{ key: string; feeds: Feeds }>({ key: '', feeds: {} });

  useEffect(() => {
    if (!kindsKey) return;
    let alive = true;
    const kinds = kindsKey.split(',') as FolderedGrantKind[];
    void Promise.all(kinds.map(async (kind): Promise<[FolderedGrantKind, GrantFeedSlice | null]> => {
      try {
        const res = await fetch(`/api/agents/systems/${systemId}/grants/available?kind=${kind}`, { cache: 'no-store' });
        const body = await res.json();
        return [kind, res.ok && Array.isArray(body?.items) ? (body as GrantFeedSlice) : null];
      } catch {
        return [kind, null]; // unknown — never reported as empty
      }
    })).then((pairs) => {
      if (!alive) return;
      const feeds: Feeds = {};
      for (const [kind, feed] of pairs) if (feed) feeds[kind] = feed;
      setLoaded({ key, feeds });
    });
    return () => { alive = false; };
  }, [systemId, kindsKey, key]);

  return useMemo(() => {
    if (!key || loaded.key !== key) return [];
    return FOLDERED_GRANT_KINDS.flatMap((kind) => {
      const feed = loaded.feeds[kind];
      if (!feed) return [];
      const translate = (k: string, args?: Record<string, string | number>) => t(k as Parameters<typeof t>[0], args);
      return zeroMatchFolderGrantMessages(system, kind, feed).map((msgs) => renderGrantWarning(msgs, translate));
    });
  }, [key, loaded, system, t]);
}
