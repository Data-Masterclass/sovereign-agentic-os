/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Connections golden path — the pure, client-safe model.
 *
 * A Connection is a governed bridge to a system outside (or inside) the platform
 * — an API, MCP server, Database or SaaS. Whatever the type, it is
 * `credentials + endpoint metadata + a set of governed tools`, never a raw pipe.
 *
 * This module is PURE TYPES + presets only (no secrets, no server imports), so
 * both the client capability-editor and the server routes import it. The secret
 * itself never lives here (or in any record) — only a reference. The in-process
 * capability-profile MIRROR + the offline OPA gate live in `lib/agent-governed.ts`
 * (the governed spine), exactly as the spec asks ("compile the profile into the
 * connection's OPA policy; ALSO honor it in the offline mirror").
 */

import type { Visibility } from '@/lib/artifact-model';

export type ConnectionType = 'API' | 'MCP' | 'Database' | 'SaaS';

/**
 * Per-operation capability mode (least-privilege by default). Default for a blank
 * connection: reads on, writes off. Write-back is opt-in and per-tool.
 */
export type CapabilityMode = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';

export const CAPABILITY_MODES: CapabilityMode[] = [
  'Off',
  'Read',
  'Write-approval',
  'Write-bounded',
  'Blocked',
];

export const MODE_HELP: Record<CapabilityMode, string> = {
  Off: 'Not exposed at all (default for anything not needed).',
  Read: 'Read-only; safe, auto-allowed.',
  'Write-approval': 'Side-effecting; each call held for human approval (Governance tab).',
  'Write-bounded': 'Allowed only within explicit limits encoded as policy (amounts, scope).',
  Blocked: 'Explicitly forbidden (e.g. delete); needs an Admin override to enable.',
};

/** Per-tool limits compiled into the connection's OPA policy. */
export type CapabilityLimits = {
  /** Which objects/fields/records — e.g. "Sales domain accounts". */
  dataScope?: string;
  /** Rate / quota cap (calls per minute). */
  rateLimitPerMin?: number;
  /** Cost cap in USD for the tool. */
  costCapUsd?: number;
  /** Argument constraint for bounded writes — e.g. update amount ≤ maxAmount (€). */
  maxAmount?: number;
  /** Free-form note describing any further argument constraints. */
  argConstraints?: string;
};

export type ConnectionTool = {
  name: string;
  description: string;
  /** write tools side-effect the external system; read tools are side-effect-free. */
  write: boolean;
  mode: CapabilityMode;
  limits?: CapabilityLimits;
};

/** A tool is exposed (visible to an agent) only when enabled and in-scope. */
export function isExposed(t: { mode: CapabilityMode }): boolean {
  return t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded';
}

export type ConnectionGrant = {
  /** The agent identity (LiteLLM key / Ory principal) this connection is granted to. */
  agent: string;
  /** A grant can only FURTHER RESTRICT, never broaden. */
  scope: 'read-only' | 'full';
  /** The exact tool names the agent may call (intersection with the profile). */
  tools: string[];
  grantedBy: string;
  at: string;
};

export type SecretRef = { name: string; key: string };

export type Connection = {
  id: string;
  name: string;
  type: ConnectionType;
  template: ConnectionTemplateKey;
  /** Endpoint metadata (URL / MCP server) — never the secret. */
  endpoint: string;
  /** OPA/LiteLLM principal the connection's governed tools run as. */
  principal: string;
  owner: string;
  domain: string;
  visibility: Visibility;
  /** 'live' when the endpoint was reachable at test time; 'offline' otherwise. */
  mode: 'live' | 'offline' | 'untested';
  /** Reference into Secrets Manager — NEVER the secret value. */
  secretRef: SecretRef;
  /** Whether a credential was written to Secrets Manager for this connection. */
  secretSet: boolean;
  /** A non-reversible fingerprint of the stored secret (for display/audit only). */
  secretFingerprint: string;
  /** Egress guardrail status for an external endpoint. */
  egress: { external: boolean; host: string; allowed: boolean };
  /** The capability profile — the per-tool modes + limits. */
  tools: ConnectionTool[];
  /** Per-agent grants (restrict-only). */
  grants: ConnectionGrant[];
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------------- Capability presets --

export type ConnectionTemplateKey =
  | 'notion-mcp'
  | 'salesforce-api'
  | 'generic-mcp'
  | 'generic-api'
  | 'database'
  | 'saas';

export type ConnectionTemplate = {
  key: ConnectionTemplateKey;
  label: string;
  type: ConnectionType;
  /** Example endpoint placeholder shown in the UI. */
  endpointHint: string;
  /** Secrets Manager key the credential is stored under. */
  secretKey: string;
  /**
   * The SAFE PRESET capability profile (an Open Decision in the spec: ship a
   * sensible default profile per connector type so Builders start safe). Reads
   * on; writes opt-in per the worked examples; deletes Blocked.
   */
  tools: ConnectionTool[];
};

export const CONNECTION_TEMPLATES: ConnectionTemplate[] = [
  {
    key: 'notion-mcp',
    label: 'Notion (MCP server)',
    type: 'MCP',
    endpointHint: 'https://mcp.notion.com/sse',
    secretKey: 'mcp-token',
    tools: [
      { name: 'notion_search', description: 'Search pages and databases (read).', write: false, mode: 'Read' },
      { name: 'notion_get_page', description: 'Fetch one page by id (read).', write: false, mode: 'Read' },
      {
        name: 'notion_create_page',
        description: 'Create a page (write).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'one workspace', rateLimitPerMin: 10 },
      },
      { name: 'notion_delete_page', description: 'Delete a page (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'salesforce-api',
    label: 'Salesforce (REST API)',
    type: 'API',
    endpointHint: 'https://yourorg.my.salesforce.com',
    secretKey: 'oauth-token',
    tools: [
      { name: 'read_account', description: 'Read an account (read).', write: false, mode: 'Read', limits: { dataScope: 'Sales domain accounts' } },
      { name: 'read_opportunity', description: 'Read an opportunity (read).', write: false, mode: 'Read', limits: { dataScope: 'Sales domain opportunities' } },
      {
        name: 'update_opportunity_amount',
        description: 'Update an opportunity amount (write).',
        write: true,
        mode: 'Write-bounded',
        limits: { maxAmount: 50000, dataScope: 'Sales domain opportunities', rateLimitPerMin: 5, costCapUsd: 1 },
      },
      { name: 'mass_update', description: 'Bulk update many records (write).', write: true, mode: 'Off' },
      { name: 'delete_record', description: 'Delete a record (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'generic-mcp',
    label: 'Generic MCP server',
    type: 'MCP',
    endpointHint: 'https://mcp.example.com/sse',
    secretKey: 'mcp-token',
    tools: [
      { name: 'search', description: 'Search (read).', write: false, mode: 'Read' },
      { name: 'fetch', description: 'Fetch a resource (read).', write: false, mode: 'Read' },
      { name: 'create', description: 'Create a resource (write).', write: true, mode: 'Off' },
      { name: 'delete', description: 'Delete a resource (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'generic-api',
    label: 'Generic REST / GraphQL API',
    type: 'API',
    endpointHint: 'https://api.example.com',
    secretKey: 'bearer-token',
    tools: [
      { name: 'get', description: 'GET a resource (read).', write: false, mode: 'Read' },
      { name: 'list', description: 'List resources (read).', write: false, mode: 'Read' },
      { name: 'post', description: 'POST/create a resource (write).', write: true, mode: 'Off' },
      { name: 'delete', description: 'DELETE a resource (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'database',
    label: 'Database (Postgres, etc.)',
    type: 'Database',
    endpointHint: 'postgres://db.example.com:5432/app',
    secretKey: 'db-password',
    tools: [
      { name: 'query', description: 'Governed read query (read).', write: false, mode: 'Read', limits: { dataScope: 'allowlisted tables' } },
      { name: 'write_row', description: 'Insert/update a row (write).', write: true, mode: 'Off' },
      { name: 'drop_table', description: 'Drop a table (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'saas',
    label: 'Packaged SaaS integration',
    type: 'SaaS',
    endpointHint: 'https://app.example-saas.com/api',
    secretKey: 'api-key',
    tools: [
      { name: 'read', description: 'Read records (read).', write: false, mode: 'Read' },
      { name: 'create', description: 'Create a record (write).', write: true, mode: 'Off' },
      { name: 'delete', description: 'Delete a record (write).', write: true, mode: 'Blocked' },
    ],
  },
];

export function templateByKey(key: string): ConnectionTemplate | undefined {
  return CONNECTION_TEMPLATES.find((t) => t.key === key);
}

export const CONNECTION_TYPES: ConnectionType[] = ['API', 'MCP', 'Database', 'SaaS'];
