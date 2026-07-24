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
  buttonLabel: 'Big Bets Tutorial',
  hook: {
    illustration: 'bet',
    title: 'Turn a goal into a delivery plan',
    body: 'Frame a high-value initiative as a problem worth solving, bundle the real components that deliver it across every tab, and watch each move from planned to completed on one dated roadmap.',
  },
  steps: [
    {
      illustration: 'bet',
      title: 'Frame the bet',
      body: 'Start a "New Big Bet": name the owner, write a sharp Problem Statement (who, the pain, the cost) and a Solution Idea, and pick its Strategic Pillar — every bet must sit under a pillar, which drives its tier (My · Domain · Company) and its value spine. Set a value target and a Planned Go-Live.',
    },
    {
      illustration: 'connect',
      title: 'Build the roadmap from real components',
      body: 'Reference the data products, models, dashboards, and agents that deliver the bet. Each lives in its own tab and passes its own gates; the bet links and tracks them, never copies.',
    },
    {
      illustration: 'governance',
      title: 'Track delivery live',
      body: 'The bet card reads itself from its components: "Completion · 3/5 components", the go-live date with a "date at risk" flag when the roadmap slips, and realized value against the target. No status meetings — the roadmap reports the truth.',
      byRole: {
        builder: {
          body: 'You own the bet: dates, dependencies, and the pillar link. Completion, at-risk flags, and realized value roll up live from the components — each still passes its own tab gates; the bet never shortcuts governance.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS['big-bets'].sandbox,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Open the Portfolio',
      body: 'The Portfolio lists every bet you can see, filtered by the All · My · Domain · Company pills. Bets under a My pillar are your private planning lane — draft freely.',
    },
    {
      anchor: ANCHORS['big-bets'].define,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Frame the bet',
      body: '"New Big Bet": name the owner, choose the Strategic Pillar (required — it drives the tier and the value spine), write the Problem Statement and Solution Idea, set the value target and Planned Go-Live, then "Create Big Bet".',
    },
    {
      anchor: ANCHORS['big-bets'].bundle,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Build the roadmap',
      body: 'Open the bet ("View details →") and build the roadmap from real components — data products, models, dashboards, agents — with planned-ready dates and dependencies.',
    },
    {
      anchor: ANCHORS['big-bets'].track,
      sandboxAnchor: ANCHORS['big-bets'].sandbox,
      route: '/big-bets',
      title: 'Track delivery',
      body: 'The card reads the truth live: "Completion · done/total components", the go-live date with its "date at risk" flag, and realized value against the target. When a component ships in its own tab, the bet updates itself.',
    },
  ],
  sandbox: {
    lane: 'My bets — personal planning lane',
    anchor: ANCHORS['big-bets'].sandbox,
    note: 'Bets under a My pillar stay yours: draft the problem, components, and roadmap privately. The pillar\'s tier decides who else sees the bet.',
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
      verb: 'Own & steer',
      hook: 'Own the bet under its pillar and track delivery as components ship.',
    },
  },
};

export default bigBets;
