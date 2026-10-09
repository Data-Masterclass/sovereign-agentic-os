/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The declarative AppSpec renderer (Track 2) — the ONE trusted, OS-owned React component that
 * renders any valid AppSpec, plus its per-pattern + custom-block sub-renderers. Wired into the
 * same-origin `/apps/<slug>` serve route (see app/apps/[slug]). These are pure component exports.
 */
export { AppSpecRenderer, type RendererIdentity, APP_ROOT_CLASS } from './AppSpecRenderer.tsx';
export { TableViewRenderer } from './TableViewRenderer.tsx';
export { DetailViewRenderer } from './DetailViewRenderer.tsx';
export { StatusBoardRenderer } from './StatusBoardRenderer.tsx';
export { IntakeWizardRenderer } from './IntakeWizardRenderer.tsx';
export { CustomBlockRenderer } from './CustomBlockRenderer.tsx';
export { MasterDetailRenderer } from './MasterDetailRenderer.tsx';
export { KpiCards, KpiOverviewRenderer } from './KpiCards.tsx';
export { ChartExplorerRenderer } from './ChartExplorerRenderer.tsx';
export { CardGalleryRenderer } from './CardGalleryRenderer.tsx';
export { TimelineRenderer } from './TimelineRenderer.tsx';
export { CalendarRenderer } from './CalendarRenderer.tsx';
export { LandingRenderer } from './LandingRenderer.tsx';
export { FormRenderer } from './FormRenderer.tsx';
export { AssignmentRenderer } from './AssignmentRenderer.tsx';
export { ApprovalQueueRenderer } from './ApprovalQueueRenderer.tsx';
export { TaskChecklistRenderer } from './TaskChecklistRenderer.tsx';
