/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const bigBets: TutorialDef = {
  key: 'big-bets',
  route: '/big-bets',
  title: 'Big Bets',
  tagline: 'Plan a high-value initiative over the real components that deliver it.',
  hook: {
    illustration: 'bet',
    title: 'Turn a goal into a delivery plan',
    body: 'Frame a high-value initiative as a problem worth solving, bundle the real components that deliver it across every tab, and watch each move from planned to completed on one dated roadmap.',
  },
  steps: [
    {
      illustration: 'bet',
      title: 'Frame the bet',
      body: 'Write a clear problem statement (who, the pain, the cost) and link it to a Strategy pillar and its business metric, so the bet is anchored to a real why.',
    },
    {
      illustration: 'connect',
      title: 'Bundle the components',
      body: 'Reference the data products, models, dashboards, and agents that deliver the bet. Each lives in its own tab; the bet links and tracks them, never copies.',
    },
    {
      illustration: 'governance',
      title: 'Plan and track',
      body: 'Set planned-ready dates and dependencies on a roadmap. Status is read live from each artifact, and a Builder commits the bet so the domain can follow progress.',
      byRole: {
        builder: {
          body: 'You own the bet: set dates and dependencies, then commit it for the domain. Each component still passes its own tab gates; the bet never shortcuts governance.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS['big-bets'].sandbox,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Open your draft lane',
      body: 'Start in your personal Big Bets lane. Draft a plan here without committing anything to the domain.',
    },
    {
      anchor: ANCHORS['big-bets'].define,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Frame the bet',
      body: 'Write the problem statement and link it to a Strategy pillar and its business metric.',
    },
    {
      anchor: ANCHORS['big-bets'].bundle,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Bundle the components',
      body: 'Reference the data products, models, dashboards, and agents that deliver the bet, and set their planned-ready dates and dependencies.',
    },
    {
      anchor: ANCHORS['big-bets'].track,
      route: '/big-bets',
      governedWrite: true,
      roles: ['builder'],
      title: 'Commit and track',
      body: 'Commit the bet so the domain can follow it. Status rolls up live from each component, with on-track and at-risk signals.',
    },
  ],
  sandbox: {
    lane: 'My bets - personal planning lane',
    anchor: ANCHORS['big-bets'].sandbox,
    note: 'Draft the plan, components, and roadmap privately; nothing is committed to the domain until you graduate.',
  },
  outro: {
    title: 'Your bet is on the board',
    body: 'The roadmap now tracks real components as they ship, with value attributed top-down. Next, chart its progress on a dashboard, or reuse certified parts from the Marketplace.',
    next: ['dashboards', 'marketplace'],
    doc: 'big-bets-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Follow an initiative and see what is done, in flight, or late.',
    },
    creator: {
      verb: 'Define',
      hook: 'Draft a bet, frame the problem, and bundle its components.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Own the bet, commit it to the domain, and track delivery.',
    },
  },
};

export default bigBets;
