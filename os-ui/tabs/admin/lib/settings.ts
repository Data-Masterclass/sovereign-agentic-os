/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Settings adapter — tenant-wide identity/SSO, branding/white-label, defaults,
 * localization (EN→DE), and integrations/notifications.
 *
 * SSO/identity is configured via Ory's secure flow: this stores only NON-SECRET
 * configuration (issuer URL, enabled flag, SCIM toggle). Client secrets go
 * through Ory + the secrets manager and never appear here — there is no field
 * for one.
 *
 * DURABILITY: the authoritative value lives in a globalThis-pinned singleton doc;
 * the OpenSearch mirror is best-effort write-through + hydrate-on-boot (same
 * pattern as lib/platform-admin/model-prices.ts). Without this, a pod roll reverted
 * every admin setting — promoteAsView / autonomousAgentsEnabled / codedAppsEnabled /
 * model roles / branding — to defaults while the audit row claimed it persisted.
 * The `*Enabled` flags keep their `false` default ONLY until an admin saves; once
 * saved they survive a redeploy. Kept free of `server-only`/Next imports so it stays
 * directly unit-testable.
 *
 * The os-mirror (and thus `config`, which reads env at module-eval) is loaded
 * LAZILY, on first hydrate/write — NOT at import. This module is imported by the
 * test-harness bootstrap (scripts/test-setup.mjs), and several tests set env vars
 * BEFORE importing anything that pulls in `config`; a static os-mirror import here
 * would freeze `config` too early and break that contract. Lazy load keeps this
 * adapter import-light while still fully durable.
 */
import type { OsMirror } from '@core/infra/os-mirror';

