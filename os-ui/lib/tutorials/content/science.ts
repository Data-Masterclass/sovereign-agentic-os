/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const science: TutorialDef = {
  key: 'science',
  route: '/science',
  title: 'Science',
  tagline: 'Turn a data product into a deployed, governed model.',
  hook: {
    illustration: 'model',
    title: 'Ship a model your whole stack can trust',
    body: 'Start from a governed data product, train and compare a few attempts, then deploy one model your apps call as a REST predict and your agents call as an MCP tool. Same governance, two front doors.',
  },
  steps: [
    {
      illustration: 'build',
      title: 'Build features',
      body: 'Define reusable signals like 90-day recency or order frequency on your data product. No raw credentials. The platform stores them as a governed feature set you can reuse.',
    },
    {
      illustration: 'model',
      title: 'Train and track',
      body: 'Train a model and compare attempts side by side. Every run logs its parameters, metrics, and artifacts, so the best one is easy to spot.',
    },
    {
      illustration: 'document',
      title: 'Register the best run',
      body: 'Pick the winning run and register it as a model version. Compare versions and see exactly how each was built.',
    },
    {
      illustration: 'publish',
      title: 'Certify and deploy',
      body: 'A Builder reviews the metrics and lineage, certifies, and approves go-live. The model deploys once and is instantly callable as a governed API and MCP tool.',
      byRole: {
        builder: {
          body: 'You review the metrics and lineage, certify, and approve go-live to Production. Promotion automatically widens who can call the predict API and tool.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.science.sandbox,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Open your practice lane',
      body: 'Start in your personal Science workbench. Nothing here touches governed models, so you can click freely.',
    },
    {
      anchor: ANCHORS.science.features,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Build a feature set',
      body: 'Add a couple of reusable features on the sample data product. These become a governed feature set you can train on.',
    },
    {
      anchor: ANCHORS.science.train,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Train and compare',
      body: 'Kick off a training run, then compare attempts by their metrics. The platform tracks every run for you.',
    },
    {
      anchor: ANCHORS.science.register,
      route: '/science',
      governedWrite: true,
      title: 'Register the best version',
      body: 'Register the winning run as a model version so it can be reviewed and promoted.',
    },
    {
      anchor: ANCHORS.science.deploy,
      route: '/science',
      governedWrite: true,
      roles: ['builder'],
      title: 'Certify and go live',
      body: 'Review the metrics and lineage, certify, and approve go-live. The deployed model is callable as a governed API and MCP tool at its visibility tier.',
    },
  ],
  sandbox: {
    lane: 'My models - personal Science workbench',
    anchor: ANCHORS.science.sandbox,
    note: 'Practice on the sample data product; nothing trains, registers, or deploys against governed artifacts.',
  },
  outro: {
    title: 'You shipped a model',
    body: 'Your model now serves predictions through one governed endpoint, with the same controls as every other artifact. Next, feed it the right data, or wire it into an agent.',
    next: ['data', 'agents'],
    doc: 'science-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Call a trusted model and run its predict from your apps and agents.',
    },
    creator: {
      verb: 'Create',
      hook: 'Turn a data product into a trained, tracked model.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review the metrics and lineage, then certify go-live to Production.',
    },
  },
};

export default science;
