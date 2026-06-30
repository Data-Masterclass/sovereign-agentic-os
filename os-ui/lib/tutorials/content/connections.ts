/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const connections: TutorialDef = {
  key: 'connections',
  route: '/connections',
  title: 'Connections',
  tagline: 'Connect the outside world — safely, with least-privilege and a full audit trail.',

  hook: {
    illustration: 'connect',
    title: 'The governed bridge to outside systems',
    body: 'Connect a Google Drive, a database, or any API. The secret never leaves Secrets Manager; agents get a governed tool, never a raw token.',
    byRole: {
      builder: {
        body: 'Connect external systems, set the capability profile, and promote connections to the domain — credentials stay locked; agents get governed tools.',
      },
    },
  },

  steps: [
    {
      illustration: 'connect',
      title: 'Add a connection',
      body: 'Pick the type — cloud drive, database, REST API, MCP server — and authenticate. Use per-user OAuth for your own accounts; service credentials for shared domain connections.',
    },
    {
      illustration: 'governance',
      title: 'Set the capability profile',
      body: 'Every operation starts off. Turn on only what you need: reads auto-approve, writes require inline approval or bounded limits. The profile compiles to a policy — agents see only what you switch on.',
    },
    {
      illustration: 'sandbox',
      title: 'Test it inline',
      body: 'Hit Test before saving. A green tick means the credentials work and the endpoint is reachable. Nothing runs in the domain until it passes.',
    },
    {
      illustration: 'publish',
      title: 'Share or list in the Marketplace',
      body: 'A Builder promotes a personal connection to domain-shared. An Admin can list it in the Marketplace as a template — consumers bring their own credentials; the secret stays with the owner.',
      byRole: {
        builder: {
          body: 'Review the capability profile, confirm least-privilege is right, and promote to domain-shared or submit to Admin for Marketplace listing.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.connections.sandbox,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Open your personal connections lane',
      body: 'Personal connections are private to you. Practice here without touching any shared domain connections.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.add,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Add a connection',
      body: 'Pick the type and authenticate. The credential goes straight to Secrets Manager — it never appears in the UI or logs.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.configure,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Configure the capability profile',
      body: 'Set each operation to Off, Read, Write-approval, Write-bounded, or Blocked. Anything left Off stays invisible to agents.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.test,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Test the connection',
      body: 'Run the inline test. A green tick means it is live and reachable. Fix any errors here before sharing.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.govern,
      title: 'Promote to shared or Marketplace',
      body: 'A Builder promotes it to the domain. An Admin publishes it to the Marketplace as a template — consumers supply their own credentials; no secret leaves the owner.',
      governedWrite: true,
      roles: ['builder'],
      route: '/connections',
    },
  ],

  sandbox: {
    lane: 'My connections — personal',
    anchor: ANCHORS.connections.sandbox,
    note: 'Personal connections are private to you and cannot be used by the domain until a Builder explicitly promotes them to shared.',
  },

  outro: {
    title: 'Your connection is live and governed',
    body: 'You created a governed bridge with least-privilege settings and a full audit trail on every call. Next: attach it to an agent, or use it as a data source.',
    next: ['agents', 'software'],
    doc: 'connections-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Use approved connections in your agents and apps — credentials are handled for you.',
    },
    creator: {
      verb: 'Create',
      hook: 'Add and configure connections for your personal work and your agents.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review connection capability profiles and promote them to domain-shared or the Marketplace.',
    },
  },
};

export default connections;
