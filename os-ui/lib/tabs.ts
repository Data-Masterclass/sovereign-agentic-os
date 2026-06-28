/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set. The first group is the canonical OS tab order
 * (os-application.md §4); every tab routes to a real surface in v1.0. The
 * second group ("Platform") holds infrastructure consoles wired to in-cluster
 * services that don't map onto a single business tab (the model/MCP gateway,
 * the orchestrator, the launchpad for the full external tool UIs, and the
 * About / Licenses page).
 */
export type Tab = {
  label: string;
  icon: string; // single-glyph marker rendered in the sidebar
  href?: string; // present => navigable; absent => stub ("soon")
  role?: string; // gating note (informational in the MVP)
};

export type TabGroup = {
  heading?: string;
  tabs: Tab[];
};

export const TAB_GROUPS: TabGroup[] = [
  {
    tabs: [
      { label: 'Home', icon: '◇', href: '/' },
      { label: 'Strategy', icon: '▲', href: '/strategy' },
      { label: 'Big Bets', icon: '◆', href: '/big-bets' },
      { label: 'Dashboards', icon: '▦', href: '/dashboards' },
      { label: 'Agents', icon: '✦', href: '/agents' },
      { label: 'Software', icon: '⌘', href: '/software' },
      { label: 'Science', icon: '∿', href: '/science' },
      { label: 'Knowledge', icon: '❦', href: '/knowledge' },
      { label: 'Structured Data', icon: '▤', href: '/data' },
      { label: 'Metrics', icon: '∑', href: '/metrics' },
      { label: 'Unstructured Data', icon: '❏', href: '/unstructured' },
      { label: 'Connections', icon: '⇄', href: '/connections' },
      { label: 'Marketplace', icon: '⊞', href: '/marketplace' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring' },
      { label: 'Governance', icon: '⚖', href: '/governance', role: 'Builder / Administrator' },
      { label: 'Settings', icon: '⚙', href: '/settings' },
    ],
  },
  {
    heading: 'Platform',
    tabs: [
      { label: 'Components', icon: '▥', href: '/components', role: 'Builder / Administrator' },
      { label: 'Gateway', icon: '⌁', href: '/gateway' },
      { label: 'Orchestration', icon: '⟲', href: '/orchestration' },
      { label: 'Consoles', icon: '◫', href: '/consoles' },
      { label: 'About / Licenses', icon: '©', href: '/about' },
    ],
  },
];

// Flat list (kept for any consumer that just wants every tab in order).
export const TABS: Tab[] = TAB_GROUPS.flatMap((g) => g.tabs);
