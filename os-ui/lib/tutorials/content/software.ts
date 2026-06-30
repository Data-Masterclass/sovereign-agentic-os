/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const software: TutorialDef = {
  key: 'software',
  route: '/software',
  title: 'Software',
  tagline: 'Build a governed web app by chat — it ships with a git repo, a review gate, and a free MCP connection.',

  hook: {
    illustration: 'build',
    title: 'Build an app by chatting',
    body: 'Describe what you want, iterate in a private preview, then a Builder reviews and deploys it. You get a git repo, a live URL, and an auto-generated MCP tool — all governed.',
    byRole: {
      builder: {
        body: 'Review the security scan, the resources requested, and the diff — then approve. The app goes live with a governed MCP connection already wired.',
      },
    },
  },

  steps: [
    {
      illustration: 'build',
      title: 'Describe what to build',
      body: 'Name your app, pick a template — web app, internal service, script, dashboard — and describe it in plain language. A Forgejo repo and app page are created instantly.',
    },
    {
      illustration: 'agent',
      title: 'Build it by chat',
      body: 'Talk to the build chat: "add a renewals table", "make the list sortable". The coding agent writes the code and commits it. Power users can also edit directly in the Monaco editor.',
    },
    {
      illustration: 'sandbox',
      title: 'Run a private preview',
      body: 'Spin up a private sandbox preview and try the app yourself. Iterate as much as you like — the preview is yours alone and never touches the domain.',
    },
    {
      illustration: 'publish',
      title: 'Pass the Builder review and go live',
      body: 'Request a deploy. A Builder sees the security scan, the resources requested, the cost estimate, and the diff — then approves. The app goes live and a free MCP connection appears in Connections.',
      byRole: {
        builder: {
          body: 'Open the review card: check the security scan, the connections and data products requested, the cost footprint, and the diff. Approve to deploy — the app goes live and its MCP connection is registered.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.software.sandbox,
      sandboxAnchor: ANCHORS.software.sandbox,
      title: 'Open your personal sandbox',
      body: 'Your apps start here — private previews, yours alone. Nothing is live until a Builder approves the deploy.',
      route: '/software',
    },
    {
      anchor: ANCHORS.software.describe,
      sandboxAnchor: ANCHORS.software.sandbox,
      title: 'Describe your app',
      body: 'Name it, pick a template, and describe it in plain language. A Forgejo repo and app page open immediately.',
      route: '/software',
    },
    {
      anchor: ANCHORS.software.build,
      sandboxAnchor: ANCHORS.software.sandbox,
      title: 'Build by chat',
      body: 'Type what you want next. The coding agent writes, commits, and updates your preview. Edit code directly in Monaco if you prefer.',
      route: '/software',
    },
    {
      anchor: ANCHORS.software.run,
      sandboxAnchor: ANCHORS.software.sandbox,
      title: 'Run the preview',
      body: 'Launch your private preview and click through the app. Iterate until it is right — the preview is yours alone and makes no governed writes.',
      route: '/software',
    },
    {
      anchor: ANCHORS.software.deploy,
      title: 'Request Builder review and deploy',
      body: 'Submit for deploy review. A Builder sees the scan, resources, cost, and diff — then approves. Your app goes live and its MCP connection appears in Connections.',
      governedWrite: true,
      roles: ['builder'],
      route: '/software',
    },
  ],

  sandbox: {
    lane: 'My apps — private preview',
    anchor: ANCHORS.software.sandbox,
    note: 'Private previews run only for you — no governed deploy, no shared access, and no side-effects outside your personal sandbox.',
  },

  outro: {
    title: 'Your app is live — with a governed MCP connection',
    body: 'You built, previewed, and shipped an app. It has a git repo, a live URL, and a free MCP tool ready for agents. Next: wire it to connections, or build an agent that calls it.',
    next: ['connections', 'agents'],
    doc: 'software-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Use apps your domain has built and published.',
    },
    creator: {
      verb: 'Create',
      hook: 'Build web apps and services by chat — no platform expertise needed.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review deploy requests — security scan, resource grants, cost, diff — and promote apps to the domain or Marketplace.',
    },
  },
};

export default software;
