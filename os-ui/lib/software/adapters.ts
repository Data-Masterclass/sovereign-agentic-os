/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { templateFiles, type AppTemplateKey, TEMPLATE_RUNTIME } from '@/lib/software/apps';
import { generateAndCompile, applyReadsOnWritesOff } from './auto-mcp.ts';
import { securityScan } from './scan.ts';
import type {
  AdapterStep,
  GeneratedTool,
  ResourceFootprint,
  RunMode,
  ScaffoldFile,
  ScanResult,
  AppManifest,
} from './model.ts';

/**
 * The TWO adapter interfaces every authoring path converges on (Software golden
 * path — Adapters). Both are Opus-owned because they ARE the convergence
 * guarantee: no matter the template/runtime or the front door, everything ends
 * up on the SAME Forgejo / Harbor / Argo CD / Secrets / LiteLLM+OPA / Langfuse
 * plumbing, governed identically.
 *
 *  (a) TemplateAdapter — per-template / per-runtime: the 7 capabilities
 *      `scaffold · commit · preview · ciScan · deploy · autoMcp · capabilityToOpa`
 *      for web app / service / script / dashboard. Template-specific knowledge
 *      (files, tools, footprint) lives on the adapter; the effectful steps run
 *      against an injected `PipelineBackend` so the SAME adapter runs live (real
 *      Forgejo/Argo) or offline-mock (in-process) — the dual pattern from
 *      `lib/agents/build/server.ts`.
 *
 *  (b) FrontDoorAdapter — per-front-door: `chat · platform-mcp · git-push ·
 *      git-import`. Each authors content its own way, then returns a uniform
 *      `AuthorResult` (files + manifest + message) that flows into the one
 *      governed commit→metadata→auto-MCP→review pipeline. Git is the bridge.
 */

// ---------------------------------------------------- Pipeline backend (DI) ----
//
// The shared plumbing, provided live or mocked by `server.ts`. Effectful steps
// always report `mode`, so the golden path is honest about what ran for real.

export interface PipelineBackend {
  mode: RunMode;
  scaffoldRepo(slug: string, files: ScaffoldFile[]): Promise<AdapterStep>;
  commit(slug: string, files: ScaffoldFile[], message: string): Promise<AdapterStep>;
  preview(slug: string): Promise<{ step: AdapterStep; url: string }>;
  deploy(slug: string): Promise<AdapterStep>;
}

// ----------------------------------------------------- (a) TemplateAdapter -----

export interface TemplateAdapter {
  key: AppTemplateKey;
  runtime: 'web' | 'service' | 'script' | 'dashboard';
  footprint: ResourceFootprint;
  /** Pure: the template's seed files (incl. app.yaml + openapi + Dockerfile/CI). */
  scaffold(name: string, slug: string): ScaffoldFile[];
  /** Effectful: create the repo + seed files (live Forgejo or mock). */
  commit(backend: PipelineBackend, slug: string, files: ScaffoldFile[], message: string): Promise<AdapterStep>;
  /** Effectful: spin up an ephemeral private preview (Argo ApplicationSet / mock). */
  preview(backend: PipelineBackend, slug: string): Promise<{ step: AdapterStep; url: string }>;
  /** CI + security scan over the repo files (SAST/deps/secrets). */
  ciScan(files: ScaffoldFile[], mode: ScanResult['mode']): ScanResult;
  /** Effectful: Harbor → Argo CD → live subdomain (live or mock). */
  deploy(backend: PipelineBackend, slug: string): Promise<AdapterStep>;
  /** Pure: derive the auto-MCP tools (reads-on/writes-off preset applied). */
  autoMcp(slug: string, tools: { name: string; description: string; write: boolean }[]): GeneratedTool[];
  /** Side-effect: compile the capability profile into OPA under `principal`. */
  capabilityToOpa(principal: string, tools: GeneratedTool[]): GeneratedTool[];
}

const FOOTPRINTS: Record<AppTemplateKey, ResourceFootprint> = {
  'nextjs-supabase': { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
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
    commit: (backend, slug, files, message) => backend.commit(slug, files, message),
    preview: (backend, slug) => backend.preview(slug),
    ciScan: (files, mode) => securityScan(files, mode),
    deploy: (backend, slug) => backend.deploy(slug),
    autoMcp: (_slug, tools) => applyReadsOnWritesOff(tools),
    capabilityToOpa: (principal, tools) => generateAndCompile(principal, { tools }),
  };
}

export const TEMPLATE_KEYS: AppTemplateKey[] = ['nextjs-supabase', 'service', 'script', 'dashboard'];

// ----------------------------------------------------- (b) FrontDoorAdapter ----

export type FrontDoorKey = 'chat' | 'platform-mcp' | 'git-push' | 'git-import';

export type AuthorInput = {
  /** The authoring payload — a chat turn, an MCP commit, a pushed tree, a repo URL. */
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
  { key: 'git-push', label: 'Direct git push to the app repo' },
  { key: 'git-import', label: 'Git bridge — import a GitHub/GitLab repo' },
];
