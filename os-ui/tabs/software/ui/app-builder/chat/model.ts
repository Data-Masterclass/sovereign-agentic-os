/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - the Chat view's data: diff cards, unreviewed changes, story lights
 * USER STORY: As a business user I want the pending cards first, the ones that block going live marked, and my edits
 *             of a card sent with the version I edited so nobody's change is overwritten.
 * ARCHITECTURE:
 *   - Pure (a test cannot import a .tsx): the payload types of GET /api/apps/[id]/proposals and the small helpers the
 *     view renders with. The view imports these; nothing here fetches.
 */
import type { Classification, SpecProposal, StoryLight, StoryStatus } from '@tabs/software/lib/app-builder-contracts';

export type CardView = SpecProposal & { rev: string; needsRevert: boolean; touched: string[]; diffs?: { path: string; diff: string }[] };
export type LightView = { light: StoryLight; status: StoryStatus; criteria: { ref: string; state: 'pass' | 'fail' | 'untested' }[] };
export type ProposalsPayload = {
  appId: string;
  proposals: CardView[];
  unreviewed: string[];
  canDecide: boolean;
  lights: Record<string, LightView>;
  evidenceSha: string | null;
  truncated: boolean;
};

export const CLASSIFICATIONS: readonly Classification[] = ['refine-story', 'refine-epic', 'new-story', 'new-epic', 'code-change'];

/** Pending cards first (newest first), then the decided ones, newest first; at most `decided` decided cards. */
export function orderCards(cards: CardView[], decided = 10): { pending: CardView[]; decided: CardView[] } {
  const by = (a: CardView, b: CardView) => b.createdAt.localeCompare(a.createdAt);
  return {
    pending: cards.filter((c) => c.status === 'pending').sort(by),
    decided: cards.filter((c) => c.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)).slice(0, decided),
  };
}

/** The text a "create or update a story from this change" offer pre-fills (the card's own summary, never code). */
export function storylessPrefill(card: Pick<CardView, 'change' | 'commitShas'>): string {
  return card.change.summary.slice(0, 1000);
}

/** The body of an edit: the card's files with the edited contents, sent with the rev the editor loaded. */
export function editBody(card: Pick<CardView, 'rev' | 'change'>, contents: Record<string, string>): { decision: 'edit'; rev: string; change: SpecProposal['change'] } {
  return {
    decision: 'edit',
    rev: card.rev,
    change: { writes: card.change.writes.map((w) => ({ path: w.path, content: contents[w.path] ?? w.content })), deletes: [], summary: card.change.summary },
  };
}

/** Lights in story-id order for the summary list. */
export function lightRows(lights: Record<string, LightView>): { id: string; light: LightView }[] {
  return Object.entries(lights)
    .map(([id, light]) => ({ id, light }))
    .sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
}
