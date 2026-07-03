/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const agents: TutorialDef = {
  key: 'agents',
  route: '/agents',
  title: 'Agents',
  tagline: 'Build an AI agent that uses your data, knowledge, and connections — governed from the start.',
  buttonLabel: 'Build Agents Tutorial',

  hook: {
    illustration: 'agent',
    title: 'Your own governed AI agent',
    body: 'Write what the agent does, give it the tools it needs, test it live, and publish it. Every tool call is authorized, cost-capped, and fully traced.',
    byRole: {
      builder: {
        body: 'Define the behaviour, grant the right tools, set the cost cap — then certify and publish. Every call governed and traced from day one.',
      },
    },
  },

  steps: [
    {
      illustration: 'agent',
      title: 'Define the behaviour',
      body: "Start from a blueprint — RAG assistant, data analyst, workflow agent — or begin blank. Write the AGENT.md in plain language: the agent's role, purpose, and what it will and won't do.",
    },
    {
      illustration: 'connect',
      title: 'Give it tools',
      body: 'Pick which data products, knowledge bases, file collections, and connections the agent may use. Each selection writes an OPA policy — the agent can only call what you explicitly allow.',
    },
    {
      illustration: 'sandbox',
      title: 'Test it live',
      body: 'Chat with the agent in the preview pane. Watch the Langfuse trace — tools called, what they returned, what it cost. Iterate before going live.',
    },
    {
      illustration: 'publish',
      title: 'Publish and share',
      body: 'A Builder certifies it. The agent becomes an MCP tool other agents and apps can call. Set the visibility level and it can be listed in the Marketplace.',
      byRole: {
        builder: {
          body: "Review the AGENT.md, the tool grants, and the cost cap. Certify and publish — the agent becomes a governed MCP tool available to the domain.",
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.agents.sandbox,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Open your personal agent lane',
      body: 'Your drafts live here — private and ungoverned until you publish. A safe place to build and experiment.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.define,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Define the agent',
      body: "Pick a blueprint or start blank. Write the AGENT.md: the agent's role, purpose, tone, and the things it will and won't do.",
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.tools,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Grant tools',
      body: 'Select the data products, knowledge bases, connections, and other agents it may call. Each selection compiles to an OPA policy grant.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.run,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Test it',
      body: 'Chat in the preview pane. Inspect the trace: tools called, cost, sources cited. Adjust the AGENT.md or tool grants until the behaviour is right.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.tools,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Choose a runtime',
      body: 'Pick Structured (LangGraph) for step-by-step, human-in-the-loop pipelines — or Autonomous (Hermes) for long-running tasks that keep memory between sessions. Both runtimes use the same OPA-governed tool plane; neither can bypass your grants.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.publish,
      title: 'Publish the agent',
      body: 'A Builder reviews and publishes it. The agent becomes a governed MCP tool available to the domain and, optionally, the Marketplace.',
      governedWrite: true,
      roles: ['builder'],
      route: '/agents',
    },
  ],

  sandbox: {
    lane: 'Personal agent drafts',
    anchor: ANCHORS.agents.sandbox,
    note: 'Agent drafts are private to you and make no governed writes — build, test, and iterate here freely before a Builder publishes to the domain.',
  },

  outro: {
    title: 'Your agent is live and governed',
    body: 'You built an agent with a defined behaviour, real tools, and a full audit trail on every call. Next: give it richer context with knowledge, or wire it to more connections.',
    next: ['knowledge', 'connections'],
    doc: 'agent-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Chat with domain agents and use their outputs in your daily work.',
    },
    creator: {
      verb: 'Create',
      hook: 'Build agents that use your data, knowledge, and connections to do real work.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review agent definitions, tool grants, and cost caps — then certify and publish to the domain or Marketplace.',
    },
  },
};

export default agents;
