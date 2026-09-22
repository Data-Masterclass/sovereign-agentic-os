/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Connector visual identity — the monogram + per-service accent + plain-language
 * value line that turn the connector gallery from a technical list into a showcase.
 *
 * NO trademarked logos: each connector gets a refined MONOGRAM (one or two letters,
 * consistent geometry) tinted with a per-service accent hue. Curated entries cover the
 * connectors this deployment ships; anything unmapped derives an honest monogram from
 * the label's initials and a stable accent hashed from its key — so a new template that
 * the API starts returning gets a sensible identity on its own, never a blank tile.
 *
 * This is pure data + string math (no React, no fetch) so the gallery, the detail
 * header and any future surface can share ONE identity vocabulary.
 */

/** A connector's presentation identity — everything a tile/header needs to look considered. */
export type ConnectorIdentity = {
  /** 1–2 uppercase letters drawn in the monogram mark. */
  monogram: string;
  /** Per-service accent hue (hex) — the monogram fill tint + tile hairline. */
  accent: string;
  /** One plain-language line: what this connector does for the business. */
  value: string;
};

/**
 * Curated identities, keyed on the CONNECTION_TEMPLATES key (most reliable — no
 * label matching). Accents are the muted brand hues used across the OS gallery.
 * `value` leads with the business outcome; protocol/technical detail is demoted to
 * the tile's secondary meta line, never the headline.
 */
const CURATED: Record<string, ConnectorIdentity> = {
  // Google
  'gdrive':       { monogram: 'GD', accent: '#4285F4', value: 'Bring your Google Drive files in — index them for search and agents.' },
  'gmail':        { monogram: 'GM', accent: '#EA4335', value: 'Read and act on Gmail under policy — triage, draft, and follow up.' },
  'gcal':         { monogram: 'GC', accent: '#4285F4', value: 'See and manage your Google Calendar — schedule and check availability.' },
  'gcp-identity': { monogram: 'GI', accent: '#34A853', value: 'Govern Google Cloud identity and IAM from one place.' },
  'gcp-directory':{ monogram: 'GW', accent: '#34A853', value: 'Manage your Google Workspace directory — people, groups, access.' },
  // Microsoft
  'onedrive':     { monogram: 'OD', accent: '#0078D4', value: 'Bring your OneDrive files in — index them for search and agents.' },
  'outlook':      { monogram: 'OL', accent: '#0078D4', value: 'Read and act on Outlook mail under policy — triage and reply.' },
  'teams':        { monogram: 'TM', accent: '#5059C9', value: 'Post to and read Microsoft Teams — keep the room in the loop.' },
  'entra':        { monogram: 'EN', accent: '#0078D4', value: 'Govern Microsoft Entra ID — users, groups, sign-in access.' },
  'purview':      { monogram: 'PV', accent: '#0078D4', value: 'Pull Microsoft Purview governance and catalog signals.' },
  'ai-foundry':   { monogram: 'AF', accent: '#0078D4', value: 'Reach your Azure AI Foundry models and deployments.' },
  // Salesforce
  'salesforce-api':{ monogram: 'SF', accent: '#0096C7', value: 'Work your Salesforce CRM — accounts, opportunities, records, under policy.' },
  // Kajabi
  'kajabi-api':   { monogram: 'KJ', accent: '#4A55C7', value: 'Reach your Kajabi audience, offers and revenue.' },
  // Operational systems
  'sap-odata':    { monogram: 'SP', accent: '#1A6FB5', value: 'Connect SAP S/4HANA Cloud — read business entities via OData.' },
  'odata-v4':     { monogram: 'OD', accent: '#5A6B8C', value: 'Connect Dynamics 365 or Business Central over OData V4.' },
  'workday-raas': { monogram: 'WD', accent: '#005CB9', value: 'Pull Workday reports (RaaS) — people and finance data on a schedule.' },
  // Warehouses / data
  'database':     { monogram: 'PG', accent: '#31648C', value: 'Connect a PostgreSQL database as a governed source.' },
  'warehouse':    { monogram: 'WH', accent: '#8A6516', value: 'Federate an external warehouse as one governed catalog — query live, import tables.' },
  'om-catalog':   { monogram: 'OM', accent: '#3FB950', value: 'Read an OpenMetadata catalog — discover tables and lineage.' },
  'airflow':      { monogram: 'AF', accent: '#017CEE', value: 'Reach Apache Airflow — see and trigger your pipelines.' },
  // Developer / open source
  'github':       { monogram: 'GH', accent: '#5A6270', value: 'Work with GitHub — repos, issues and pull requests, under policy.' },
  'supabase':     { monogram: 'SB', accent: '#3FB950', value: 'Manage your Supabase project via its Management API.' },
  'slack':        { monogram: 'SL', accent: '#4A55C7', value: 'Post to and read Slack — keep the channel informed.' },
  'atlassian':    { monogram: 'AT', accent: '#0052CC', value: 'Work Jira and Confluence — issues, pages and projects.' },
  'notion-mcp':   { monogram: 'No', accent: '#4A4A4A', value: 'Connect your Notion workspace — read and update pages and databases.' },
  // Cloud ML
  'sagemaker':    { monogram: 'SM', accent: '#E8891A', value: 'Reach AWS SageMaker — invoke models and endpoints.' },
  'snowflake-governance': { monogram: 'SN', accent: '#29B5E8', value: 'Read Snowflake ACCOUNT_USAGE for governance and cost insight.' },
  // Generic / custom
  'generic-api':  { monogram: 'API', accent: '#8A6516', value: 'Connect any REST or GraphQL API as a governed connector.' },
  'generic-mcp':  { monogram: 'MCP', accent: '#1F8F88', value: 'Connect any MCP server and expose its tools under policy.' },
};