export type Settings = {
  sso: { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
  branding: { displayName: string; accent: string; whiteLabel: boolean };
  defaults: { domainTemplate: string; newUserRole: 'creator' | 'builder' };
  /** Tenant-wide currency (ISO-4217). The Strategy tab READS this to format
   * monetary metrics; it is never picked locally in Strategy. Default 'EUR'. */
  currency: string;
  localization: { locale: 'en' | 'de'; available: ('en' | 'de')[] };
  notifications: { email: string; backupFailure: boolean; costThreshold: boolean };
  // The default model ROLES the OS resolves at runtime. Each is a live LiteLLM
  // `model_name` (e.g. `sovereign-reasoning`); an EMPTY string means "unset —
  // fall back to the config.ts env default" (see lib/models/roles.ts). The panel
  // re-points ROLE→alias; it never rewrites the fixed LiteLLM aliases. `tools` is
  // the agent tool-calling model (default Qwen, for clean OpenAI tool_calls).
  modelRoles: { reasoning: string; standard: string; tools: string; embeddings: string };
  // COST ROUTING — when ON (default), surfaces whose output is STRICTLY VALIDATED
  // before use run the STANDARD model first and escalate to the reasoning model
  // ONLY on validation/parse failure (one escalation, then honest failure). The
  // validators are the quality gate, so this is safe by construction. OFF pins those
  // surfaces to the reasoning model directly (the pre-cost-routing behaviour). This
  // NEVER touches the agent PLAN phase or free-form surfaces with no validator —
  // those stay premium regardless (see lib/assistant/escalate.ts). Admin role pins
  // still decide the actual aliases each tier resolves to.
  standardFirstEscalation: boolean;
  // CODED (custom) APPS — the platform decision (os-ui 0.6.133). When OFF (the
  // DEFAULT), only DECLARATIVE (spec) no-code apps can be created; the coded path
  // (`kind:'code'` / image|runtime serveMode — the agent writes code + an image
  // build) is disabled everywhere (UI, API, MCP). The coded path
  // has been higher-risk and unstable, so we stand behind Declarative by default;
  // a PLATFORM admin (not a domain admin) may turn it back on. Fail-closed: the UI
  // is not the gate — createApp + the create route + the MCP surface all enforce it.
  codedAppsEnabled: boolean;
  // PROMOTE-AS-VIEW — the promotion model (os-ui 0.6.150). When OFF (the DEFAULT),
  // promote physically COPIES the owner's built gold/silver into the domain schema
  // (`CREATE OR REPLACE TABLE iceberg.<domain>.<layer>_<slug> AS SELECT * FROM
  // personal_<owner>…`) — today's behaviour, byte-for-byte. When ON, promote instead
  // publishes a governed VIEW (`CREATE OR REPLACE VIEW … AS SELECT * FROM
  // personal_<owner>…`) + the SAME domain grant/governance push: a view never drifts,
  // so demote is a DROP VIEW and reconcile/re-materialize become no-ops. The read path
  // is UNCHANGED (consumers still read `iceberg.<domain>.gold_<slug>`). Fail-closed:
  // a PLATFORM admin turns it on; NEW promotes under the flag are views, existing
  // table-promoted datasets are never migrated (each dataset records its own artifact).
  promoteAsView: boolean;
  // AUTONOMOUS AGENTS — the unattended-execution gate (os-ui 0.6.152). When OFF (the
  // DEFAULT), an agent system may still be RUN by hand (a human clicks Run), but the
  // UNATTENDED trigger paths — a cron schedule and the event/API trigger — are refused
  // BEFORE the team executes, with an honest "autonomous execution is disabled by
  // platform policy" (the CronJob keeps firing; each firing no-ops until re-enabled).
  // This is the safe default for a teaching tenant: nothing runs on its own until a
  // PLATFORM admin explicitly turns it on. Fail-closed: the gate lives at the run
  // entrypoint, not the UI — the scheduler + event receiver both consult it.
  autonomousAgentsEnabled: boolean;
};

const EMPTY_ROLES = { reasoning: '', standard: '', tools: '', embeddings: '' };

function defaults(): Settings {
  return {
    sso: { enabled: false, provider: 'ory', issuerUrl: '', scim: false },
    branding: { displayName: 'Sovereign Agentic OS', accent: '#2aa39b', whiteLabel: false },
    defaults: { domainTemplate: 'analytics', newUserRole: 'creator' },
    currency: 'EUR',
    localization: { locale: 'en', available: ['en', 'de'] },
    notifications: { email: 'admin@datamasterclass.com', backupFailure: true, costThreshold: true },
    modelRoles: { ...EMPTY_ROLES },
    standardFirstEscalation: true,
    codedAppsEnabled: false,
    promoteAsView: false,
    autonomousAgentsEnabled: false,
  };
}

// Authoritative value pinned to globalThis so every separately-bundled route
// handler shares ONE settings singleton (and it survives dev HMR). `hydration`
// dedupes the one-time load from the mirror. Same shape as model-prices.ts.
type SettingsState = { settings: Settings; hydration: Promise<void> | null };
const STATE_KEY = Symbol.for('soa.platform.settings');
function settingsState(): SettingsState {
  const g = globalThis as unknown as Record<symbol, SettingsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { settings: defaults(), hydration: null };
  return g[STATE_KEY]!;
}

const DOC_ID = '__settings__';

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/infra/os-mirror.ts. A missing index is CREATED, never mistaken for a dead
// mirror. Loaded lazily (see the module header) so importing this adapter never
// pulls `config` at eval time. Cached once per process on globalThis.
let mirrorPromise: Promise<OsMirror> | null = null;
async function getMirror(): Promise<OsMirror> {
  if (!mirrorPromise) {
    mirrorPromise = import('@core/infra/os-mirror').then(({ osMirror }) =>
      osMirror({
        index: 'os-settings',
        createBody: {
          mappings: {
            properties: {
              id: { type: 'keyword' },
              // The settings blob is nested config, stored but not field-indexed.
              settings: { type: 'object', enabled: false },
              updatedAt: { type: 'date' },
            },
          },
        },
      }),
    );
  }
  return mirrorPromise;
}

/**
 * Load the persisted settings once (from the mirror), merging over the safe
 * defaults so an older/partial stored doc never loses a newly-added field.
 * FAIL-SOFT: an unreachable mirror leaves the in-process defaults in place and
 * never throws. Idempotent + cached; callers await this before any sync read.
 */
export async function ensureHydrated(): Promise<void> {
  const s = settingsState();
  if (!s.hydration) s.hydration = hydrateSettings();
  return s.hydration;
}

async function hydrateSettings(): Promise<void> {
  const s = settingsState();
  const mirror = await getMirror();
  const doc = (await mirror.getDoc(DOC_ID)) as { settings?: unknown } | null;
  if (doc && doc.settings && typeof doc.settings === 'object') {
    // Merge THROUGH updateSettings' semantics so the stored partial only sets the
    // fields it carries (nil-safe): a stored doc from before a field existed keeps
    // that field at its current default rather than blanking it.
    s.settings = mergeSettings(defaults(), doc.settings as Record<string, unknown>);
  }
}

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

export function getSettings(): Settings {
  return settingsState().settings;
}

function writeThrough(next: Settings): void {
  const doc = { id: DOC_ID, settings: next, updatedAt: new Date().toISOString() };
  // Fire-and-forget: lazily resolve the mirror, then its own write-through queues +
  // heals. Never throws into the caller (matches os-mirror's best-effort contract).
  void getMirror().then((mirror) => mirror.writeThrough(DOC_ID, doc)).catch(() => {});
}

/** Deep-merge a patch over a base — the shared nil-safe merge (used by both the
 *  public write path and hydration, so stored + live semantics never drift). */
function mergeSettings(base: Settings, patch: Partial<Settings> & Record<string, unknown>): Settings {
  return {
    sso: { ...base.sso, ...(patch.sso ?? {}) },
    branding: { ...base.branding, ...(patch.branding ?? {}) },
    defaults: { ...base.defaults, ...(patch.defaults ?? {}) },
    currency: typeof patch.currency === 'string' && patch.currency ? patch.currency : base.currency,
    localization: { ...base.localization, ...(patch.localization ?? {}) },
    notifications: { ...base.notifications, ...(patch.notifications ?? {}) },
    modelRoles: { ...base.modelRoles, ...(patch.modelRoles ?? {}) },
    // Nil-safe: only a real boolean flips it; an absent/non-boolean patch keeps the
    // current value (defaults ON), so a partial settings PUT never silently disables
    // cost routing.
    standardFirstEscalation:
      typeof patch.standardFirstEscalation === 'boolean' ? patch.standardFirstEscalation : base.standardFirstEscalation,
    // Nil-safe (same pattern as standardFirstEscalation): only a REAL boolean flips
    // it; an absent/partial/garbage patch keeps the current value (default OFF), so a
    // partial settings PUT can never accidentally ENABLE the coded-app path.
    codedAppsEnabled: typeof patch.codedAppsEnabled === 'boolean' ? patch.codedAppsEnabled : base.codedAppsEnabled,
    // Nil-safe (same pattern as codedAppsEnabled): only a REAL boolean flips it; an
    // absent/partial/garbage patch keeps the current value (default OFF), so a partial
    // settings PUT can never accidentally switch promotion to the view model.
    promoteAsView: typeof patch.promoteAsView === 'boolean' ? patch.promoteAsView : base.promoteAsView,
    // Nil-safe (same pattern as promoteAsView): only a REAL boolean flips it; an
    // absent/partial/garbage patch keeps the current value (default OFF), so a partial
    // settings PUT can never accidentally ENABLE unattended agent execution.
    autonomousAgentsEnabled:
      typeof patch.autonomousAgentsEnabled === 'boolean' ? patch.autonomousAgentsEnabled : base.autonomousAgentsEnabled,
  };
}

/** Deep-merge a patch. Rejects any attempt to smuggle a raw secret field.
 *  The merged value is pinned in-process AND written through to the durable mirror
 *  so it survives a pod roll (the audit row the route writes is no longer a lie). */
export function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Settings {
  if ('ssoClientSecret' in patch || 'clientSecret' in patch || 'secret' in patch) {
    throw fail('Secrets are configured via Ory + the secrets manager, never here', 400);
  }
  const s = settingsState();
  s.settings = mergeSettings(s.settings, patch);
  writeThrough(s.settings);
  return s.settings;
}

/** The coded-apps platform flag (default OFF). The ONE read the create-gate + MCP
 *  surface consult so "coded apps disabled" is decided in exactly one place. */
export function codedAppsEnabled(): boolean {
  return settingsState().settings.codedAppsEnabled;
}

/** The promote-as-view platform flag (default OFF). The ONE read the publish path
 *  consults so "promote copies a table vs publishes a view" is decided in one place. */
export function promoteAsView(): boolean {
  return settingsState().settings.promoteAsView;
}

/** The autonomous-agents platform flag (default OFF). The ONE read the scheduler +
 *  event receiver consult so "may an agent run unattended" is decided in one place. */
export function autonomousAgentsEnabled(): boolean {
  return settingsState().settings.autonomousAgentsEnabled;
}

export function _reset(): void {
  const s = settingsState();
  s.settings = defaults();
  s.hydration = null;
  // Reset the mirror's probe state if it was already loaded (a fresh-process sim).
  if (mirrorPromise) void mirrorPromise.then((m) => m.__reset()).catch(() => {});
}

/** Test-only: set settings IN-MEMORY (nil-safe merge) WITHOUT touching the mirror.
 *  The test-harness bootstrap uses this to flip a flag without lazily importing
 *  os-mirror (→ `config`) — which would freeze `config` before env-before-import
 *  tests set their env vars. Production writes always go through updateSettings. */
export function __setForTests(patch: Partial<Settings> & Record<string, unknown>): Settings {
  const s = settingsState();
  s.settings = mergeSettings(s.settings, patch);
  return s.settings;
}
