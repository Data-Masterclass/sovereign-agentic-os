/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The TWO badges — lifecycle and audience — and nothing else new on screen
 * USER STORY: As a user looking at a wall of tiles I want to tell, at a glance, which of them
 *             the company actually runs and which are somebody's experiment, without learning a
 *             new vocabulary per tab.
 * ARCHITECTURE:
 *   - A `.ts` sibling of the two `.tsx` badges, because a test cannot import a `.tsx`: the
 *     words, the CSS classes and the tooltips live here and the components only render them.
 *   - Reuses the existing `.badge` skin and adds three lifecycle classes (`lc-draft`,
 *     `lc-testing`, `lc-live`) rather than inventing a second badge skin.
 *   - Exactly three lifecycle words and three audience words. A fourth noun here would fail the
 *     simplicity contract, and `badges.test.ts` asserts the closed sets.
 */

import {
  LIFECYCLE_LABELS,
  AUDIENCE_LABELS,
  audienceOfTier,
  lifecycleWordOf,
  hasUnpublishedEdits,
  shortRef,
  type AudienceWord,
  type Lifecycle,
  type LifecycleWord,
} from '@core/kernel/object-lifecycle';

/** The badge CSS class per lifecycle word (defined at the end of tokens-base.css). */
export const LIFECYCLE_BADGE_CLASS: Record<LifecycleWord, string> = {
  draft: 'lc-draft',
  testing: 'lc-testing',
  live: 'lc-live',
};

/** The badge CSS class per audience word — the existing visibility skin, unchanged. */
export const AUDIENCE_BADGE_CLASS: Record<AudienceWord, string> = {
  my: 'vis-personal',
  domain: 'vis-shared',
  company: 'vis-certified',
};

/** What each lifecycle badge means, as a title attribute. Plain, and never a fourth noun. */
export const LIFECYCLE_BADGE_TITLE: Record<LifecycleWord, string> = {
  draft: 'Being built. Not running — go live to make a version the one the OS runs.',
  testing: 'A draft being tried out right now from Studio.',
  live: 'The OS runs this version. Editing it does not change what Run shows.',
};

export const AUDIENCE_BADGE_TITLE: Record<AudienceWord, string> = {
  my: 'Yours. Promote it to Domain when colleagues should use it as an official artefact.',
  domain: 'Shared with your domain as an official artefact.',
  company: 'Certified across the company.',
};

export type BadgeView = { label: string; className: string; title: string };

/** The lifecycle badge for one object. */
export function lifecycleBadge(l: Lifecycle): BadgeView {
  const word = lifecycleWordOf(l);
  const edits = hasUnpublishedEdits(l) ? ` Your draft has moved on from ${shortRef(l.live ?? '')}.` : '';
  return {
    label: LIFECYCLE_LABELS[word],
    className: `badge ${LIFECYCLE_BADGE_CLASS[word]}`,
    title: `${LIFECYCLE_BADGE_TITLE[word]}${edits}`,
  };
}

/** The audience badge for one object, from whatever its tab calls its tier. */
export function audienceBadge(tier: string): BadgeView {
  const word = audienceOfTier(tier);
  return {
    label: AUDIENCE_LABELS[word],
    className: `badge ${AUDIENCE_BADGE_CLASS[word]}`,
    title: AUDIENCE_BADGE_TITLE[word],
  };
}

/** Both badges, in the order a tile renders them: what runs first, who may use it second. */
export function tileBadges(l: Lifecycle, tier: string): BadgeView[] {
  return [lifecycleBadge(l), audienceBadge(tier)];
}
