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
  buttonLabel: 'Connections Tutorial',

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
      body: 'Browse the "Supported connectors" gallery — grouped by vendor, searchable by name — and "Connect →", or use "＋ New connector" for a custom REST/GraphQL API or MCP server. Credentials go straight to Secrets Manager, never echoed.',
    },
    {
      illustration: 'governance',
      title: 'Set the capability profile',
      body: 'Open "Capabilities" and set a mode per tool — Read, Write-bounded, Write-approval, or Blocked — then "Save capability profile". The profile compiles to a policy: agents see only what you allow, and approval-mode writes wait for a human.',
    },
    {
      illustration: 'sandbox',
      title: 'Test it inline',
      body: 'Hit "Test" on the connection, or "Try" a single tool from the capability table. A green tick means the credentials work and the endpoint is reachable. Nothing runs in the domain until it passes.',
    },
    {
      illustration: 'publish',
      title: 'Share it up the ladder',
      body: '"Promote to Domain" shares a personal connection with your domain; an Admin can "Certify to Company" as a template — consumers bring their own credentials; the secret stays with the owner.',
      byRole: {
        builder: {
          body: 'Review the capability profile, confirm least-privilege is right, then "Promote to Domain" — or hand to an Admin to "Certify to Company". The secret never travels with the promotion.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.connections.sandbox,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Open My connections',
      body: 'The scope buttons — All, My, Domain, Company — say whose connections you see. My connections are private to you; practice here without touching anything shared.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.add,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Add a connection',
      body: 'Search the Supported connectors by name or vendor and "Connect →" — or "＋ New connector" for a custom API or MCP server. The credential goes straight to Secrets Manager; it never appears in the UI or logs.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.configure,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Configure the capability profile',
      body: 'Open "Capabilities" and set each tool to Read, Write-bounded, Write-approval, or Blocked, then "Save capability profile". Anything blocked stays invisible to agents.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.test,
      sandboxAnchor: ANCHORS.connections.sandbox,
      title: 'Test the connection',
      body: 'Run "Test" — or "Try" a single tool from the capability table. A green tick means it is live and reachable. Fix any errors here before sharing.',
      route: '/connections',
    },
    {
      anchor: ANCHORS.connections.govern,
      title: 'Promote it',
      body: '"Promote to Domain" shares it with your domain once approved; an Admin can "Certify to Company" as a template — consumers supply their own credentials; no secret leaves the owner.',
      governedWrite: true,
      route: '/connections',
    },
  ],

  sandbox: {
    lane: 'My connections',
    anchor: ANCHORS.connections.sandbox,
    note: 'My connections are private to you and cannot be used by the domain until a promotion is approved.',
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
      hook: 'Review connection capability profiles and promote them to Domain or Company.',
    },
  },
};

export default connections;
