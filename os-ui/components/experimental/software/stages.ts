/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SOFTWARE guided path as a shared-core staged model — Define App · Design Epics ·
 * Choose Context · Build App · Test & Publish (Builder Framework, 0.6.105 restructure).
 * Pure and framework-free (mirrors the Agents `PHASES` and Dashboards `DASH_STAGES`
 * arrays) so the gating and ✓ rules are unit-testable on their own; the React skin is
 * components/software/SoftwareBuilder.tsx, riding components/core/StageShell.tsx.
 *
 * Each stage is ONE function:
 *   • Define App     — name, purpose, template pick (context grants moved to Choose Context).
 *   • Design Epics   — the SPECIFICATION: per story, three lists (features / NFRs / rules).
 *   • Choose Context — RESOLVE every context need: bind an EXISTING artifact (connections /
 *                      data / knowledge / files / metrics) or CREATE-NEW a dataset (empty /
 *                      AI-dummy). The data-needing stories can't build until this is resolved.
 *   • Build App      — EXECUTION: one "Build this user story" button + a checklist ticking
 *                      the Design spec against real build activity.
 *   • Test & Publish — LLM-tests each built story against its spec + the LIVE-POD preview,
 *                      AND the governed deploy / go-live controls (merged from Test+Publish).
 *
 * INTERNAL STAGE IDS ARE KEPT STABLE where load-bearing (the OS scope-vocabulary pattern):
 *   `define`/`design`/`build`/`publish` ids are UNCHANGED — only their display labels move.
 *   The NEW `context` id is inserted at position 3. The old standalone `test` stage is
 *   RETIRED from the flow and MERGED into `publish` (its body now hosts both surfaces); the
 *   assistant/MCP `test` verb (verify_software / stage="test") is unaffected — it is a
 *   separate vocabulary, not a stage id.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL app state — you must state a
 * purpose before Design; Choose Context opens once a backlog exists; Build is gated on a
 * specced backlog AND a resolved context (the design-before-build + data-need gates); and
 * Test & Publish is blocked until at least one story is ACTUALLY BUILT (real committed
 * story code), not merely that the user clicked into Build. `completed(ctx)` is each
 * stage's LIVE condition; a stage shows a ✓ only when the user ALSO worked it this session
 * (tracked by the StageState in the component). So a freshly-opened app shows no pre-marked
 * checks, opens on the FIRST INCOMPLETE stage (Define for a new app — never Test & Publish),
 * and a check clears if the user later invalidates it.
 */

import type { StageDef } from '@/lib/core/stages';

export type SwStageId = 'define' | 'design' | 'context' | 'build' | 'publish';

/** The live state the software stage gates/✓-conditions read — derived fresh each render. */
export type SwCtx = {
  /** The app has a name (a scaffolded app always does). */
  named: boolean;
  /** A purpose has been stated (Define App's ✓ condition). */
  hasPurpose: boolean;
  /** ≥1 epic with ≥1 story exists (a backlog exists to specify + resolve context against). */
  hasDesign: boolean;
  /** Every story has authored a Design spec (Design Epics's ✓ condition). */
  designSpecComplete: boolean;
  /**
   * Every data-needing story has its context resolved — a dataset is bound/created, OR no
   * story implies a data need (Choose Context's ✓ condition + Build App's data-need gate).
   */
  contextResolved: boolean;
  /** The repo is scaffolded with at least one commit (pipeline `forgejo` = ok). */
  committed: boolean;
  /**
   * At least one user story is ACTUALLY BUILT — real code committed for it (a story marked
   * `done` by a successful build commit). The Test & Publish entry gate: you can't test or
   * ship an app with zero committed story code.
   */
  anyStoryBuilt: boolean;
  /** A preview pod is running (a served URL), OR the viewer acknowledged no cluster. */
  previewed: boolean;
  /** At least one successful go-live — the release counter (`deploy.releases` > 0). */
  deployed: boolean;
  /** The app is live right now (`deploy.state` === 'live'). */
  live: boolean;
  /**
   * The app is a DECLARATIVE (no-code) spec app (`serveMode === 'spec'`). Its data is mapped
   * INSIDE the composer — each tab picks its own granted dataset, or needs none at all (a
   * form-only tab writes a record) — so Build must NOT be hard-blocked on `contextResolved`
   * the way a coded app is. Choose Context still feeds the composer's dataset picker; it just
   * isn't a build gate for the no-code path.
   */
  isSpec: boolean;
  /**
   * A spec app has a DRAFT or LIVE spec to test/publish (os-ui 0.6.135). For a spec app, Build
   * never sets the code-app `anyStoryBuilt` signal (no repo/commit), so the Test & Publish stage
   * was permanently unclickable. This makes it reachable the moment a draft/spec exists — mirror
   * of the `isSpec` Build-gate fix. False for a coded app (its gate stays `anyStoryBuilt`).
   */
  hasDraftOrSpec: boolean;
  /** A spec app has PUBLISHED (a live `spec` exists) — the spec-app equivalent of `live`. */
  specPublished: boolean;
};

/**
 * The five stages. Define App captures purpose + template (always reachable — the front
 * door). Design Epics needs a purpose and is complete only when every story carries a spec.
 * Choose Context opens once a backlog exists and is complete when every data-needing story's
 * context is resolved. Build App is gated on BOTH a specced backlog and a resolved context
 * (the design-before-build + data-need gates), and is complete once code is committed. Test
 * & Publish is gated on at least one ACTUALLY-BUILT story (not merely a scaffolded repo), and
 * then reports the live status. Each gate reads ACTUAL app state (`app.purpose`, `app.epics`,
 * story specs, granted datasets, `app.pipeline`, story build status, release count) — never a
 * timer, never faked.
 */
export const SW_STAGES: StageDef<SwStageId, SwCtx>[] = [
  { id: 'define', title: 'Define App', hint: 'Name it, pick a template, and state its purpose.', completed: (c) => c.hasPurpose },
  { id: 'design', title: 'Design Epics', hint: 'Specify each user story — its features, non-functional requirements and rules.', enabled: (c) => c.hasPurpose, completed: (c) => c.designSpecComplete },
  { id: 'context', title: 'Choose Context', hint: 'Resolve every context need — bind an existing artifact, or create a new dataset (empty or with sample data).', enabled: (c) => c.hasDesign, completed: (c) => c.contextResolved },
  { id: 'build', title: 'Build App', hint: 'Build a user story with one press; watch the spec tick off as it lands.', enabled: (c) => c.hasDesign && (c.isSpec || c.contextResolved), completed: (c) => c.committed },
  { id: 'publish', title: 'Test & Publish', hint: 'Test each built story against its spec, then deploy to go live — request go-live, watch the live pod, and manage its lifecycle.', enabled: (c) => c.anyStoryBuilt || (c.isSpec && c.hasDraftOrSpec), completed: (c) => (c.isSpec ? c.specPublished : c.live) },
];
