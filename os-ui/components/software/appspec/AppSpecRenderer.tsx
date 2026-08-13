/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { AppShell, Alert, Section as UiSection, type NavItem } from '@/lib/app-ui/index.ts';
import type { OsClient } from '@/lib/app-sdk/index.ts';
import type { Role } from '@/lib/core/session.ts';
import type { AppSpec, Tab, TabBody } from '@/lib/software/appspec/schema.ts';
import type { AppFunction } from '@/lib/software/appspec/functions-schema.ts';
import { pickTab, visibleTabs } from '@/lib/software/appspec/render-select.ts';
import { PATTERNS } from '@/lib/software/appspec/patterns.ts';
import { scopeThemeCss } from '@/lib/software/appspec/theme.ts';
import { TableViewRenderer } from './TableViewRenderer.tsx';
import { DetailViewRenderer } from './DetailViewRenderer.tsx';
import { StatusBoardRenderer } from './StatusBoardRenderer.tsx';
import { IntakeWizardRenderer } from './IntakeWizardRenderer.tsx';
import { CustomBlockRenderer } from './CustomBlockRenderer.tsx';
import { MasterDetailRenderer } from './MasterDetailRenderer.tsx';
import { KpiOverviewRenderer } from './KpiCards.tsx';
import { ChartExplorerRenderer } from './ChartExplorerRenderer.tsx';
import { CardGalleryRenderer } from './CardGalleryRenderer.tsx';
import { TimelineRenderer } from './TimelineRenderer.tsx';
import { CalendarRenderer } from './CalendarRenderer.tsx';
import { LandingRenderer } from './LandingRenderer.tsx';
import { FormRenderer } from './FormRenderer.tsx';
import { AssignmentRenderer } from './AssignmentRenderer.tsx';
import { ApprovalQueueRenderer } from './ApprovalQueueRenderer.tsx';
import { TaskChecklistRenderer } from './TaskChecklistRenderer.tsx';
import type {
  ApprovalQueueConfig,
  AssignmentConfig,
  CalendarConfig,
  CardGalleryConfig,
  ChartExplorerConfig,
  DetailConfig,
  FormConfig,
  IntakeWizardConfig,
  KpiOverviewConfig,
  LandingConfig,
  MasterDetailConfig,
  RecordsTableConfig,
  StatusBoardConfig,
  TaskChecklistConfig,
  TimelineConfig,
} from '@/lib/software/appspec/patterns.ts';

/**
 * The identity the renderer gates on — the RESOLVED viewer, dependency-INJECTED (not read from a
 * global `useIdentity`). Injection keeps this component testable AND reusable in both the OS
 * same-origin serve context and an ejected standalone app. `null` = identity loading / signed-out:
 * gated tabs show as LOCKED (never crash), real enforcement stays server-side.
 */
export type RendererIdentity = { role: Role | null } | null;

/** The class the app root carries — theme CSS is scoped under it so it can't leak into the OS. */
export const APP_ROOT_CLASS = 'sb-appspec-root';

/** An honest placeholder for a pattern whose renderer lands in a later phase. */
function PatternComingSoon({ pattern, label }: { pattern: string; label: string }) {
  return (
    <Alert variant="info">
      The “{label}” pattern (<code>{pattern}</code>) is defined but not rendered yet — it ships in a later phase.
    </Alert>
  );
}

/** Dispatch ONE tab body to its renderer. Exhaustive over the closed body kinds + pattern ids;
 *  unimplemented patterns render the honest placeholder rather than crashing. */
