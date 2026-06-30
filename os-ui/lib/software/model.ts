/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Software golden path — the pure, client-safe model (2026-06-30 design).
 *
 * Types only: no secrets, no server imports, so both the client UI (review card,
 * app-page actions) and the server modules import it. The home-of-record `App`
 * lives in `lib/apps.ts`; this module carries the NEW governed surfaces the
 * 2026-06-30 golden path adds on top of the existing create/scaffold/promote
 * base — the deploy state machine, the Builder review card + security scan, the
 * declared/consumed resource manifest, and the adapter result shapes.
 *
 * Every effectful step the adapters perform reports `mode: 'live' | 'offline-mock'`
 * exactly like `lib/agents/build/server.ts`, so the golden path is honest about
 * what ran against a real cluster vs the in-process teaching fallback.
 */

export type RunMode = 'live' | 'offline-mock';

// ----------------------------------------------------------- Deploy lifecycle --

/**
 * The deploy state machine. `building` (just created) → `preview` (private
 * sandbox the creator runs themselves, NO review) → `review` (a Builder review
 * card is open for a domain deploy) → `live` (running on its subdomain). Going
 * back to `preview` from `live` happens on a scope-broadening change that needs
 * re-review; routine in-envelope updates stay `live` (auto-deploy).
 */
export type DeployState = 'building' | 'preview' | 'review' | 'live';

/** App status — archive disables without deleting; delete is lineage-aware. */
export type AppStatus = 'active' | 'archived';

/**
 * The approved DEPLOY ENVELOPE — the exact scope a Builder signed off on. A later
 * change is "routine" (auto-deploys) only when its requested envelope does not
 * broaden this one; anything that adds a write tool, a connection/data/knowledge
 * grant, or raises the resource footprint re-opens the review gate.
 */
export type DeployEnvelope = {
  /** Write tool names enabled to run live (reads are always on). */
  writeTools: string[];
  /** Declared governed resources the app may consume live. */
  connections: string[];
  data: string[];
  knowledge: string[];
  /** Cost/resource footprint the deploy was approved at. */
  footprint: ResourceFootprint;
};

export type ResourceFootprint = {
  cpu: string; // e.g. "250m"
  memory: string; // e.g. "256Mi"
  /** Rough monthly run cost estimate in USD (surfaced on the review card). */
  estMonthlyUsd: number;
};

// ----------------------------------------------------------- Security scan -----

export type ScanSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ScanCategory = 'sast' | 'deps' | 'secrets';

export type ScanFinding = {
  category: ScanCategory;
  severity: ScanSeverity;
  title: string;
  detail: string;
  /** repo path the finding relates to, when known. */
  path?: string;
};

export type ScanResult = {
  mode: RunMode;
  /** True only when no finding is `high`/`critical` AND no secret leaked. */
  passed: boolean;
  findings: ScanFinding[];
  /** A finding count by category for the review-card summary. */
  summary: Record<ScanCategory, number>;
  scannedAt: string;
};

// ------------------------------------------------------------- Review card -----

/**
 * The Builder review card (Software golden path §D). Shown when a creator
 * requests a domain deploy: the security-scan result + the governed resources
 * the app declares + its cost/resource footprint + the change diff. A Builder
 * (or Admin) decides; a non-Builder CANNOT approve (enforced in `review.ts`).
 */
export type ReviewDecision = 'pending' | 'approved' | 'denied';

export type ReviewCard = {
  id: string;
  appId: string;
  appName: string;
  domain: string;
  /** Who requested the deploy (the creator). */
  requestedBy: string;
  requestedAt: string;
  /** First deploy vs a scope-broadening change to an already-live app. */
  reason: 'first-deploy' | 'scope-broadened';
  scan: ScanResult;
  /** The governed resources the app is asking to use live. */
  requested: DeployEnvelope;
  /** The change diff (file path → +added/-removed line counts), summarised. */
  diff: DiffSummary;
  decision: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
};

export type DiffSummary = {
  files: { path: string; added: number; removed: number }[];
  added: number;
  removed: number;
};

// ----------------------------------------------------- Metadata convention -----

/**
 * The repo metadata convention (Software golden path — metadata fidelity). Every
 * app repo carries `app.yaml` (name · owner · description · declared
 * connections/data/knowledge), `/.app/` docs, and an OpenAPI spec. A commit hook
 * parses these on EVERY push so "whatever is committed is seen in the app".
 */
export type AppManifest = {
  name: string;
  owner: string;
  description: string;
  /** Declared governed resources the app intends to consume. */
  connections: string[];
  data: string[];
  knowledge: string[];
  /** Whether an OpenAPI spec was found (drives the auto-MCP). */
  hasOpenApi: boolean;
  /** Fields the parser could not derive (imported/legacy repos) — prompt to fill. */
  missing: string[];
};

/** A resource the app actually consumes at run time — granted, never raw creds. */
export type ConsumedResource = {
  kind: 'connection' | 'data' | 'knowledge' | 'app-mcp';
  /** The connection/data/knowledge principal or id (a reference, not a secret). */
  ref: string;
  label: string;
  /** Read-only or a bounded write grant — restrict-only, like Connections. */
  scope: 'read' | 'write-bounded';
};

// ------------------------------------------------------------- OpenAPI → MCP ---

/** A minimal OpenAPI shape the auto-MCP parser reads (paths × methods). */
export type OpenApiSpec = {
  paths: Record<string, Record<string, { operationId?: string; summary?: string }>>;
};

/** One auto-generated MCP tool with its reads-on/writes-off preset decision. */
export type GeneratedTool = {
  name: string;
  description: string;
  write: boolean;
  /** The capability mode the reads-on/writes-off preset assigned. */
  mode: 'Read' | 'Write-approval';
};

// ------------------------------------------------------------- Adapter shapes --

export type ScaffoldFile = { path: string; content: string };

export type AdapterStep = {
  ok: boolean;
  mode: RunMode;
  detail: string;
  error?: string;
};
