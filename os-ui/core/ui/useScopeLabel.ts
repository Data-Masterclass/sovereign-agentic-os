/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The scope words (My · Domain · Company, promote / demote verbs) in the reader's language
 * USER STORY: As a user reading the OS in German I want "Meine Daten", "Auf Domäne hochstufen" and the other scope
 *             words everywhere a scope or a promotion is named, so the ladder reads the same in every tab.
 * ARCHITECTURE:
 *   - Renders the key-returning twins of `@core/kernel/scopes` (`scopeLabelMessage`, `visibilityLabelMessage`,
 *     `promoteVerbMessage`, `demoteVerbMessage`) from the `common.scope.*` catalog. The English helpers stay
 *     unchanged for MCP, tests and server code; their English equals the `en` catalog (scopes.test.ts proves it).
 *   - `kind` is passed through as ONE argument of a whole-phrase message ("My {kind}") — callers pass a noun that is
 *     already in the reader's language (e.g. their own `t('scopeKind')`), never an English word to concatenate.
 *   - `useCommonMessage()` renders any `{ key, args }` view-model message of the `common` namespace (lifecycle copy,
 *     stage rail, choose-context) — the one cast from a dynamic key to next-intl's typed key lives here.
 */
'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from '@core/i18n/client';
import {
  demoteVerbMessage,
  promoteVerbMessage,
  scopeLabelMessage,
  visibilityLabelMessage,
  type ScopeKey,
  type Visibility,
} from '@core/kernel/scopes';

/** A `common`-namespace message a pure module returns. */
export type CommonMessage = { key: string; args?: Record<string, string | number> };

/** Render a `common` message (or pass a plain string through unchanged). */
export function useCommonMessage(): (m: CommonMessage | string) => string {
  const t = useTranslations('common');
  return useCallback(
    (m: CommonMessage | string) => (typeof m === 'string' ? m : t(m.key as Parameters<typeof t>[0], m.args)),
    [t],
  );
}

/** The scope vocabulary, translated: `const s = useScopeLabel(); s.scope('mine', t('kind'))` → "Meine Daten". */
export function useScopeLabel() {
  const text = useCommonMessage();
  return useMemo(
    () => ({
      /** "All" / "My {kind}" / "Domain {kind}" / "Company {kind}". */
      scope: (key: ScopeKey, kind?: string) => text(scopeLabelMessage(key, kind)),
      /** The scope word of a stored visibility value (Personal → My, Shared → Domain, Certified → Company). */
      visibility: (visibility: Visibility, kind?: string) => text(visibilityLabelMessage(visibility, kind)),
      /** "Promote to Domain" / "Propose to Domain" / "Certify to Company". */
      promoteVerb: (fromVisibility: Visibility, opts: { propose?: boolean } = {}) =>
        text(promoteVerbMessage(fromVisibility, opts)),
      /** "Revoke from Company" / "Unshare"; '' at the bottom of the ladder. */
      demoteVerb: (fromVisibility: Visibility) => {
        const m = demoteVerbMessage(fromVisibility);
        return m ? text(m) : '';
      },
    }),
    [text],
  );
}
