/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Hermes-profile provisioner (hermes-agent-integration-plan.md §7).
 *
 * Given (user, domain) + a safety preset, produce the Hermes gateway PROFILE
 * config — the exact input a Hermes profile needs — mapping our two-mode
 * governance table to Hermes settings EXACTLY per the plan:
 *
 *   In-tab assistant      → approvals.mode: manual ; read/propose tools
 *   Autonomous read-only  → approvals.mode: manual ; read tools only ; cron_mode: deny
 *   Autonomous read+propose → approvals.mode: manual ; writes proposed
 *   Autonomous bounded    → approvals.mode: smart  ; curated tools + command_allowlist
 *   Autonomous full-scope → approvals.mode: smart  ; domain-scoped tools
 *
 * ALWAYS-ON FLOORS (independent of preset, the no-bypass invariant): the model is
 * reached ONLY via LiteLLM (direct provider keys disabled); the Platform MCP is
 * the ONLY tool surface and every call is still OPA-gated; a real container/microVM
 * sandbox (never host/off); egress allowlist + Hermes website_blocklist + SSRF
 * fail-closed; `allow_lazy_installs: false`; secrets come from the secrets manager
 * (refs, never plaintext ~/.hermes/.env). Out-of-policy tool calls are OPA-denied
 * and queued to the Governance inbox (enforced at the boundary, not here).
 *
 * PURE module (no server-only, no network) so the mapping is unit-tested directly;
 * the API route/chart wire the real secrets, MCP URL and sandbox RuntimeClass.
 */

import type { SafetyPreset } from '../governance.ts';

/** A Platform-MCP tool as the provisioner sees it (name + whether it writes). */
export type ToolDescriptor = { name: string; write: boolean };

/** Hermes approvals.mode — we NEVER emit `off` (that would remove the human floor). */
export type HermesApprovalMode = 'manual' | 'smart';

/** The "who + where" a profile is scoped to — one profile per (user, domain). */
export type ProfileIdentity = {
  /** The user's stable id (Ory subject); the agent runs AS this user. */
  user: string;
  /** The single domain this profile is scoped to (RLS unit). */
  domain: string;
};

/** How the Platform MCP is authenticated from inside the Hermes profile. */
export type McpAuth =
  | { kind: 'oauth'; /** Ory OAuth 2.1 bearer — the user's delegated token ref. */ tokenRef: string }
  | { kind: 'mtls'; /** Service-agent mutual TLS — cert/key secret refs. */ certRef: string; keyRef: string };

export type HermesModelConfig = {
  /** OpenAI-compatible base URL — ALWAYS LiteLLM, never a provider endpoint. */
  litellmBaseUrl: string;
  /** The tool-calling model_name served behind LiteLLM (Hermes 4.3 tier). */
  model: string;
  /** Secret ref for the LiteLLM virtual key (scoped, least-privilege). */
  apiKeyRef: string;
  /** MUST be empty — direct provider keys are disabled so it cannot go off-gateway. */
  providerKeys: Record<string, never>;
};

export type HermesMcpServer = {
  name: string;
  transport: 'http';
  url: string;
  auth: McpAuth;
  /** Only these tools are visible to the profile (per-preset whitelist). */
  toolsInclude: string[];
};

export type HermesSandboxConfig = {
  /** Kernel-isolated backend. NEVER 'off' / host-local / YOLO. */
  backend: 'container';
  /** The K8s RuntimeClass the sandbox pod runs under (kata default / gvisor). */
  runtimeClass: string;
};

/** The preset space: the four autonomous presets plus the in-tab assistant mode. */
export type ProfilePreset = SafetyPreset | 'in-tab';

