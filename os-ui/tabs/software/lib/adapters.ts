/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { templateFiles, type AppTemplateKey, TEMPLATE_RUNTIME } from '@tabs/software/lib/apps';
import { generateAndCompile, applyReadsOnWritesOff } from '@tabs/software/lib/auto-mcp';
import { securityScan } from '@tabs/software/lib/scan';
import type {
  GeneratedTool,
  ResourceFootprint,
  ScaffoldFile,
  ScanResult,
  AppManifest,
} from '@tabs/software/lib/model';

/**
 * The TWO adapter interfaces every authoring path converges on (Software golden
 * path — Adapters). Both are Opus-owned because they ARE the convergence
 * guarantee: no matter the template/runtime or the front door, everything ends
 * up on the SAME source-tree / security-scan / LiteLLM+OPA / Langfuse plumbing,
 * governed identically.
 *
 *  (a) TemplateAdapter — per-template / per-runtime: the 4 capabilities
 *      `scaffold · ciScan · autoMcp · capabilityToOpa` for web app / service /
 *      script / dashboard. Template-specific knowledge (files, tools, footprint)
 *      lives on the adapter; the effectful commit/preview/deploy steps live in
 *      `server.ts` (commitToApp) and `review.ts` (the in-cluster runner).
 *
 *  (b) FrontDoorAdapter — per-front-door: `chat · platform-mcp · git-import`.
 *      Each authors content its own way, then returns a uniform `AuthorResult`
 *      (files + manifest + message) that flows into the one governed
 *      commit→metadata→auto-MCP→review pipeline.
 */

// ----------------------------------------------------- (a) TemplateAdapter -----

export interface TemplateAdapter {
  key: AppTemplateKey;
  runtime: 'web' | 'service' | 'script' | 'dashboard';
  footprint: ResourceFootprint;
  /** Pure: the template's seed files (incl. app.yaml + openapi + Dockerfile). */
  scaffold(name: string, slug: string): ScaffoldFile[];
  /** Security scan over the app files (SAST/deps/secrets). */
  ciScan(files: ScaffoldFile[], mode: ScanResult['mode']): ScanResult;
  /** Pure: derive the auto-MCP tools (reads-on/writes-off preset applied). */
  autoMcp(slug: string, tools: { name: string; description: string; write: boolean }[]): GeneratedTool[];
  /** Side-effect: compile the capability profile into OPA under `principal`. */
  capabilityToOpa(principal: string, tools: GeneratedTool[]): GeneratedTool[];
}

const FOOTPRINTS: Record<AppTemplateKey, ResourceFootprint> = {
  'nextjs-supabase': { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
  'vite-os': { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  'sovereign-app': { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  website: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  'api-service': { cpu: '100m', memory: '128Mi', estMonthlyUsd: 6 },
  empty: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  service: { cpu: '100m', memory: '128Mi', estMonthlyUsd: 6 },
  script: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 2 },
  dashboard: { cpu: '200m', memory: '256Mi', estMonthlyUsd: 10 },
};

/** One adapter per template; all share the convergent pipeline behaviour. */
export function templateAdapter(key: AppTemplateKey): TemplateAdapter {
  return {
    key,
    runtime: TEMPLATE_RUNTIME[key] ?? 'web',
    footprint: FOOTPRINTS[key] ?? FOOTPRINTS['nextjs-supabase'],
    scaffold: (name, slug) => templateFiles(key, name, slug),
    ciScan: (files, mode) => securityScan(files, mode),
    autoMcp: (_slug, tools) => applyReadsOnWritesOff(tools),
    capabilityToOpa: (principal, tools) => generateAndCompile(principal, { tools }),
  };
}

export const TEMPLATE_KEYS: AppTemplateKey[] = ['nextjs-supabase', 'service', 'script', 'dashboard'];

// ----------------------------------------------------- (b) FrontDoorAdapter ----

export type FrontDoorKey = 'chat' | 'platform-mcp' | 'git-import';

export type AuthorInput = {
  /** The authoring payload — a chat turn, an MCP commit, an imported tree / repo URL. */
  message?: string;
  files?: ScaffoldFile[];
  /** For git-import: the external repo URL to mirror in. */
  repoUrl?: string;
  /** Known identity to stamp into a derived manifest. */
  name: string;
  owner: string;
  description?: string;
};

export type AuthorResult = {
  door: FrontDoorKey;
  files: ScaffoldFile[];
  /** The parsed/derived metadata convention (drives the app page + auto-MCP). */
  manifest: AppManifest;
  message: string;
  /** Anything the parser could not derive (imported/legacy repos prompt for it). */
  missing: string[];
};

export interface FrontDoorAdapter {
  key: FrontDoorKey;
  label: string;
  /** Author content, then converge on the one governed commit pipeline. */
  author(input: AuthorInput): Promise<AuthorResult>;
}

export const FRONT_DOORS: { key: FrontDoorKey; label: string }[] = [
  { key: 'chat', label: 'In-app build chat (OpenCode)' },
  { key: 'platform-mcp', label: 'Platform MCP (Claude Code / any MCP client)' },
  { key: 'git-import', label: 'Git bridge — import a GitHub/GitLab repo' },
];
