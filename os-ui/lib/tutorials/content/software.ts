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
    body: 'Five stages — Define App · Design Epics · Create Context · Build App · Test & Publish. State a purpose, shape EPICs and user stories, resolve the governed context each story needs, then watch the build agent work live: the plan first, then one honest line per action, every commit landing in a sovereign in-cluster repo. Preview is yours alone; going live is a governed Builder review.',
    byRole: {
      builder: {
        body: 'Five stages — Define App · Design Epics · Create Context · Build App · Test & Publish. Your lane adds the gates: flip to the Developer view for the raw code panel, expand the raw tool I/O behind every activity line, and review deploy requests — security scan, granted resources, the diff — before anything goes live.',
      },
    },
  },

  steps: [
    {
      illustration: 'build',
      title: 'Define App — its purpose',
      body: '"Create new software app" needs only a name — a sovereign in-cluster Forgejo repo is provisioned, and the build agent infers UI/API from what it actually builds. State the purpose in a sentence or two and "Save purpose". Define App is complete once a purpose is set; the governed context the app may use is resolved next, in Create Context.',
    },
    {
      illustration: 'document',
      title: 'Design Epics — EPICs and user stories',
      body: 'Shape the work on the design board: "+ Add EPIC", each with technical, UX and governance requirements, then "+ Add story" beneath — as a role, I want a capability, so that a benefit — with an acceptance criterion. The Design assistant proposes both; Apply creates them. Ship the backlog outward too: "Push to Jira", "Push code to Git", or seed the frontend from a Claude design.',
    },
    {
      illustration: 'document',
      title: 'Create Context — resolve every data need',
      body: 'Every context need in one place. Bind the governed context the app may use — Connections, Data, Knowledge, Files, Metrics — at Read / Read+propose / Read+write, no raw credentials ever. For stories that need data with nothing bound, the assistant proposes datasets you can create empty (schema only) or with realistic sample rows, so the story is demoable. Data-needing stories can\'t build until this is resolved.',
    },
    {
      illustration: 'agent',
      title: 'Build App — watch the agent work, live',
      body: 'Build works off the spec. The left tree is Epics › Stories › Features/NFRs/Rules; tick the features to build next — ticking a story or EPIC cascades, capped at 8 per batch so each result is reliable. One Build button builds the selected set. Two distinct marks: a selection checkbox ("queue to build next") and a green done ✓ badge (already built — a status, not a toggle; done items stay in the tree). The right panel always shows the selected item\'s spec, and after a build ticks each item honestly against what shipped — pending if unverifiable, never fake-ticked. The run streams live (plan, then one line per action, ⚠ on failure); the build chat at the bottom is for feedback. Builders can "show details" for the raw tool I/O and open the code panel in the Developer view.',
    },
    {
      illustration: 'publish',
      title: 'Test & Publish — check it, then go live',
      body: 'One stage, both halves. Test: the status rail answers "where is this app?" at a glance (Repo · Preview · Deploy, never faking a state it can\'t see), "Provision preview" starts a private runner and "Open app UI ↗" opens the real app; the LLM tester reads the committed code and each built story\'s spec and reports PASS/FAIL per item — grounded, never fabricated. Publish: "Publish release" files a deploy review — approve it in Policies & Approvals. A Builder sees the security scan, the governed resources requested, its footprint and the change diff before anything ships; routine in-envelope updates ship automatically. Once live: call the app\'s governed MCP tools and climb the promotion ladder — My → Domain → Company. You can only reach this stage once at least one user story is actually built.',
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
      body: 'The list shows All · My · Domain · Company Software. "Create new software app" asks only for a name — "Create & build" scaffolds a sovereign Forgejo repo and drops you into the five-stage flow (Define App · Design Epics · Create Context · Build App · Test & Publish). Everything starts Personal.',
    },
    {
      anchor: ANCHORS.software.define,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Define the app',
      body: 'Write the purpose in your own words and "Save purpose" — Define App is complete once a purpose is set. The stage assistant can sharpen the purpose; you confirm every apply. The governed context the app may use is resolved next, in Create Context.',
    },
    {
      anchor: ANCHORS.software.design,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Design Epics — specify each story',
      body: 'Design Epics is the specification. Pick a user story in the tree, then give it three lists — Features (what it does), Non-functional requirements (how well), Rules (governance). The assistant can draft the spec grounded in your purpose; you Apply what it proposes. Add or edit EPICs & stories in the "Backlog & structure" board. Design Epics is complete once every story has a spec.',
    },
    {
      anchor: ANCHORS.software.context,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Create Context — resolve every data need',
      body: 'Resolve every context need in one place. Bind existing governed context (Connections, Data, Knowledge, Files, Metrics) at Read / Read+propose / Read+write — no raw credentials. For a story that needs data with nothing bound, the assistant proposes datasets you can create empty (schema only) or with realistic sample rows. A data-needing story can\'t build until its context is resolved.',
    },
    {
      anchor: ANCHORS.software.build,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Build in focused batches',
      body: 'The left tree is Epics › Stories › Features/NFRs/Rules. Tick the features to build next (ticking a story or EPIC cascades to its features) — up to 8 per batch so each result is reliable and reviewable; the counter shows "N / 8 selected". One Build button builds the selected set. The right panel always shows the selected item\'s spec and, after build, ticks each item honestly against what actually shipped (pending if unverifiable, never fake-ticked) — done items stay in the tree, green. The build chat at the bottom is for feedback and refinements; the status rail tracks Repo · Preview · Deploy throughout.',
    },
    {
      anchor: ANCHORS.software.publish,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      governedWrite: true,
      title: 'Test & Publish — check it, then request go-live',
      body: 'Test & Publish is one stage. Test: "Provision preview" asks the in-cluster runner for a private pod; "Open app UI ↗" appears once it serves the real app, calling the governed OS API as you. The LLM tester reads the committed code and each built story\'s spec and reports PASS/FAIL per item — grounded, never fabricated. No cluster reachable? "Acknowledge offline" says so honestly. Publish: "Publish release" files the deploy review — approve it in Policies & Approvals, where you see exactly what the Builder sees (the scan, the granted resources, the diff). Approved, the app goes live; then promote it — My → Domain → Company. This stage opens only once at least one user story is built.',
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