export type HermesProfile = {
  profileId: string;
  identity: ProfileIdentity;
  preset: ProfilePreset;
  approvals: { mode: HermesApprovalMode; timeout_fail_closed: true };
  /** Deny scheduled/cron autonomy for read-only (no unattended writes possible). */
  cron_mode: 'allow' | 'deny';
  model: HermesModelConfig;
  mcpServers: HermesMcpServer[];
  /** Shell commands the profile may run in its sandbox (never a wildcard). */
  command_allowlist: string[];
  sandbox: HermesSandboxConfig;
  security: {
    allow_lazy_installs: false;
    /** Domains the profile may reach (egress allowlist); everything else denied. */
    egress_allowlist: string[];
    /** Hermes website_blocklist — the always-on hardline floor. */
    website_blocklist: string[];
    /** SSRF protection blocks RFC1918/loopback/link-local/metadata, fail-closed. */
    ssrf_protection: true;
    /** Hardline command blocklist — always-on regardless of allowlist. */
    hardline_blocklist: string[];
  };
  /** Secrets are mounted from the secrets manager — never plaintext .env. */
  secretsSource: 'secrets-manager';
};

/** Approvals mode per preset (in-tab & manual-review presets → manual; autonomous bounded/full → smart). */
const APPROVAL_MODE: Record<ProfilePreset, HermesApprovalMode> = {
  'in-tab': 'manual',
  'read-only': 'manual',
  'read-propose': 'manual',
  'read-bounded': 'smart',
  'full-in-scope': 'smart',
};

/** Always-on hardline command blocklist (never runnable, any preset). */
export const HARDLINE_BLOCKLIST: string[] = [
  'rm -rf /',
  ':(){ :|:& };:', // fork bomb
  'curl | sh',
  'wget | sh',
  'sudo',
  'chmod -R 777 /',
  'mkfs',
  'dd if=/dev/zero',
];

/** Default website blocklist floor (extended by tenant policy). */
export const DEFAULT_WEBSITE_BLOCKLIST: string[] = [
  '169.254.169.254', // cloud metadata
  'metadata.google.internal',
  'localhost',
  '127.0.0.1',
];

/** Curated shell commands allowed for the bounded/full autonomous sandbox. */
const CURATED_COMMANDS: string[] = ['python3', 'node', 'ls', 'cat', 'grep', 'jq'];

export type ProvisionInput = {
  identity: ProfileIdentity;
  preset: ProfilePreset;
  /** The Platform-MCP tools available to this domain (the ceiling). */
  availableTools: ToolDescriptor[];
  model: HermesModelConfig;
  mcp: { url: string; auth: McpAuth; serverName?: string };
  /** RuntimeClass chosen by the sandbox selector (kata/gvisor) — never host/off. */
  runtimeClass: string;
  /** Egress allowlist (the LiteLLM + MCP + proxy hosts) — non-empty. */
  egressAllowlist: string[];
  /** Extra website-blocklist entries on top of the floor. */
  websiteBlocklist?: string[];
  /** Extra command-allowlist entries for bounded/full presets. */
  extraCommands?: string[];
};

/** True if the preset permits ANY write-capable tool to be exposed at all. */
function presetExposesWrites(preset: ProfilePreset): boolean {
  return preset !== 'read-only';
}

/**
 * Filter the domain's available tools down to what the preset may SEE
 * (tools.include). read-only drops every write tool; every other preset keeps
 * writes (their run-time behaviour — propose vs bounded vs approval — is enforced
 * by the OPA boundary + `resolveAutonomous`, not by hiding the tool).
 */
