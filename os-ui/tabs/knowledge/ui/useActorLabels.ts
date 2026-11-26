/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    Actor category and link type labels in the user's language
 * USER STORY: As a German-speaking process owner I see "Mensch", "Software", "Kunde" for the actor
 *             categories and lanes, while the stored category (`Human`, `Customer`, …) stays as it is.
 * ARCHITECTURE:
 *   - The category is a closed enum persisted in workflow.md (`schema.ts` → `ACTOR_TYPES`); only its
 *     LABEL is translated, from `knowledge.actorType.*`. An unknown value (a hand-edited file) shows
 *     verbatim rather than a blank.
 *   - One hook for every knowledge component that names a category, so the "(external)" suffix and
 *     the link-type badge read the same everywhere.
 */
import { useTranslations } from '@core/i18n/client';
import { ACTOR_TYPES, EXTERNAL_ACTORS, type ActorType, type LinkType } from '@tabs/knowledge/lib/schema';

const LINK_TYPES: readonly LinkType[] = ['data', 'app', 'agent', 'file'];

export function useActorLabels() {
  const t = useTranslations('knowledge');
  const category = (c: string): string =>
    (ACTOR_TYPES as string[]).includes(c) ? t(`actorType.${c as ActorType}`) : c;
  /** A category as a select option: "Customer (external)". */
  const categoryOption = (c: ActorType): string =>
    EXTERNAL_ACTORS.includes(c) ? t('categoryExternal', { category: category(c) }) : category(c);
  const linkType = (l: string): string =>
    (LINK_TYPES as readonly string[]).includes(l) ? t(`linkType.${l as LinkType}`) : l;
  return { category, categoryOption, linkType };
}
