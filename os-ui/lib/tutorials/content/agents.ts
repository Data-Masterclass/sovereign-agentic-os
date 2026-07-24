/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const agents: TutorialDef = {
  key: 'agents',
  route: '/agents',
  title: 'Agents',
  tagline: 'Build a team of AI agents that uses your data, knowledge, and connections — governed from the start.',
  buttonLabel: 'Build Agents Tutorial',

  hook: {
    illustration: 'agent',
    title: 'Your own governed agent team',
    body: 'Five phases — Define, Design, Build, Run, Evaluate. Describe what your team should do in plain words, review the agents the OS builds, compile, run, and check the result against honest tests. Every tool call is authorized, cost-capped, and fully traced.',
    byRole: {
      builder: {
        body: 'Five phases — Define, Design, Build, Run, Evaluate. Describe the team, review its grants, compile, run, and evaluate — then promote it. Every call governed and traced from day one.',
      },
    },
  },

  steps: [
    {
      illustration: 'agent',
      title: 'Define — say what the team should do',
      body: 'Name your team and describe the job in plain words, including what a good result looks like — the OS builds the agents and wires them up. Set how it is triggered (Manual, On schedule, or Called from system), a safety preset from "Read-only" to "Full in-scope", and "Where the results go" — a declared File, Dataset, or Knowledge output.',
    },
    {
      illustration: 'connect',
      title: 'Design — review the team and its grants',
      body: 'Each card is one agent; the START agent goes first and hands work to the others. Under "What your team can use" you grant the resources every agent shares — Read-only, Read + propose, or Read + write per item. The matching tools are granted automatically; nothing outside the grants is callable.',
    },
    {
      illustration: 'build',
      title: 'Build — compile and verify',
      body: 'One click compiles your team through the real stack — scaffolding agents, provisioning tools and grants, wiring the graph, linking traces. Nothing runs yet; when the build is green, move on to Run.',
    },
    {
      illustration: 'sandbox',
      title: 'Run — watch it work',
      body: 'The team walks from the START agent and shows its progress and final result live. Prefer the full surface? The Simple ⇄ Developer toggle swaps the guided builder for the canvas, files, and grants — both edit the same files.',
    },
    {
      illustration: 'publish',
      title: 'Evaluate — then share it',
      body: 'Evaluate shows the "Context actually used", "Grants vs. usage", deterministic checks, and an optional AI judge — plus a downloadable PDF report. Happy? "Promote to Domain" shares the team; an Admin can "Certify to Company".',
      byRole: {
        builder: {
          body: 'Evaluate shows the "Context actually used", "Grants vs. usage", deterministic checks, and an optional AI judge. Review the grants and the eval before you promote — "Promote to Domain", then "Certify to Company" as Admin.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.agents.sandbox,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Open your agents',
      body: 'The scope buttons — All, My, Domain, Company — say whose agent systems you see. My Agents is your private lane: teams here are yours alone until a promotion is approved.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.define,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Define the team',
      body: 'Name your team, then describe what it should do in plain words — including what a good result looks like. The OS builds the agents and picks the right model for each; you review and adjust next. Set the trigger, the safety preset, and where the results go.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.tools,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Design the grants',
      body: 'Review the agent cards — START goes first — and grant "What your team can use": each dataset, knowledge item, or connection at Read-only, Read + propose, or Read + write. Every grant compiles to policy; the team can only call what you allow.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.run,
      sandboxAnchor: ANCHORS.agents.sandbox,
      title: 'Build, run, evaluate',
      body: 'Build compiles and verifies — when it is green, Run walks the team from the START agent and streams its progress. Then Evaluate: context actually used, grants vs. usage, deterministic checks, and the optional AI judge.',
      route: '/agents',
    },
    {
      anchor: ANCHORS.agents.publish,
      title: 'Promote the team',
      body: '"Promote to Domain" is the governed publish step — an approver confirms it in Governance, and the team becomes available to your domain. An Admin can "Certify to Company" for the whole organization.',
      governedWrite: true,
      route: '/agents',
    },
  ],

  sandbox: {
    lane: 'My Agents — personal drafts',
    anchor: ANCHORS.agents.sandbox,
    note: 'Teams in My Agents are private to you — define, design, build, run, and evaluate freely before anything is promoted to the domain.',
  },

  outro: {
    title: 'Your agent team is live and governed',
    body: 'You defined, designed, built, ran, and evaluated a team with real grants and a full audit trail on every call. Next: give it richer context with knowledge, or wire it to more connections.',
    next: ['knowledge', 'connections'],
    doc: 'agent-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Run domain agent teams and use their outputs in your daily work.',
    },
    creator: {
      verb: 'Create',
      hook: 'Build agent teams that use your data, knowledge, and connections to do real work.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review grants and evaluations, then promote agent teams to the domain or company.',
    },
  },
};

export default agents;
