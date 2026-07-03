/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const dashboards: TutorialDef = {
  key: 'dashboards',
  route: '/dashboards',
  title: 'Dashboards',
  tagline: 'Build governed BI that never disagrees with your agents.',
  buttonLabel: 'Dashboards Tutorial',
  hook: {
    illustration: 'dashboard',
    title: 'Build a dashboard that never disagrees',
    body: 'Assemble charts on governed metrics, by drag and drop or by asking the dashboard agent. Every chart resolves the same metric your agents use, so the BI layer and the agents never disagree.',
  },
  steps: [
    {
      illustration: 'metric',
      title: 'Pick your metrics',
      body: 'Open the metric explorer and choose a metric to chart, sliced however you like. No SQL, and each viewer sees only their entitled rows.',
    },
    {
      illustration: 'dashboard',
      title: 'Compose the dashboard',
      body: 'Drag charts in, or ask the dashboard agent to assemble a Sales Overview. Both edit the same dashboard.',
    },
    {
      illustration: 'publish',
      title: 'Share it safely',
      body: 'A Builder promotes it to the domain and an Admin can list it in the Marketplace. Embed it anywhere and it stays scoped to each viewer.',
      byRole: {
        builder: {
          body: 'You review the dashboard and promote it to the domain (Admin certifies to the Marketplace). Embeds and shared links stay row-level scoped to each viewer.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.dashboards.sandbox,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Open your practice lane',
      body: 'Start in your personal dashboards lane. Anything you build here is yours alone until you share it.',
    },
    {
      anchor: ANCHORS.dashboards.pick,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Pick a metric',
      body: 'Open the explorer and choose a governed metric to chart, sliced how you like. No SQL needed.',
    },
    {
      anchor: ANCHORS.dashboards.compose,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Compose the dashboard',
      body: 'Drag charts onto the canvas, or ask the dashboard agent to assemble a Sales Overview for you.',
    },
    {
      anchor: ANCHORS.dashboards.share,
      route: '/dashboards',
      governedWrite: true,
      roles: ['builder'],
      title: 'Share it',
      body: 'Review the dashboard and promote it to the domain. It stays row-level scoped to each viewer wherever it is embedded.',
    },
  ],
  sandbox: {
    lane: 'My dashboards - personal canvas',
    anchor: ANCHORS.dashboards.sandbox,
    note: 'Build and rearrange on sample metrics; nothing is shared, promoted, or embedded until you graduate.',
  },
  outro: {
    title: 'Your dashboard is ready',
    body: 'It reads the same governed metrics your agents do, so numbers match everywhere. Next, define more metrics to chart, or roll it into a Big Bet.',
    next: ['metrics', 'big-bets'],
    doc: 'dashboards-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Open governed dashboards and see your own entitled rows.',
    },
    creator: {
      verb: 'Create',
      hook: 'Compose charts on governed metrics, by hand or with the agent.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review the dashboard, then promote it to the domain to share.',
    },
  },
};

export default dashboards;
