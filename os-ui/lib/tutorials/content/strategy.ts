/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const strategy: TutorialDef = {
  key: 'strategy',
  route: '/strategy',
  title: 'Strategy',
  tagline: 'The few directions the company invests in — and what each is worth.',
  buttonLabel: 'Strategy Tutorial',
  hook: {
    illustration: 'metric',
    title: 'See how work ladders up to value',
    body: 'A strategic pillar is one of the few big directions the company bets on. Each pillar carries a value metric and the Big Bets that deliver it — so anyone can trace a single dashboard or agent all the way up to company value.',
    byRole: {
      builder: {
        body: 'A strategic pillar is one of the few big directions the company bets on. You define the pillars, link the Big Bets that deliver them, and keep each value metric honest — so every bet ladders up to a number that matters.',
      },
    },
  },
  steps: [
    {
      illustration: 'document',
      title: 'What a pillar is',
      body: 'A pillar names one strategic priority in business terms — Retention, New Markets, Operational Excellence. A company keeps only a few. Builders define domain pillars; Admins define company-wide ones; everyone reads them.',
    },
    {
      illustration: 'bet',
      title: 'Link the bets that deliver it',
      body: 'Each pillar lists the Big Bets that realize it. The bets stay in their own tab with their own roadmaps; the pillar links and reads them, never copies. That link is how day-to-day delivery ladders up to strategy.',
    },
    {
      illustration: 'metric',
      title: 'Give it a value metric',
      body: 'Every pillar carries one number that says what it is worth — Net Revenue Retention, cost saved, revenue added. Track it manually with a monthly entry, or wire it to a governed metric so the value flows in certified.',
      byRole: {
        builder: {
          body: 'Every pillar carries one number that says what it is worth. You choose how it is kept: a manual monthly entry to start, or a governed Cube metric once the data exists — same pillar, more trust.',
        },
      },
    },
    {
      illustration: 'dashboard',
      title: 'Read the rollup',
      body: 'The pillar shows its total value and each linked bet underneath — ready, in progress, planned. One glance answers the leadership question: what is this direction worth, and how close are we to it?',
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.strategy.sandbox,
      sandboxAnchor: ANCHORS.strategy.sandbox,
      route: '/strategy',
      title: 'Open the pillars board',
      body: 'The Strategy tab reads top-down: pillars first, side by side. Browsing is always safe — nothing here changes until someone with edit rights saves.',
    },
    {
      anchor: ANCHORS.strategy.rollup,
      sandboxAnchor: ANCHORS.strategy.sandbox,
      route: '/strategy',
      title: 'Read a pillar value',
      body: 'The big number is the pillar value, kept by its value metric. This is the number every linked bet is ultimately working toward.',
    },
    {
      anchor: ANCHORS.strategy.bets,
      sandboxAnchor: ANCHORS.strategy.sandbox,
      route: '/strategy',
      title: 'Trace the bets underneath',
      body: 'Each linked Big Bet shows its readiness — ready, in progress, planned. Open one to see the real components delivering it. This is the ladder from daily work to company value.',
    },
    {
      anchor: ANCHORS.strategy.value,
      sandboxAnchor: ANCHORS.strategy.sandbox,
      route: '/strategy',
      title: 'See how the value is kept',
      body: 'A value metric is either tracked manually (a monthly entry) or governed (it flows from a certified Cube metric). Governed is the goal; manual is the honest start.',
    },
    {
      anchor: ANCHORS.strategy.create,
      route: '/strategy',
      governedWrite: true,
      roles: ['builder'],
      title: 'Create a pillar',
      body: 'Name the priority in business terms, state its intent, and describe its value metric. Builders create domain pillars; Admins create company-wide ones. Then link the bets that deliver it.',
    },
  ],
  sandbox: {
    lane: 'The pillars board - read-only browsing',
    anchor: ANCHORS.strategy.sandbox,
    note: 'Browse pillars, values, and linked bets freely; nothing changes until a Builder or Admin edits for real.',
  },
  outro: {
    title: 'You can read the strategy at a glance',
    body: 'Pillars are how bets ladder up to company value: every dashboard, agent, and data product delivers a bet, and every bet delivers a pillar. Next, plan a Big Bet under a pillar, or define the governed metric that keeps its value honest.',
    next: ['big-bets', 'metrics'],
    doc: 'strategy-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Read',
      hook: 'See where the company is heading and what each direction is worth.',
    },
    creator: {
      verb: 'Follow',
      hook: 'Trace how your bets and artifacts ladder up to a pillar and its value.',
    },
    builder: {
      verb: 'Define & steer',
      hook: 'Define pillars, link the bets that deliver them, and keep the value honest.',
    },
  },
};

export default strategy;