export function toolsIncludeForPreset(preset: ProfilePreset, available: ToolDescriptor[]): string[] {
  const keep = presetExposesWrites(preset) ? available : available.filter((t) => !t.write);
  return keep.map((t) => t.name);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Build a fully-governed Hermes profile from (user, domain) + preset. */
export function buildHermesProfile(input: ProvisionInput): HermesProfile {
  const { identity, preset } = input;
  const toolsInclude = toolsIncludeForPreset(preset, input.availableTools);
  const bounded = preset === 'read-bounded' || preset === 'full-in-scope';

  return {
    profileId: `hermes-${slug(identity.user)}-${slug(identity.domain)}`,
    identity,
    preset,
    approvals: { mode: APPROVAL_MODE[preset], timeout_fail_closed: true },
    // read-only never runs unattended writes → deny cron autonomy entirely.
    cron_mode: preset === 'read-only' ? 'deny' : 'allow',
    model: { ...input.model, providerKeys: {} },
    mcpServers: [
      {
        name: input.mcp.serverName ?? 'platform-mcp',
        transport: 'http',
        url: input.mcp.url,
        auth: input.mcp.auth,
        toolsInclude,
      },
    ],
    command_allowlist: bounded ? [...CURATED_COMMANDS, ...(input.extraCommands ?? [])] : [],
    sandbox: { backend: 'container', runtimeClass: input.runtimeClass },
    security: {
      allow_lazy_installs: false,
      egress_allowlist: [...input.egressAllowlist],
      website_blocklist: [...DEFAULT_WEBSITE_BLOCKLIST, ...(input.websiteBlocklist ?? [])],
      ssrf_protection: true,
      hardline_blocklist: [...HARDLINE_BLOCKLIST],
    },
    secretsSource: 'secrets-manager',
  };
}

/** A single no-bypass violation found by {@link assertNoBypass}. */
export type NoBypassViolation = { property: string; detail: string };

/**
 * Verify the no-bypass invariant on a built profile. Returns [] when the profile
 * cannot sidestep governance; otherwise the list of violations (the provisioner
 * route refuses to ship a profile with any). This is the machine-checkable form
 * of the plan's "nothing bypasses OPA / LiteLLM / the egress allowlist".
 */
export function assertNoBypass(p: HermesProfile): NoBypassViolation[] {
  const v: NoBypassViolation[] = [];
  // 1. Model ONLY via LiteLLM; no direct provider keys.
  if (!p.model.litellmBaseUrl) v.push({ property: 'litellm', detail: 'model base URL is not LiteLLM' });
  if (/api\.openai\.com|anthropic\.com|googleapis\.com/i.test(p.model.litellmBaseUrl)) {
    v.push({ property: 'litellm', detail: 'base URL points at a provider, not LiteLLM' });
  }
  if (Object.keys(p.model.providerKeys).length > 0) {
    v.push({ property: 'provider-keys', detail: 'direct provider keys are set — off-gateway model calls possible' });
  }
  // 2. Tools ONLY via the Platform MCP (HTTP), authed.
  if (p.mcpServers.length === 0) v.push({ property: 'mcp', detail: 'no Platform MCP server bound — no governed tools' });
  for (const s of p.mcpServers) {
    if (s.transport !== 'http') v.push({ property: 'mcp', detail: `MCP ${s.name} is not HTTP-transport` });
    if (!s.auth) v.push({ property: 'mcp-auth', detail: `MCP ${s.name} is unauthenticated` });
  }
  // 3. Real kernel-isolated sandbox — never host/off.
  if (p.sandbox.backend !== 'container') v.push({ property: 'sandbox', detail: 'sandbox backend is not a container/microVM' });
  if (!p.sandbox.runtimeClass || /^(off|host|yolo|local)$/i.test(p.sandbox.runtimeClass)) {
    v.push({ property: 'sandbox', detail: `runtimeClass '${p.sandbox.runtimeClass}' is host-local/off — forbidden` });
  }
  // 4. Egress allowlist + website blocklist + SSRF + lazy-installs off.
  if (p.security.allow_lazy_installs !== false) v.push({ property: 'lazy-installs', detail: 'lazy installs are enabled' });
  if (p.security.egress_allowlist.length === 0) v.push({ property: 'egress', detail: 'egress allowlist is empty (fail-open)' });
  if (p.security.ssrf_protection !== true) v.push({ property: 'ssrf', detail: 'SSRF protection is off' });
  if (p.security.hardline_blocklist.length === 0) v.push({ property: 'hardline', detail: 'hardline command blocklist is empty' });
  // 5. Secrets from the manager, never plaintext.
  if (p.secretsSource !== 'secrets-manager') v.push({ property: 'secrets', detail: 'secrets are not sourced from the secrets manager' });
  // 6. Human floor is never removed (mode is never `off`).
  if (p.approvals.mode !== 'manual' && p.approvals.mode !== 'smart') {
    v.push({ property: 'approvals', detail: `approvals.mode '${p.approvals.mode}' removes the human floor` });
  }
  return v;
}
