/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const monitoring: TutorialDef = {
  key: 'monitoring',
  route: '/monitoring',
  title: 'Monitoring',
  tagline: 'Real 7-day health of your agents and datasets — one tile each, full diagnostics on click.',
  buttonLabel: 'Monitoring Tutorial',
  hook: {
    illustration: 'dashboard',
    title: 'The read plane',
    body: 'Monitoring shows the real last-7-day health of the agent systems and datasets you can access — one tile each. Open any tile for a full diagnosis window: run history and traces, cost and token trends, data-quality checks, build timeline, and lineage. Read-only by design: you watch here; you act in the tabs.',
  },
  steps: [
    {
      illustration: 'agent',
      title: 'Agent Monitoring tiles',
      body: 'Each agent system is one tile: a health dot, then its last-7-day cost, tokens, runs, and last-run time — with ⚠ warnings and ✗ errors called out when they exist. A quiet grid of green dots means nothing needs you.',
    },
    {
      illustration: 'metric',
      title: 'Data Monitoring tiles',
      body: 'Each dataset shows its freshness ("built 2d ago" or "not built"), its data quality — "✗ 3 DQ rules violated" in red, "✓ 5 DQ rules passing" in green — and its pipeline health. The exception is what shouts; healthy datasets stay quiet.',
    },
    {
      illustration: 'dashboard',
      title: 'Click a tile — the diagnosis window',
      body: 'A tile opens its big diagnosis window: 7-day stats and sparklines, errors and warnings, run history with links to the full traces — or, for a dataset, the data-quality dashboard, the medallion build timeline, version history, and lineage. Deep links jump you to the Agents or Data tab to act.',
    },
    {
      illustration: 'sandbox',
      title: 'Scoped to you',
      body: 'Both sections carry My · Domain · Company pills, the same scopes as everywhere else — you see what you can access, under your own identity and row-level security. Everything here is a read; there is nothing you can break.',
      byRole: {
        builder: {
          body: 'Both sections carry My · Domain · Company pills — switch to Domain to sweep everything your domain runs. Same identity and row-level security as everywhere else; failures and spend across the domain surface to you first.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.monitoring.sandbox,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Open the read plane',
      body: 'Everything on this tab is a read — no button here mutates anything. Explore as much as you like.',
    },
    {
      anchor: ANCHORS.monitoring.scope,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Pick your scope',
      body: 'The My · Domain · Company pills say whose world you are seeing, with a live count each. Start with My; widen when you need the fuller picture.',
    },
    {
      anchor: ANCHORS.monitoring.agents,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Read the agent tiles',
      body: 'Each tile: health dot, 7-day cost, tokens, runs, last run — ⚠ and ✗ only when something happened. Click one: the Agent diagnostics window shows trends, errors and warnings, and the run history, each run linking to its full trace.',
    },
    {
      anchor: ANCHORS.monitoring.data,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Read the data tiles',
      body: 'Freshness, DQ status, pipeline health per dataset. A red "✗ N DQ rules violated" badge is your cue — open the tile for the data-quality dashboard and lineage, then jump to the Data tab\'s Validate stage to fix the rule.',
    },
  ],
  sandbox: {
    lane: 'Your scope — read-only by design',
    anchor: ANCHORS.monitoring.sandbox,
    note: 'Monitoring never writes: every tile and diagnosis window is a read under your own identity. There is nothing you can break here.',
  },
  outro: {
    title: 'You know where to look first',
    body: 'Tiles first, diagnosis window on click, act in the tab it links to. Next, run an agent and watch its tile update here, or open a dataset\'s Validate stage and see its DQ rules feed these badges.',
    next: ['agents', 'data'],
    doc: 'monitoring-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Watch',
      hook: 'See what ran for you, what it cost, and whether it is healthy.',
    },
    creator: {
      verb: 'Diagnose',
      hook: 'Open a tile and follow your agents and datasets end to end when something looks off.',
    },
    builder: {
      verb: 'Oversee',
      hook: 'Sweep the domain — failures, violations, spend — and act where you govern.',
    },
  },
};

export default monitoring;
