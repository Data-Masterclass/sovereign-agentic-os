/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from './server';
import { fail, str, strArr, NO_ARGS, idArg } from './discovery-common';

// --- Governed connection lib functions (the EXACT same the UI + /api call) ------
// Only what THIS file's connection tools use; the warehouse/om/dataset imports that used
// to be copy-pasted here live in their own discovery-*-tools files.
import {
  listConnectionsForUser,
  getConnectionForUser,
  createConnection,
  testConnection,
  setConnectionArchived,
  deleteConnection,
  renameConnection,
  moveConnection,
  demoteConnection,
  updateCapabilities,
  CONNECTION_TEMPLATES,
  isPersonalConnectable,
  type ConnectionTemplateKey,
  type WarehouseCreateInput,
  type AirflowCreateInput,
  type AtlassianCreateInput,
  type ODataCreateInput,
  type WorkdayCreateInput,
} from '@/lib/connections';
import type { AirflowAuthType, AtlassianAuthKind, ODataAuthType, CapabilityMode } from '@/lib/connections/schema';
import { revokeActionAdoption } from '@/lib/connections/action-adoptions';
import { WAREHOUSE_PROVIDERS } from '@/lib/connections/warehouse/registry';
import { WAREHOUSE_PLATFORMS, type WarehousePlatform } from '@/lib/connections/warehouse/types';
import { promoteThroughSeam } from '@/lib/governance/ladder';
import { config } from '@/lib/core/config';

// ================================ CONNECTIONS =================================
// Connections becomes a real MCP tab. create/test are creator (the lib re-gates
// SHARED service-credential templates to Builder/Admin); promote is Builder+.
// ONE source of truth: the keys create_connection accepts are derived from the
// SAME CONNECTION_TEMPLATES registry the lib validates against (templateByKey).
const connectionTemplateKeys: ConnectionTemplateKey[] = CONNECTION_TEMPLATES.map((t) => t.key);

