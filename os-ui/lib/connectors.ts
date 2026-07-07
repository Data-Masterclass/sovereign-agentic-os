/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The connectors the Connections surface actually offers today — the three that
 * are genuinely wired end-to-end. Registering one stores the user's token in the
 * secrets store (never the browser) as a reference, and shares *use* — never the
 * secret — under OPA policy. This catalog is the honest "what you can connect"
 * half; there are no roadmap/placeholder entries. Each maps to a real connection
 * template (`lib/connection-model.ts`) you connect from the Governed connections
 * tab. Keep this list in lock-step with `USER_FACING_TEMPLATE_KEYS`.
 */

export type ConnectorCategory = 'Files' | 'Workspace';

export type Connector = {
  name: string;
  category: ConnectorCategory;
  /** Whether a driver/integration ships in this deployment (all true — honest catalog). */
  available: boolean;
  auth: string; // credential type held in the secrets store
  /** The connection template this connector connects via (Governed connections tab). */
  template: 'gdrive' | 'onedrive' | 'notion-mcp';
};

export const CONNECTORS: Connector[] = [
  { name: 'Google Drive', category: 'Files', available: true, auth: 'personal OAuth (read-only)', template: 'gdrive' },
  { name: 'Microsoft OneDrive', category: 'Files', available: true, auth: 'personal OAuth (read-only)', template: 'onedrive' },
  { name: 'Notion', category: 'Workspace', available: true, auth: 'personal OAuth · hosted MCP', template: 'notion-mcp' },
];

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = ['Files', 'Workspace'];
