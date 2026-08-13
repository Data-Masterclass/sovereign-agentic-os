/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const software: TutorialDef = {
  key: 'software',
  route: '/software',
  title: 'Software',
  tagline: 'Compose a governed app from cookbook patterns over your data — no code, live the moment it validates.',
  buttonLabel: 'Ship Software Tutorial',

  hook: {
    illustration: 'build',
    title: 'Compose a governed app — no code, no build, no pod',
    body: 'An app here is a governed declarative specification, not a coding project: a set of tabs, each a beautiful cookbook pattern filled with your governed data, rendered same-origin by the trusted OS renderer. Five stages — Define App · Design Epics · Choose Context · Build App · Test & Publish. Build App auto-generates the whole app from your epics and granted data; you refine it by chatting ("make Orders a kanban by status") and it applies the change directly, schema-validated. It is live the moment its spec validates — no repo, no CI, no container.',
    byRole: {
      builder: {
        body: 'Five stages — Define App · Design Epics · Choose Context · Build App · Test & Publish. Your lane adds Advanced settings (the app theme CSS + the sandboxed custom HTML/CSS/JS block) and the promotion gates — Publish promotes the draft to a new live version, and you climb My → Domain → Company.',
      },
    },
  },

  steps: [
    {
      illustration: 'build',
      title: 'Define App — its purpose',
      body: '"New app" creates a declarative app directly — no chooser, no code. Give it a name and state the purpose in a sentence or two. Define App is complete once a purpose is set; the governed context the app may use is resolved next, in Choose Context. (The historic coded path is an advanced, platform-admin-only option — off by default.)',
    },
    {
      illustration: 'document',
      title: 'Design Epics — EPICs and user stories',
      body: 'Shape the work on the design board: "+ Add EPIC", then "+ Add story" beneath — as a role, I want a capability, so that a benefit. The Design assistant proposes both; Apply creates them. These epics and stories are the brief Build App reads to auto-generate your tabs, and each tab links back to the story it serves.',
    },
    {
      illustration: 'document',
      title: 'Choose Context — grant the six types',
      body: 'Bind the governed context the app may use — Data · Metrics · Files · Knowledge · Agents · Connections — by reference, never raw credentials. Per type: "use existing" (pick governed artifacts you\'re entitled to and grant them) or "create new" (a fresh, possibly-empty dataset/file/knowledge is created in an "App «Name»" folder, granted, and ready to fill). Intelligence enters only as a granted agent; connections are mediated, never held as credentials. A tab can only read what the app was granted.',
    },
    {
      illustration: 'agent',
      title: 'Build App — it builds itself, then you refine',
      body: 'Open Build App and the OS auto-generates the whole app from your epics, user stories and granted data — a validated spec of cookbook-pattern tabs wired to your real columns. Refine with the chat assistant: it explains what\'s built, and you say "make Orders a kanban by status" or "add a KPI tab for total revenue" — it applies the change directly, schema- and governance-validated, and the live preview updates (an impossible instruction changes nothing and is explained). You can also edit any pattern by hand. Two grouped, confirm-gated controls: "Reset based on Design" and "Start from blank". There is no Save button — every change autosaves as a draft, so the app always shows in your tiles as "Draft".',
    },
    {
      illustration: 'publish',
      title: 'Test & Publish — versioned go-live',
      body: 'Test the draft privately while the currently published version stays live at /apps/<slug>. "Publish" runs the full serving gate over your draft and, if clean, promotes it to a new live version with an auto name and a change summary; a blocking draft comes back with inline { path, reason, fix } issues and nothing goes live. You can open the live app and restore an earlier version at any time. Then climb the ladder — My → Domain → Company — and call the app\'s governed MCP tools.',
      byRole: {
        builder: {
          body: 'Publish validates the draft and promotes it to a new live version (auto name + change summary); earlier versions restore. Advanced settings (builder-gated) add the scoped app theme CSS and the sandboxed custom HTML/CSS/JS block. Promote up the ladder — My → Domain → Company.',
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
      body: 'The list shows All · My · Domain · Company Software. "New app" creates a declarative app directly (name it) and drops you into the five-stage flow (Define App · Design Epics · Choose Context · Build App · Test & Publish). Everything starts Personal.',
    },
    {
      anchor: ANCHORS.software.define,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Define the app',
      body: 'Write the purpose in your own words. Define App is complete once a purpose is set. The stage assistant can sharpen it; you confirm every apply. The governed context the app may use is resolved next, in Choose Context.',
    },
    {
      anchor: ANCHORS.software.design,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Design Epics — the brief for Build',
      body: 'Add EPICs and user stories in the design board — as a role, I want a capability, so that a benefit. The assistant can draft them; you Apply what it proposes. This is the brief Build App reads to auto-generate your tabs, so a sharper design yields a better first app.',
    },
    {
      anchor: ANCHORS.software.context,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Choose Context — grant the six types',
      body: 'Grant the governed context the app may use across six types — Data · Metrics · Files · Knowledge · Agents · Connections. Per type, "add existing" grants artifacts you\'re entitled to, or "create new" makes a fresh, possibly-empty dataset/file/knowledge in an "App «Name»" folder and grants it. No raw credentials — connections are mediated and intelligence enters only as a granted agent.',
    },
    {
      anchor: ANCHORS.software.build,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      title: 'Build App — auto-generate, then refine by chat',
      body: 'Build App auto-generates the whole app from your epics and granted data — cookbook-pattern tabs mapped to your real columns. Refine with the chat assistant ("make Orders a kanban by status") — it applies edits directly, schema-validated, and the live preview updates — or edit a pattern by hand. "Reset based on Design" regenerates; "Start from blank" starts over (both confirm-gated). No Save button: every change autosaves as a draft.',
    },
    {
      anchor: ANCHORS.software.publish,
      sandboxAnchor: ANCHORS.software.sandbox,
      route: '/software',
      governedWrite: true,
      title: 'Test & Publish — promote the draft to a live version',
      body: 'Test the draft while the published version stays live at /apps/<slug>. "Publish" validates the draft with the full serving gate and promotes it to a new live version (auto name + change summary); a blocking draft returns inline { path, reason, fix } issues and nothing goes live. Open the live app, or restore an earlier version. Then promote it — My → Domain → Company.',
    },
  ],

  sandbox: {
    lane: 'My Software — private drafts and their live version',
    anchor: ANCHORS.software.sandbox,
    note: 'Apps start Personal: compose and autosave a private draft, previewed only by you. Nothing reaches the domain until you Publish and then promote up the ladder.',
  },

  outro: {
    title: 'You composed a governed app — no code, live on validate',
    body: 'You defined, designed, granted context, composed cookbook-pattern tabs over governed data, and published a live version — same-origin, no repo or pod. Next: build an agent in the Agents tab and grant it, so your app gains intelligent logic; or open Governance to see how promotion is decided.',
    next: ['agents', 'governance'],
    doc: 'software-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Open the apps your domain published — governed cookbook patterns over trusted data.',
    },
    creator: {
      verb: 'Compose',
      hook: 'Grant your data, let Build auto-generate the app, then refine it by chat — no code.',
    },
    builder: {
      verb: 'Publish & promote',
      hook: 'Publish drafts to live versions, restore earlier ones, and promote apps up the ladder.',
    },
  },
};

export default software;