/**
 * Warehouse-provider identities — keyed on the provider platform (bigquery, snowflake,
 * databricks-delta, fabric, glue, kafka). A warehouse gallery card carries the platform
 * so it gets a per-platform mark rather than the generic warehouse one.
 */
const WAREHOUSE_PLATFORM: Record<string, ConnectorIdentity> = {
  'bigquery':         { monogram: 'BQ', accent: '#4285F4', value: 'Federate Google BigQuery as a governed catalog — query live, import tables.' },
  'snowflake':        { monogram: 'SN', accent: '#29B5E8', value: 'Federate Snowflake as a governed catalog — query live, import tables.' },
  'databricks-delta': { monogram: 'DB', accent: '#D4401A', value: 'Federate Databricks Delta as a governed catalog — query live, import tables.' },
  'fabric':           { monogram: 'FB', accent: '#0078D4', value: 'Federate Microsoft Fabric as a governed catalog — query live, import tables.' },
  'glue':             { monogram: 'GL', accent: '#E8891A', value: 'Federate the AWS Glue catalog — query live, import tables.' },
  'kafka':            { monogram: 'KA', accent: '#3FB950', value: 'Federate Kafka topics as governed tables and land them on a schedule.' },
};

/** Stop-words dropped when deriving a monogram from a label ("Google Drive (personal)" → "GD"). */
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'personal', 'hosted', 'api', 'rest', 'graphql', 'server', 'external', 'v4', 'cloud']);

/** Derive a 1–2 letter monogram from a human label — the honest fallback for unmapped keys. */
function monogramFromLabel(label: string): string {
  const words = label
    .replace(/\(.*?\)/g, ' ')        // drop parenthetical qualifiers
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  if (words.length === 0) return (label.trim()[0] ?? '?').toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * The CSS custom-property bundle for a monogram mark drawn in `accent`. The mark is a
 * soft accent-tinted chip with the accent as the letter colour — legible on both the
 * light and dark OS surfaces (the accent hues are chosen mid-luminance). Returned as a
 * plain style object so a tile can spread it without inline colour math.
 */
export function markStyle(accent: string): {
  '--mono-bg': string;
  '--mono-line': string;
  '--mono-fg': string;
  '--tile-accent': string;
  '--tile-line': string;
} {
  return {
    '--mono-bg': tint(accent, 0.14),
    '--mono-line': tint(accent, 0.34),
    '--mono-fg': accent,
    '--tile-accent': accent,
    '--tile-line': tint(accent, 0.45),
  };
}

/** Wrap a hex or hsl colour in a colour-mix with transparency — a soft, theme-safe tint. */
function tint(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** A stable, pleasant accent hashed from a key — used only when nothing is curated. */
function accentFromKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 42%, 48%)`;
}

/**
 * Resolve a connector's visual identity from its template key (and, for warehouse cards,
 * its platform). `label` seeds the honest fallback for anything not curated so no tile is
 * ever blank. `fallbackValue` (the card's existing blurb/meta) is used only when neither
 * the curated table nor a sensible default provides a business line.
 */
export function connectorIdentity(
  key: string,
  opts?: { platform?: string; label?: string; fallbackValue?: string },
): ConnectorIdentity {
  if (opts?.platform && WAREHOUSE_PLATFORM[opts.platform]) return WAREHOUSE_PLATFORM[opts.platform];
  if (CURATED[key]) return CURATED[key];
  const label = opts?.label ?? key;
  return {
    monogram: monogramFromLabel(label),
    accent: accentFromKey(key),
    value: opts?.fallbackValue?.trim() || `Connect ${label} as a governed connection.`,
  };
}