export const connectionTools: McpTool[] = [
  {
    name: 'list_connection_templates',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List what CAN be connected — the connection template catalog (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks): each template’s key, label, what it connects (Drive / Database / API / MCP / SaaS), whether it is PERSONAL (per-user OAuth — any user may connect their own account) or SHARED (service credentials — creating it needs a Builder/Admin), the endpoint hint, the fields create_connection needs, and the safe preset capability profile (reads on · writes opt-in · deletes blocked). Purpose: step 0 of the Connections golden path — know the catalog before you connect. Before: whoami. After: list_connections (reuse first!), then create_connection with a template key from here. Governance: read-only and identical for every role; this reads the SAME template registry create_connection validates against, so a key listed here is always accepted there (one source of truth).',
    inputSchema: NO_ARGS,
    call: async () => ({
      templates: CONNECTION_TEMPLATES
        // The `warehouse` template appears ONLY when the operator enabled external
        // connectors — otherwise it is hidden exactly like it is in the UI picker.
        .filter((t) => t.key !== 'warehouse' || config.externalConnectorsEnabled)
        // Same for the external `om-catalog` template — hidden until an operator
        // enables OPENMETADATA_CONNECT_ENABLED (Phase 1 default OFF).
        .filter((t) => t.key !== 'om-catalog' || config.openmetadataConnectEnabled)
        .map((t) => {
          const personal = isPersonalConnectable(t);
          return {
            key: t.key,
            label: t.label,
            connects: t.type,
            connector: t.connector,
            auth: t.auth,
            personal,
            minRoleToCreate: personal ? 'creator' : 'builder',
            endpointHint: t.endpointHint,
            requiredFields: ['name', 'template'],
            optionalFields: [
              'endpoint (defaults to the endpointHint)',
              `credential (the ${t.secretKey} — stored server-side, fingerprinted, never returned)`,
              'domain (one of YOUR domains; defaults to your first)',
            ],
            tools: t.tools.map((x) => ({ name: x.name, write: x.write, mode: x.mode })),
          };
        }),
      // The external-warehouse platforms + each provider's credential fields, so a
      // tools-only client can build the `warehouse` block for create_connection. Only
      // present when enabled; the field split (secret vs record) is provider-driven.
      warehouse: config.externalConnectorsEnabled
        ? {
            enabled: true,
            note: 'Create a warehouse connection with template="warehouse" and a warehouse block {platform, catalog, fields}. Fields render from the provider below; secret-keyed fields go to Secrets Manager, the rest onto the record. Live registration is an operator GitOps step (values.trino.externalCatalogs + rolling restart).',
            platforms: WAREHOUSE_PLATFORMS.flatMap((p) => {
              const pr = WAREHOUSE_PROVIDERS[p];
              if (!pr) return []; // platform registered in types but provider not yet wired
              return [{
                platform: pr.platform,
                label: pr.label,
                capabilities: pr.capabilities,
                fields: pr.credentialFields.map((f) => ({
                  key: f.key,
                  label: f.label,
                  required: f.required,
                  secret: pr.secretMaterial.secretKeys.includes(f.key),
                })),
                liveVerificationRequired: pr.liveVerificationRequired,
              }];
            }),
          }
        : { enabled: false as const },
      note: 'PERSONAL (per-user OAuth) templates are connectable by any user; SHARED (service-credential) templates require a Builder/Admin — create_connection re-gates this in the lib.',
    }),
  },
  {
    name: 'list_connections',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the connections you can see (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) — personal + shared. Path: step 1 (reuse!) of the Connections golden path (guide: sovereign-os://guide/path/connections). Before: whoami. After: get_connection, or create_connection only if nothing fits. Governance: read-only, DLS-scoped — you never see another user’s personal connection.',
    inputSchema: NO_ARGS,
    call: async (user) => listConnectionsForUser(user),
  },
  {
    name: 'get_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read one connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) you can see — template, endpoint, tier, sync state — NEVER the raw credential. Path: DISCOVERY for the Connections golden path. Before: list_connections. After: test_connection, or consume it from an app via use_connection BY REFERENCE. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_connection needs a `connId`', 400);
      return getConnectionForUser(id, user);
    },
  },
  {
    name: 'create_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Create a PERSONAL connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) via per-user OAuth. Path: step 2 of the Connections golden path. Before: list_connections (reuse first). After: test_connection, then Builder promote_connection to share. Governance: any user may connect a personal account; SHARED (service-credential) templates require a Builder/Admin (the lib re-gates). The credential is stored server-side—the model never sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name for the connection.' },
        template: { type: 'string', enum: connectionTemplateKeys, description: 'Connection template (adapter family).' },
        endpoint: { type: 'string', description: 'Endpoint/URL (defaults to the template hint).' },
        credential: { type: 'string', description: 'Secret/token — stored server-side, fingerprinted, never returned.' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        warehouse: {
          type: 'object',
          description: 'For template="warehouse" ONLY (external connectors must be enabled): the federation config. Secret-keyed fields go to Secrets Manager, the rest onto the record.',
          properties: {
            platform: { type: 'string', enum: [...WAREHOUSE_PLATFORMS], description: 'Warehouse platform (from list_connection_templates.warehouse.platforms).' },
            catalog: { type: 'string', description: 'Trino catalog name to mount as, e.g. glue_sales ([a-z_][a-z0-9_]*).' },
            fields: { type: 'object', description: 'Flat field map keyed by the provider credential-field keys (e.g. {region:"eu-central-1"}).' },
          },
          required: ['platform', 'catalog', 'fields'],
        },
        omService: {
          type: 'string',
          description: 'For template="om-catalog" ONLY (OpenMetadata connections must be enabled): the optional default OM Service name. The endpoint is the OM base URL; credential is the bot JWT.',
        },
        airflow: {
          type: 'object',
          description: 'For template="airflow" ONLY: the non-secret REST config. The endpoint is the Airflow base URL; credential is the Bearer token (or the Basic-auth password).',
          properties: {
            authType: { type: 'string', enum: ['basic', 'bearer'], description: 'How to authenticate (default bearer).' },
            username: { type: 'string', description: 'Basic-auth username (non-secret); omit for bearer.' },
            dagAllowlist: { type: 'array', items: { type: 'string' }, description: 'Optional DAG ids trigger_dag is bounded to (empty = any DAG).' },
          },
        },
        atlassian: {
          type: 'object',
          description: 'For template="atlassian" ONLY: the non-secret auth config. credential is the API token (Basic) or OAuth access token (Bearer). Basic auth REQUIRES the account email or the connection cannot authenticate.',
          properties: {
            authKind: { type: 'string', enum: ['basic', 'bearer'], description: 'basic = email + API token (default); bearer = OAuth 3LO access token.' },
            email: { type: 'string', description: 'Atlassian account email (non-secret); REQUIRED for basic, omit for bearer.' },
          },
        },
        odata: {
          type: 'object',
          description: 'For template="sap-odata" or "odata-v4" ONLY: the non-secret auth config. credential is user:password (Basic) or client_id:client_secret (OAuth-CC).',
          properties: {
            authType: { type: 'string', enum: ['basic', 'oauth-cc'], description: 'basic = communication user (default); oauth-cc = OAuth2 client-credentials.' },
            tokenUrl: { type: 'string', description: 'OAuth-CC token endpoint (non-secret); REQUIRED for oauth-cc, omit for basic.' },
          },
        },
        workday: {
          type: 'object',
          description: 'For template="workday-raas" ONLY: the RaaS report catalog. Each report IS an entity — a Workday connection has NO data until at least one report is registered here.',
          properties: {
            reports: {
              type: 'array',
              description: 'RaaS reports to register (each becomes an entity).',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Report path or full RaaS URL (required).' },
                  key: { type: 'string', description: 'Optional entity key (slugified; defaults from the path).' },
                  label: { type: 'string', description: 'Optional human label.' },
                  incrementalParam: { type: 'string', description: 'Optional prompt name for incremental (watermark) reads.' },
                },
                required: ['path'],
              },
            },
          },
        },
      },
      required: ['name', 'template'],
      examples: [
        { name: 'Ops MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/sse', credential: 'secret_xxx' },
        { name: 'Glue sales', template: 'warehouse', warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } } },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_connection needs a `name`', 400);
      const template = str(args.template) as ConnectionTemplateKey;
      if (!connectionTemplateKeys.includes(template)) fail('create_connection needs a valid `template`', 400);
      let warehouse: WarehouseCreateInput | undefined;
      if (template === 'warehouse') {
        const w = (args.warehouse ?? {}) as Record<string, unknown>;
        const platform = str(w.platform) as WarehousePlatform;
        if (!WAREHOUSE_PLATFORMS.includes(platform)) fail('warehouse connection needs a valid `warehouse.platform`', 400);
        const catalog = str(w.catalog).trim();
        const rawFields = (w.fields && typeof w.fields === 'object') ? (w.fields as Record<string, unknown>) : {};
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawFields)) fields[k] = str(v);
        warehouse = { platform, catalog, fields };
      }
      let airflow: AirflowCreateInput | undefined;
      if (template === 'airflow') {
        const a = (args.airflow ?? {}) as Record<string, unknown>;
        const authType = (str(a.authType) === 'basic' ? 'basic' : 'bearer') as AirflowAuthType;
        airflow = { authType, username: str(a.username) || undefined, dagAllowlist: strArr(a.dagAllowlist) };
      }
      let atlassian: AtlassianCreateInput | undefined;
      if (template === 'atlassian') {
        const a = (args.atlassian ?? {}) as Record<string, unknown>;
        const authKind = (str(a.authKind) === 'bearer' ? 'bearer' : 'basic') as AtlassianAuthKind;
        atlassian = { authKind, email: str(a.email) || undefined };
      }
      let odata: ODataCreateInput | undefined;
      if (template === 'sap-odata' || template === 'odata-v4') {
        const o = (args.odata ?? {}) as Record<string, unknown>;
        const authType = (str(o.authType) === 'oauth-cc' ? 'oauth-cc' : 'basic') as ODataAuthType;
        odata = { authType, tokenUrl: str(o.tokenUrl) || undefined };
      }
      let workday: WorkdayCreateInput | undefined;
      if (template === 'workday-raas') {
        const w = (args.workday ?? {}) as Record<string, unknown>;
        const rawReports = Array.isArray(w.reports) ? (w.reports as unknown[]) : [];
        workday = {
          reports: rawReports.map((r) => {
            const row = (r && typeof r === 'object') ? (r as Record<string, unknown>) : {};
            return {
              path: str(row.path),
              key: str(row.key) || undefined,
              label: str(row.label) || undefined,
              incrementalParam: str(row.incrementalParam) || undefined,
            };
          }),
        };
      }
      return createConnection(user, {
        name,
        template,
        endpoint: str(args.endpoint),
        credential: str(args.credential),
        domain: str(args.domain) || undefined,
        warehouse,
        omService: template === 'om-catalog' ? str(args.omService) || undefined : undefined,
        airflow,
        atlassian,
        odata,
        workday,
      });
    },
  },
  {
    name: 'test_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Test a connection you can see — returns live | offline + a detail string. Path: step 3 of the Connections golden path. Before: create_connection. After: Builder promote_connection, or consume it from an app. Governance: read-only probe under your identity; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id to test.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('test_connection needs a `connId`', 400);
      return testConnection(id, user);
    },
  },
  {
    name: 'promote_connection',
    tab: 'connections',
    minRole: 'domain_admin',
    description:
      'Promote a Personal connection → a SHARED domain data source (Domain admin+ only — the creator/builder lockdown). Path: step 4 of the Connections golden path. Before: create_connection + test_connection. After: apps in the domain consume it via use_connection BY REFERENCE. Governance: Domain admin/Admin; re-promoting an already-shared connection returns a conflict.',
    inputSchema: idArg('connId', 'Personal connection id you own to promote.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('promote_connection needs a `connId`', 400);
      // Route the flip through the ONE effect seam (never promoteConnection directly).
      const r = await promoteThroughSeam('connection', id, user);
      return getConnectionForUser(id, user).then((c) => ({ id: c.id, name: c.name, visibility: c.visibility, applied: r.applied, live: r.live }));
    },
  },
  {
    // MCP LIFECYCLE TWIN (m3): the archive/delete route's MCP peer. Archive is a
    // reversible soft-hide (the vault secret + OAuth token are KEPT so it reconnects with
    // no re-auth); delete PHYSICALLY tears down what the connection granted (exposures,
    // action adoptions, live Trino catalog) then purges the vault secret. Both are
    // edit-scoped in the lib exactly like the UI routes — no extra gate here.
    name: 'retire_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Retire a connection you can edit — `archive` (reversible soft-hide; secret + token KEPT so it reconnects with no re-auth) or `delete` (PHYSICAL: revoke its exposures + action adoptions, remove any live Trino catalog, purge the vault secret — irreversible). The MCP peer of the Connections archive/delete controls. Before: list_connections. Governance: edit-scoped in-lib (owner or the owning-domain admin); a delete returns the honest physical-teardown report.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Connection id from list_connections.' },
        mode: { type: 'string', enum: ['archive', 'unarchive', 'delete'], description: 'archive (default) | unarchive | delete.' },
      },
      required: ['connId'],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('retire_connection needs a `connId`', 400);
      const mode = str(args.mode) || 'archive';
      if (mode === 'delete') {
        const physical = await deleteConnection(id, user);
        return { id, deleted: physical.recordDeleted, physical: physical.physical };
      }
      if (mode !== 'archive' && mode !== 'unarchive') fail('retire_connection `mode` must be archive | unarchive | delete', 400);
      const c = await setConnectionArchived(id, user, mode === 'archive');
      return { id: c.id, name: c.name, archived: c.archived ?? false };
    },
  },
  {
    // MCP LIFECYCLE TWIN (m3): rename / move-to-folder / demote / capability-update — the
    // connection detail's configure controls as one governed tool. Each sub-action is
    // edit-scoped in the lib (demote/capabilities additionally require Builder+), so no
    // extra gate is added here — the lib is the authority.
    name: 'configure_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Configure a connection you can edit: `rename` (DISPLAY name only — the frozen physical identity is untouched), `move` (into a folder), `demote` (lower one tier: Certified→Shared→Personal — Builder+), or `capabilities` (set per-tool modes Off|Read|Write-approval|Write-bounded|Blocked + limits, recompiled into OPA — Builder+). The MCP peer of the connection detail controls. Before: get_connection. Governance: edit-scoped in-lib; demote/capabilities require a Builder/Admin.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Connection id from list_connections.' },
        action: { type: 'string', enum: ['rename', 'move', 'demote', 'capabilities'], description: 'Which configuration to apply.' },
        name: { type: 'string', description: 'For action="rename": the new display name.' },
        folder: { type: 'string', description: 'For action="move": the target folder path (empty = root).' },
        capabilities: {
          type: 'array',
          description: 'For action="capabilities": per-tool mode/limit updates.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name.' },
              mode: { type: 'string', enum: ['Off', 'Read', 'Write-approval', 'Write-bounded', 'Blocked'], description: 'Capability mode.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['connId', 'action'],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('configure_connection needs a `connId`', 400);
      const action = str(args.action);
      if (action === 'rename') {
        const c = await renameConnection(id, user, str(args.name));
        return { id: c.id, name: c.name };
      }
      if (action === 'move') {
        const c = moveConnection(id, user, str(args.folder));
        return { id: c.id, folder: c.folder ?? null };
      }
      if (action === 'demote') {
        const c = await demoteConnection(id, user);
        return { id: c.id, visibility: c.visibility };
      }
      if (action === 'capabilities') {
        const raw = Array.isArray(args.capabilities) ? (args.capabilities as unknown[]) : [];
        const updates = raw.map((u) => {
          const row = (u && typeof u === 'object') ? (u as Record<string, unknown>) : {};
          return { name: str(row.name), mode: (row.mode ? str(row.mode) : undefined) as CapabilityMode | undefined };
        }).filter((u) => u.name);
        if (updates.length === 0) fail('configure_connection action="capabilities" needs at least one {name, mode}', 400);
        const c = await updateCapabilities(id, user, updates);
        return { id: c.id, tools: c.tools.map((t) => ({ name: t.name, mode: t.mode })) };
      }
      fail('configure_connection `action` must be rename | move | demote | capabilities', 400);
    },
  },
  {
    // MCP peer of the exposure-panel's "revoke adopted actions" (m3). Revoking an action
    // adoption removes a domain's write-action grant on an exposed operational entity; the
    // four-layer intersection re-keys immediately. Domain-admin of the adoption's domain.
    name: 'revoke_action_adoption',
    tab: 'connections',
    minRole: 'domain_admin',
    description:
      'Revoke a domain’s adoption of an exposed operational entity’s WRITE actions (⛔ domain_admin of the adoption’s domain). After this the domain can no longer arm those actions and the action intersection re-keys. The MCP peer of the expose panel’s revoke control. Governance: re-gated in-lib to a domain admin of the adoption’s domain (or Admin).',
    inputSchema: {
      type: 'object',
      properties: { adoptionId: { type: 'string', description: 'The action-adoption id to revoke.' } },
      required: ['adoptionId'],
    },
    call: async (user, args) => {
      const id = str(args.adoptionId).trim();
      if (!id) fail('revoke_action_adoption needs an `adoptionId`', 400);
      const a = await revokeActionAdoption(id, user);
      return { adoptionId: a.id, revoked: a.revoked };
    },
  },
];

// External-warehouse tools — registered ONLY when the operator enabled external
// connectors. `warehouse_registration` returns the GitOps values snippet an operator
// applies to register the catalog in Trino (read-only-rootfs → no runtime catalog
// creation); `import_warehouse_table` materializes one federated table into the OS
// Iceberg lakehouse via the SAME governed CTAS path promote/materialize uses.