function BodyRenderer({ body, os, functions }: { body: TabBody; os: OsClient; functions?: AppFunction[] }) {
  if (body.kind === 'custom') {
    return <CustomBlockRenderer body={body} os={os} />;
  }
  const def = PATTERNS[body.pattern];
  switch (body.pattern) {
    case 'records-table':
      return <TableViewRenderer view={body.config as RecordsTableConfig} os={os} />;
    case 'detail':
      return <DetailViewRenderer view={body.config as DetailConfig} os={os} />;
    case 'status-board':
      return <StatusBoardRenderer view={body.config as StatusBoardConfig} os={os} />;
    case 'intake-wizard':
      return <IntakeWizardRenderer view={body.config as IntakeWizardConfig} os={os} />;
    case 'master-detail':
      return <MasterDetailRenderer view={body.config as MasterDetailConfig} os={os} />;
    case 'kpi-overview':
      return <KpiOverviewRenderer view={body.config as KpiOverviewConfig} os={os} functions={functions} />;
    case 'chart-explorer':
      return <ChartExplorerRenderer view={body.config as ChartExplorerConfig} os={os} />;
    case 'card-gallery':
      return <CardGalleryRenderer view={body.config as CardGalleryConfig} os={os} />;
    case 'timeline':
      return <TimelineRenderer view={body.config as TimelineConfig} os={os} />;
    case 'calendar':
      return <CalendarRenderer view={body.config as CalendarConfig} os={os} />;
    case 'landing':
      return <LandingRenderer view={body.config as LandingConfig} os={os} functions={functions} />;
    case 'form':
      return <FormRenderer view={body.config as FormConfig} os={os} />;
    case 'assignment':
      return <AssignmentRenderer view={body.config as AssignmentConfig} os={os} />;
    case 'approval-queue':
      return <ApprovalQueueRenderer view={body.config as ApprovalQueueConfig} os={os} />;
    case 'task-checklist':
      return <TaskChecklistRenderer view={body.config as TaskChecklistConfig} os={os} />;
    default:
      return <PatternComingSoon pattern={body.pattern} label={def?.label ?? body.pattern} />;
  }
}

/**
 * `<AppSpecRenderer>` — the ONE trusted component that renders any valid AppSpec (v2) correctly.
 *
 * COMPOSITION: it renders the whole app chrome inside the vendored `AppShell` (left nav built from
 * the spec's TABS + the active tab's body). The spec's `tabs` map one-to-one onto AppShell's
 * `nav`, so owning the shell here is the cleaner composition and makes the component self-contained
 * for both same-origin serve and eject.
 *
 * THEME: `spec.theme.css` is applied via a `<style>` whose rules are SCOPED under the app-root
 * class (`scopeThemeCss`), so an author's CSS restyles their app but cannot leak into the OS
 * chrome (sidebar/topbar) or another app. Size is capped at author time (see schema).
 *
 * GATING: the left nav is built from `visibleTabs(spec, role)` — a tab the viewer's role can't
 * reach (per `roleAtLeast`) is simply not shown. Advisory only; the data layer is the real gate.
 * When identity is null (loading/signed-out) gated tabs show as a LOCKED nav entry, never dropped.
 */
export function AppSpecRenderer({
  spec,
  os,
  identity,
}: {
  spec: AppSpec;
  os: OsClient;
  identity: RendererIdentity;
}) {
  const role: Role | null = identity ? identity.role : null;
  const visible = visibleTabs(spec, role);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active: Tab | undefined = pickTab(spec, activeId, role);

  // Locked (gated, unreachable) tabs — shown disabled in the nav as an honest signal that more
  // exists behind a higher role, never silently dropped when identity is still loading.
  const lockedGated: Tab[] = role === null ? spec.tabs.filter((t) => !!t.roleGate) : [];

  // Author theme CSS, scoped under the app root so it can't escape into the OS chrome.
  const scopedTheme = useMemo(
    () => (spec.theme?.css ? scopeThemeCss(spec.theme.css, `.${APP_ROOT_CLASS}`) : ''),
    [spec.theme?.css],
  );

  const nav: NavItem[] = [
    ...visible.map(
      (t): NavItem => ({
        label: t.label,
        icon: t.icon,
        active: active?.id === t.id,
        onClick: () => setActiveId(t.id),
      }),
    ),
    ...lockedGated.map(
      (t): NavItem => ({
        label: (
          <span style={{ opacity: 0.5 }}>
            {t.label} <span aria-label="locked">🔒</span>
          </span>
        ),
        onClick: () => undefined,
      }),
    ),
  ];

  return (
    <div className={APP_ROOT_CLASS}>
      {scopedTheme && <style dangerouslySetInnerHTML={{ __html: scopedTheme }} />}
      <AppShell brand={spec.name} brandSub={spec.description} nav={nav} title={active ? active.label : spec.name}>
        {active ? (
          <UiSection>
            <BodyRenderer body={active.body} os={os} functions={spec.functions} />
          </UiSection>
        ) : (
          <Alert variant="info">
            Nothing to show here yet
            {role === null ? ' — sign in to see role-gated tabs.' : '.'}
          </Alert>
        )}
      </AppShell>
    </div>
  );
}
