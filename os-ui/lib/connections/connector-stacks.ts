/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Vendor-stack taxonomy for the Supported Connectors gallery.
 *
 * Each CONNECTION_TEMPLATES key maps to exactly one StackId; the `vendorStack`
 * function is the single source of truth. Warehouse provider platforms (bigquery,
 * snowflake, databricks-delta, fabric, glue) are also mapped so warehouse cards
 * can be bucketed by stack in the gallery.
 *
 * Accents are muted/desaturated brand colours — used ONLY as a thin left-border
 * and a small dot chip. The card surface stays neutral.
 */

export type StackId =
  | 'microsoft'
  | 'google'
  | 'aws'
  | 'databricks'
  | 'snowflake'
  | 'salesforce'
  | 'atlassian'
  | 'opensource'
  | 'other';

export type Stack = {
  id: StackId;
  label: string;
  /** Muted brand accent — used for a 3px left-border and a small dot only. */
  accent: string;
};

export const STACKS: Stack[] = [
  { id: 'microsoft',  label: 'Microsoft',    accent: '#0078D4' },
  { id: 'google',     label: 'Google',       accent: '#4285F4' },
  { id: 'aws',        label: 'AWS',          accent: '#E8891A' },   // muted from #FF9900
  { id: 'databricks', label: 'Databricks',   accent: '#D4401A' },   // muted from #FF3621
  { id: 'snowflake',  label: 'Snowflake',    accent: '#29B5E8' },
  { id: 'salesforce', label: 'Salesforce',   accent: '#0096C7' },   // muted from #00A1E0
  { id: 'atlassian',  label: 'Atlassian',    accent: '#0052CC' },
  { id: 'opensource', label: 'Open source',  accent: '#3FB950' },
  { id: 'other',      label: 'Other',        accent: '#8B9299' },
];

/** Map from CONNECTION_TEMPLATES key → StackId (most reliable; no label-matching). */
const TEMPLATE_STACK: Record<string, StackId> = {
  // Microsoft
  'onedrive':            'microsoft',
  'outlook':             'microsoft',
  'teams':               'microsoft',
  'entra':               'microsoft',
  'purview':             'microsoft',
  'ai-foundry':          'microsoft',
  // Google
  'gdrive':              'google',
  'gmail':               'google',
  'gcal':                'google',
  'gcp-identity':        'google',
  'gcp-directory':       'google',
  // AWS
  'sagemaker':           'aws',
  // Snowflake
  'snowflake-governance':'snowflake',
  // Salesforce
  'salesforce-api':      'salesforce',
  // Atlassian
  'atlassian':           'atlassian',
  // Open source / self-hosted
  'notion-mcp':          'opensource',
  'database':            'opensource',
  'om-catalog':          'opensource',
  'airflow':             'opensource',
  'github':              'opensource',
  'supabase':            'opensource',
  'slack':               'opensource',
  // Other (generic / unmatched)
  'generic-mcp':         'other',
  'generic-api':         'other',
  'warehouse':           'other',
};

/**
 * Map from warehouse provider platform → StackId. Used so individual warehouse
 * provider cards (bigquery, snowflake, fabric, etc.) land in the right vendor section
 * rather than "Other".
 */
const WAREHOUSE_PLATFORM_STACK: Record<string, StackId> = {
  'bigquery':         'google',
  'snowflake':        'snowflake',
  'databricks-delta': 'databricks',
  'fabric':           'microsoft',
  'glue':             'aws',
};

/**
 * Return the StackId for a connector-template key.
 * Falls back to 'other' so nothing is ever orphaned.
 */
export function vendorStack(templateKey: string): StackId {
  return TEMPLATE_STACK[templateKey] ?? 'other';
}

/**
 * Return the StackId for a warehouse provider platform key.
 * Falls back to 'other' so nothing is ever orphaned.
 */
export function warehousePlatformStack(platform: string): StackId {
  return WAREHOUSE_PLATFORM_STACK[platform] ?? 'other';
}

/** Convenience: look up the full Stack object for a template key. */
export function stackForTemplate(templateKey: string): Stack {
  const id = vendorStack(templateKey);
  return STACKS.find((s) => s.id === id) ?? STACKS[STACKS.length - 1];
}
