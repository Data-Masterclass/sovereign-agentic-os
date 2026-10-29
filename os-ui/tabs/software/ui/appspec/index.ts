/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The declarative AppSpec renderer (Track 2) — the ONE trusted, OS-owned React component that
 * renders any valid AppSpec, plus its per-pattern + custom-block sub-renderers. Wired into the
 * same-origin `/apps/<slug>` serve route (see app/apps/[slug]). These are pure component exports.
 */
export { AppSpecRenderer, type RendererIdentity, APP_ROOT_CLASS } from '@tabs/software/ui/appspec/AppSpecRenderer';
export { TableViewRenderer } from '@tabs/software/ui/appspec/TableViewRenderer';
export { DetailViewRenderer } from '@tabs/software/ui/appspec/DetailViewRenderer';
export { StatusBoardRenderer } from '@tabs/software/ui/appspec/StatusBoardRenderer';
export { IntakeWizardRenderer } from '@tabs/software/ui/appspec/IntakeWizardRenderer';
export { CustomBlockRenderer } from '@tabs/software/ui/appspec/CustomBlockRenderer';
export { MasterDetailRenderer } from '@tabs/software/ui/appspec/MasterDetailRenderer';
export { KpiCards, KpiOverviewRenderer } from '@tabs/software/ui/appspec/KpiCards';
export { ChartExplorerRenderer } from '@tabs/software/ui/appspec/ChartExplorerRenderer';
export { CardGalleryRenderer } from '@tabs/software/ui/appspec/CardGalleryRenderer';
export { TimelineRenderer } from '@tabs/software/ui/appspec/TimelineRenderer';
export { CalendarRenderer } from '@tabs/software/ui/appspec/CalendarRenderer';
export { LandingRenderer } from '@tabs/software/ui/appspec/LandingRenderer';
export { FormRenderer } from '@tabs/software/ui/appspec/FormRenderer';
export { AssignmentRenderer } from '@tabs/software/ui/appspec/AssignmentRenderer';
export { ApprovalQueueRenderer } from '@tabs/software/ui/appspec/ApprovalQueueRenderer';
export { TaskChecklistRenderer } from '@tabs/software/ui/appspec/TaskChecklistRenderer';
