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
 * Every effectful step reports `mode: 'live' | 'offline-mock'` exactly like
 * `lib/agents/build/server.ts`, so the golden path is honest about what ran against
 * a real cluster vs the in-process teaching fallback (e.g. the deterministic baseline
 * security scan is labelled `offline-mock`).
 */

export type RunMode = 'live' | 'offline-mock';

// -------------------------------------------------------------- App surface ----

/**
 * The DETECTED surface of an app (2026-07 golden path): what it actually exposes
 * once built, inferred from the committed code + deploy manifest — NOT chosen up
 * front. An app that serves a frontend / HTML has a `ui`; one that exposes API
 * endpoints or an MCP tool surface has an `api`; an app can have both. The
 * monitor view drives its "Open app UI ↗" / "API details" affordances off this,
 * so the create flow never has to ask "what kind of app".
 */
export type AppSurface = { ui: boolean; api: boolean };

/**
 * An EXPLICIT surface declaration (intent). A creator can DECLARE what an app is —
 * `ui` (serves a frontend), `api` (headless / tool surface), or `both` — via the
 * `surface` key in the app manifest (`app.yaml`) or the `create_software` MCP arg.
 * When declared, the declaration WINS over the `detectSurface` heuristic (a real
 * Streamlit / Gradio / static-HTML app is never mislabelled "API"); when absent
 * the surface is inferred from the committed code. `resolveSurface` applies this.
 */
export type SurfaceDeclaration = 'ui' | 'api' | 'both';

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

/**
 * WHICH ENGINE produced the verdict. `'unavailable'` is the third state (2026-11-18): no scanner
 * engine ran at all, so there is no verdict to give \u2014 distinct from `offline-mock`, which means
 * the deterministic baseline really did read the real files. See `core/kernel/offline-mock.ts`.
 */
export type ScanMode = RunMode | 'unavailable';

export type ScanResult = {
  mode: ScanMode;
  /** True only when no finding is `high`/`critical` AND no secret leaked. */
  passed: boolean;
  findings: ScanFinding[];
  /** A finding count by category for the review-card summary. */
  summary: Record<ScanCategory, number>;
  scannedAt: string;
  /**
   * Set when NO scanner engine ran: `passed` is false for THAT reason, not because of a finding.
   * An approver must be able to tell "we looked and it is clean" from "nothing looked", because
   * `decideDeploy` approves only on `passed` and the second one used to read as the first.
   */
  unavailable?: true;
  /** Why there is no verdict. Present with `unavailable`. */
  reason?: string;
  /**
   * WHICH engine produced this result, when one did — e.g. `'trivy'`. Optional: a card
   * serialised before the live scanner existed carries none, and the baseline run names none
   * because it is not an engine, it is a deterministic read of the files.
   */
  engine?: string;
  /**
   * The categories NO engine covered, so a ZERO count in `summary` cannot be read as "clean".
   * `['sast']` on every live Trivy scan: Trivy finds dependency vulnerabilities and committed
   * secrets, and there is no allowlisted SAST engine to wire (Semgrep's engine is LGPL-2.1 and
   * forbidden by `licenses/policy.json`). Saying nothing here is how `sast 0` came to
   * read as "we looked at the code and it is fine".
   */
  notRun?: ScanCategory[];
  /**
   * True when `findings` is a CAPPED view of a longer list. `passed` and `summary` always account
   * for every finding; `findings` does not, so anything deriving severity from the list alone is
   * reading an incomplete picture (PR #63 re-review L-B).
   */
  truncated?: true;
  /**
   * True when a BLOCKING finding (a secret, or high/critical) exists that the cap left out of
   * `findings`. The deploy gate (`scanGate` in `review.ts`) must read this: without it, a card
   * whose blocking findings sat past the cap classified as "nothing blocking found" — and became
   * ACKNOWLEDGEABLE by an admin, which is the one thing a real finding must never be.
   */
  blockingBeyondCap?: true;
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
  /**
   * WP-54: the git commit of the app tree this request is for. An approval applies EXACTLY this
   * commit's `k8s/` manifests (image apps); a later commit needs its own request. Optional-on-load.
   */
  sha?: string | null;
  /** The governed resources the app is asking to use live. */
  requested: DeployEnvelope;
  /** The change diff (file path → +added/-removed line counts), summarised. */
  diff: DiffSummary;
  /**
   * Non-blocking review WARNINGS surfaced on the card so a deploy can't ship them
   * silently — e.g. "references ungranted datasets: «Service Centers» (ds_…)" from the
   * 0.6.97 dataset guard. Optional-on-load (undefined ⇒ none); a warning informs the
   * Builder's decision but, unlike a failed scan, does not itself block approval.
   */
  warnings?: string[];
  decision: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
  /**
   * THE AUDITED HATCH (2026-11-19). Set when an `admin` approved this deploy while the scan was
   * `unavailable` — no verdict existed and a named human took responsibility for going ahead.
   * NEVER set when a scan RAN and FAILED: a real finding still blocks, and the acknowledgement
   * is refused in that case rather than recorded. The card therefore reads "approved WITHOUT a
   * security verdict", which is a different fact from "approved".
   */
  approvedWithoutScan?: true;
  /**
   * The SECOND audited state (PR #63 re-review H-1): the engine RAN, found nothing blocking, and
   * declared a category it could not cover — today `deps`, when the tree has a dependency manifest
   * but no lockfile for the scanner to resolve. That is not "no verdict" (an engine did run and
   * the secret scan DID cover every file) and it is not a failure (there is nothing to fix), so it
   * gets its own label rather than being folded into either. Lists the uncovered categories.
   */
  approvedWithUncoveredCategories?: ScanCategory[];
  /**
   * The admin's mandatory written reason (>= 20 characters). Present with `approvedWithoutScan`
   * OR `approvedWithUncoveredCategories`.
   */
  noScanReason?: string;
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
  /**
   * The app's EXPLICIT surface declaration from `app.yaml` (`surface: ui|api|both`),
   * when present. Intent wins over the heuristic: `resolveSurface` prefers this.
   */
  declaredSurface?: SurfaceDeclaration;
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
  /**
   * VERIFY-BEFORE-COMMIT outcome recorded on the commit (compile-gate.ts). A commit
   * that reaches the caller either COMPILED (`{ gated: true, ok: true }` — a red gate
   * throws before any write, so it never lands here) or was honestly passed through
   * ungated (`{ gated: false, reason }` — a legacy/non-Vite shape the gate cannot
   * check). Absent on scaffold/preview/deploy steps.
   */
  gate?: { gated: true; ok: true } | { gated: false; reason: string };
};
