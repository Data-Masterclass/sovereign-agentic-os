/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const metrics: TutorialDef = {
  key: 'metrics',
  route: '/metrics',
  title: 'Metrics',
  tagline: 'Define a KPI once; everyone reads the same number.',
  hook: {
    illustration: 'metric',
    title: 'Define a KPI everyone agrees on',
    body: 'Create a metric like Revenue once, on top of your modelled data. Dashboards chart it and agents resolve it from the same definition, so the numbers always match.',
  },
  steps: [
    {
      illustration: 'metric',
      title: 'Define the metric',
      body: 'Pick a column and an aggregation (Revenue = sum of net amount) and choose the dimensions to slice by. Use a friendly form, the metrics agent, or Cube YAML. All the same metric.',
    },
    {
      illustration: 'dashboard',
      title: 'Preview the number',
      body: 'See the result instantly, sliced by region or month, with no SQL. Group related metrics into a curated view.',
    },
    {
      illustration: 'publish',
      title: 'Promote and certify',
      body: 'Add documentation, pass the consistency check, and a Builder promotes it to the domain. Now dashboards and agents can reuse the exact same definition.',
      byRole: {
        builder: {
          body: 'You check the documentation and consistency, then promote the metric to the domain (Admin certifies to the Marketplace). The same definition then resolves everywhere.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.metrics.sandbox,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Open your practice lane',
      body: 'Start in your personal metrics lane. Drafts here are yours alone, so experiment freely.',
    },
    {
      anchor: ANCHORS.metrics.define,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Define a metric',
      body: 'On the sample cube, pick a column and an aggregation and choose a few dimensions to slice by.',
    },
    {
      anchor: ANCHORS.metrics.preview,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Preview the number',
      body: 'Slice the metric by region or month and watch the number update, with no SQL.',
    },
    {
      anchor: ANCHORS.metrics.publish,
      route: '/metrics',
      governedWrite: true,
      roles: ['builder'],
      title: 'Promote and certify',
      body: 'Review the documentation and consistency check, then promote the metric so dashboards and agents can reuse it.',
    },
  ],
  sandbox: {
    lane: 'My metrics - personal definitions lane',
    anchor: ANCHORS.metrics.sandbox,
    note: 'Draft and preview metrics on sample cubes; nothing is promoted or certified until you graduate.',
  },
  outro: {
    title: 'Your KPI is live',
    body: 'One trusted definition now powers your charts and your agents alike. Next, chart it on a dashboard, or model more data to measure.',
    next: ['dashboards', 'data'],
    doc: 'metrics-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Explore governed KPIs and slice them with no SQL.',
    },
    creator: {
      verb: 'Define',
      hook: 'Define a measure on a cube and preview the number.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Check the docs and consistency, then promote the metric to the domain.',
    },
  },
};

export default metrics;
