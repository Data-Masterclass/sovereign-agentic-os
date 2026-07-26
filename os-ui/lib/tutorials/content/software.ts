/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const software: TutorialDef = {
  key: 'software',
  route: '/software',
  title: 'Software',
  tagline: 'Build a governed app by chat — watch the agent work live, preview privately, ship through a review gate.',
  buttonLabel: 'Ship Software Tutorial',

  hook: {
    illustration: 'build',
    title: 'Build software by chatting — governed end to end',
    body: 'Five stages — Define · Design · Build · Preview · Operate. State a purpose, shape EPICs and user stories, then watch the build agent work live: the plan first, then one honest line per action, every commit landing in a sovereign in-cluster repo. Preview is yours alone; going live is a governed Builder review.',
    byRole: {
      builder: {
        body: 'Five stages — Define · Design · Build · Preview · Operate. Your lane adds the gates: flip to the Developer view for the raw code panel, expand the raw tool I/O behind every activity line, and review deploy requests — security scan, granted resources, the diff — before anything goes live.',
      },
    },
  },

  steps: [
    {
      illustration: 'build',
      title: 'Define — purpose and granted context',
      body: '"Create new software app" needs only a name — a sovereign in-cluster Forgejo repo is provisioned, and the build agent infers UI/API from what it actually builds. State the purpose in a sentence or two and "Save purpose", then grant the governed context the app may use — Connections, Data, Knowledge, Files, Metrics — at Read / Read+propose / Read+write. No raw credentials, ever.',
    },
    {
      illustration: 'document',
      title: 'Design — EPICs and user stories',
      body: 'Shape the work on the design board: "+ Add EPIC", each with technical, UX and governance requirements, then "+ Add story" beneath — as a role, I want a capability, so that a benefit — with an acceptance criterion. The Design assistant proposes both; Apply creates them. Ship the backlog outward too: "Push to Jira", "Push code to Git", or seed the frontend from a Claude design.',
    },
    {
      illustration: 'agent',
      title: 'Build — watch the agent work, live',
      body: 'Select a node in the "Epics & stories" tree on the left — "General — the whole app", an EPIC, or a story — and the four scope actions appear above the chat: Design · Build · Test · Review. Design refines the selection in Plan mode, Build commits real code for it, Test critically checks the committed code story-by-story, Review summarizes what shipped and proposes ideas. Story chips walk to do → building → done, with an honest blocked when a run fails. The run streams as it happens: the plan first, then one line per action — "Committed 3 files", "Provisioning preview…" — with failures as honest ⚠ warnings. Builders can "show details" for the raw tool I/O; the committed diff lands under "Changes this run", and the code panel is one click away in the Developer view.',
    },
    {
      illustration: 'sandbox',
      title: 'Preview — your private running app',
      body: 'The persistent status rail answers "where is this app?" at a glance: Repo · Preview (none → provisioning → live) · Deploy (none → in-review → live) — never faking a state it can\'t see. "Provision preview" starts a private runner; "Open app UI ↗" appears once the pod is ready, and the pipeline — Scaffold repo, Build image (CI), Publish to registry, Deploy, Live / health — shows exactly where it stands.',
    },
    {
      illustration: 'publish',
      title: 'Operate — a governed go-live',
      body: '"Publish release" files a deploy review — approve it in Policies & Approvals. A Builder sees the security scan, the governed resources requested, its footprint and the change diff before anything ships; routine in-envelope updates ship automatically. Once live: call the app\'s governed MCP tools and climb the promotion ladder — My → Domain → Company.',
      byRole: {
        builder: {
          body: 'Open Deploy reviews: the security scan, the governed resources requested, the footprint, and the change diff — then decide. Approval takes the release live; the app\'s capabilities become governed MCP tools that run AS the caller, OPA-checked and audit-traced.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.software.sandbox,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Start from your software',
      body: 'The list shows All · My · Domain · Company Software. "Create new software app" asks only for a name — "Create & build" scaffolds a sovereign Forgejo repo and drops you into the five-stage flow. Everything starts Personal.',
    },
    {
      anchor: ANCHORS.software.define,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Define it',
      body: 'Write the purpose in your own words and "Save purpose" — Define is complete once a purpose is set. Then grant governed context (Connections, Data, Knowledge, Files, Metrics) at Read / Read+propose / Read+write. The stage assistant can sharpen the purpose and suggest grants; you confirm every apply.',
    },
    {
      anchor: ANCHORS.software.design,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Design the backlog',
      body: '"+ Add EPIC", fill its technical / ux / governance requirements, and "+ Add story" with acceptance criteria — then "Save design". Or ask the assistant to "Suggest EPICs for this app" and Apply what it proposes.',
    },
    {
      anchor: ANCHORS.software.build,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Build with the live feed',
      body: 'Select "General — the whole app", an EPIC, or a story in the "Epics & stories" tree on the left, then act on it with the buttons above the chat: Design · Build · Test · Review. Or keep the toggle on Build (Plan discusses without touching code) and describe the change yourself. Watch the activity feed: plan, then one line per action, warnings when something fails, the diff when it commits — and the story\'s chip turn done. The status rail above tracks Repo · Preview · Deploy the whole time.',
    },
    {
      anchor: ANCHORS.software.preview,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Run the private preview',
      body: '"Provision preview" asks the in-cluster runner for a private pod; "Open app UI ↗" appears once it serves, with the live-data preview calling the governed OS API as you. No cluster reachable? "Acknowledge offline" says so honestly and lets you continue.',
    },
    {
      anchor: ANCHORS.software.operate,
      route: '/software',
      governedWrite: true,
      title: 'Request the go-live',
      body: '"Publish release" files the deploy review — approve it in Policies & Approvals. You can see exactly what the Builder sees while it waits: the scan, the granted resources, the diff. Approved, the app goes live; then promote it — My → Domain → Company.',
    },
  ],

  sandbox: {
    lane: 'My Software — private apps and previews',
    anchor: ANCHORS.software.sandbox,
    note: 'Apps start Personal: build, commit, and preview privately in your own sovereign repo. Nothing reaches the domain until a deploy review is approved.',
  },

  outro: {
    title: 'Your app shipped through a governed gate',
    body: 'You defined, designed, built with a live agent, previewed privately, and requested a governed go-live. Next: build an agent that calls your app\'s governed MCP tools, or open Governance to see how deploy reviews are decided.',
    next: ['agents', 'governance'],
    doc: 'software-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Open the apps your domain shipped — every one passed a governed review.',
    },
    creator: {
      verb: 'Create',
      hook: 'Describe it in chat and watch the agent build it, action by action, in your own governed repo.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review deploy requests — scan, resources, diff — approve go-lives, and promote apps up the ladder.',
    },
  },
};

export default software;
