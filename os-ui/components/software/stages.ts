/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SOFTWARE guided path as a shared-core staged model — Define · Design · Build ·
 * Test · Publish (Builder Framework Wave 1a). Pure and framework-free (mirrors the
 * Agents `PHASES` and Dashboards `DASH_STAGES` arrays) so the gating and ✓ rules are
 * unit-testable on their own; the React skin is components/software/SoftwareBuilder.tsx,
 * riding components/core/StageShell.tsx.
 *
 * Each stage is ONE function:
 *   • Define  — name, purpose, template pick, governed context grants.
 *   • Design  — the SPECIFICATION: per story, three lists (features / NFRs / rules).
 *   • Build   — EXECUTION: one "Build this user story" button + a checklist ticking
 *               the Design spec against real build activity.
 *   • Test    — LLM-tests each built story against its spec + the LIVE-POD preview.
 *   • Publish — deploy / request go-live, the live app + MCP link + lifecycle.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL app state — you must state a
 * purpose before you Design/Build, can't Test before the repo is scaffolded (≥1
 * commit), can't Publish a build that never committed. `completed(ctx)` is each stage's
 * LIVE condition; a stage shows a ✓ only when the user ALSO worked it this session
 * (tracked by the StageState in the component). So a freshly-opened app shows no
 * pre-marked checks, opens on the FIRST INCOMPLETE stage (Define for a new app — never
 * Test), and a check clears if the user later invalidates it.
 */

import type { StageDef } from '@/lib/core/stages';

export type SwStageId = 'define' | 'design' | 'build' | 'test' | 'publish';

/** The live state the software stage gates/✓-conditions read — derived fresh each render. */
export type SwCtx = {
  /** The app has a name (a scaffolded app always does). */
  named: boolean;
  /** A purpose has been stated (Define's ✓ condition). */
  hasPurpose: boolean;
  /** ≥1 epic with ≥1 story exists (a backlog exists to specify against). */
  hasDesign: boolean;
  /** Every story has authored a Design spec (Design's ✓ condition). */
  designSpecComplete: boolean;
  /** The repo is scaffolded with at least one commit (pipeline `forgejo` = ok). */
  committed: boolean;
  /** A preview pod is running (a served URL), OR the viewer acknowledged no cluster (Test's ✓). */
  previewed: boolean;
  /** At least one successful go-live — the release counter (`deploy.releases` > 0). */
  deployed: boolean;
  /** The app is live right now (`deploy.state` === 'live'). */
  live: boolean;
};

/**
 * The five stages. Define captures purpose + template + grants (always reachable — the
 * front door). Design needs a purpose and is complete only when every story carries a
 * spec. Build needs a purpose too (so a brief exists before the build machinery runs).
 * Test needs a scaffolded repo (there must be committed code to run against + preview).
 * Publish needs a scaffolded repo to review/publish, then reports the live status. Each
 * gate reads ACTUAL app state (`app.purpose`, `app.epics`, story specs, `app.pipeline`,
 * release count) — never a timer, never faked.
 */
export const SW_STAGES: StageDef<SwStageId, SwCtx>[] = [
  { id: 'define', title: 'Define', hint: 'Name it, pick a template, state its purpose, and grant the governed context it may use.', completed: (c) => c.hasPurpose },
  { id: 'design', title: 'Design', hint: 'Specify each user story — its features, non-functional requirements and rules.', enabled: (c) => c.hasPurpose, completed: (c) => c.designSpecComplete },
  { id: 'build', title: 'Build', hint: 'Build a user story with one press; watch the spec tick off as it lands.', enabled: (c) => c.hasPurpose, completed: (c) => c.committed },
  { id: 'test', title: 'Test', hint: 'Run the app, and LLM-test each built story against its Design spec.', enabled: (c) => c.committed, completed: (c) => c.previewed },
  { id: 'publish', title: 'Publish', hint: 'Deploy your app to go live — request go-live, then watch the live pod, call its tools, and manage its lifecycle.', enabled: (c) => c.committed, completed: (c) => c.live },
];
