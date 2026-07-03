/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */

/**
 * System agents — backend services that power individual tabs but are NOT
 * user-authored agent systems. These are ops-level entries surfaced ONLY on
 * the Platform tab status view, never on the Agents authoring tab.
 *
 * Each entry declares which tab it backs and where to probe its health, so
 * the Platform ops view can show live status without spreading that knowledge
 * across the tab pages themselves.
 */

export type SystemAgent = {
  /** Stable key — matches the k8s Service name. */
  key: string;
  name: string;
  /** Human description of what capability this service provides. */
  role: string;
  runtime: string;
  /** Which tab this service backs (for cross-linking in the Platform view). */
  backsTab: string;
  /** Health probe URL (server-side only). */
  healthUrl: string;
  /** If true, being down is not a hard error (opt-in feature). */
  optional: boolean;
};

/**
 * The canonical system-agent registry.
 * Imported by the Platform tab's API route (`/api/platform-admin/agents`)
 * to render live status. Never imported by the Agents tab.
 */
export const SYSTEM_AGENTS: SystemAgent[] = [
  {
    key: 'sample-agent',
    name: 'Domain RAG Agent',
    role: 'retrieve → generate → trace (talk-to-your-data backbone)',
    runtime: 'LangGraph',
    backsTab: 'data',
    healthUrl: 'http://sample-agent:8000/health',
    optional: false,
  },
  {
    key: 'ml-agent',
    name: 'ML Pipeline Agent',
    role: 'features → train → deploy (Science / Layer-4 pipeline driver)',
    runtime: 'LangGraph',
    backsTab: 'science',
    healthUrl: 'http://ml-agent:8000/health',
    optional: true,
  },
  {
    key: 'hermes-gateway',
    name: 'Hermes Autonomous Runtime',
    role: 'long-running autonomy + persistent memory + self-improving skills',
    runtime: 'Hermes (autonomous)',
    backsTab: 'agents',
    healthUrl: 'http://hermes-gateway:8080/health',
    optional: true,
  },
];
