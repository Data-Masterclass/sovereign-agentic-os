/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHash } from 'crypto';
import { config } from '@/lib/core/config';
import { isHostApproved } from '@/lib/connections/egress-requests';

/**
 * Mock STACKIT Secrets Manager + External Secrets (Connections golden path §2,
 * security.md). THE ONE RULE: the secret never leaves Secrets Manager. The
 * connection RECORD holds only a reference (`{ name, key }`); the raw value is
 * written here, server-side, and NEVER serialized into a record, an API
 * response, a Langfuse trace, or a log line.
 *
 * On STACKIT this is the Secrets Manager API synced via the External Secrets
 * Operator; locally it is an in-process vault so the teaching flow works with no
 * cluster, while preserving the exact "store a ref, never the secret" contract.
 */

// "name/key" -> raw secret value. Module-scoped, server-only; never serialized.
const VAULT_KEY = Symbol.for('soa.secrets.vault');
function vault(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  if (!g[VAULT_KEY]) g[VAULT_KEY] = new Map();
  return g[VAULT_KEY]!;
}

export type SecretRef = { name: string; key: string };

function refKey(ref: SecretRef): string {
  return `${ref.name}/${ref.key}`;
}

/** Write a credential to Secrets Manager. Returns ONLY a reference. */
export function putSecret(name: string, key: string, value: string): SecretRef {
  const ref = { name, key };
  vault().set(refKey(ref), value);
  return ref;
}

export function hasSecret(ref: SecretRef): boolean {
  return vault().has(refKey(ref));
}

/**
 * A non-reversible fingerprint of the stored secret — safe to show/audit. It is
 * NOT the secret and cannot be reversed to it, so it never breaches "the secret
 * never appears in the record or logs".
 */
export function secretFingerprint(ref: SecretRef): string {
  const v = vault().get(refKey(ref));
  if (!v) return '';
  return `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 12)}`;
}

/**
 * Retrieve a secret SERVER-SIDE only (e.g. for the connection proxy to inject
 * the credential into an outbound call, or to "test" the connection). Callers
 * must never return this value to the client or put it in a trace.
 */
export function getSecretServerSide(ref: SecretRef): string | null {
  return vault().get(refKey(ref)) ?? null;
}

export function deleteSecret(ref: SecretRef): void {
  vault().delete(refKey(ref));
}

// ------------------------------------------------------------- Egress allowlist --

/**
 * Egress allowlist guardrail (security.md). External endpoints must be on the
 * tenant allowlist (an Admin guardrail; the chart's `egressProxy.allowlist`). We
 * mirror it here so the guardrail is demonstrable offline; the live source of
 * truth is the egress proxy + Cilium FQDN policy.
 */
const DEFAULT_ALLOWLIST = [
  'example.com',
  'github.com',
  // Connections golden-path slice endpoints (also added to egressProxy.allowlist).
  'salesforce.com',
  'my.salesforce.com',
  'login.salesforce.com',
  'notion.com',
  'mcp.notion.com',
  'api.notion.com',
  // Connected-drive OAuth flow: the Google + Microsoft OAuth token endpoints and
  // the Drive / Microsoft Graph APIs the connector reads from (also add these to
  // egressProxy.allowlist + the Cilium FQDN policy on a real deploy).
  'googleapis.com', // www.googleapis.com (Drive) + oauth2.googleapis.com (token)
  'accounts.google.com', // Google authorize endpoint
  'graph.microsoft.com', // OneDrive via Microsoft Graph
  'login.microsoftonline.com', // Microsoft OAuth authorize + token endpoints
  // Connector wave — hand-built typed API clients (each host also added to the chart
  // egressProxy.allowlist + Cilium FQDN policy on a real deploy).
  'api.github.com', // GitHub REST + GraphQL (covered by github.com, listed explicitly)
  'uploads.github.com', // GitHub release/asset uploads
  'api.supabase.com', // Supabase Management API (projects/tables/migrations/advisors/logs)
  'atlassian.net', // Jira + Confluence Cloud sites (*.atlassian.net via subdomain rule)
  'api.atlassian.com', // Atlassian OAuth 3LO gateway (cloudId-scoped API)
  'auth.atlassian.com', // Atlassian OAuth token endpoint
];

function allowlist(): string[] {
  const csv = process.env.OS_EGRESS_ALLOWLIST;
  if (csv && csv.trim().length > 0) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWLIST;
}

export function egressHost(endpoint: string): string {
  const raw = (endpoint || '').trim();
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}

/** An endpoint is "external" unless it targets an in-cluster / local host. */
export function isExternal(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  // In-cluster service names / local dev domains are not external internet.
  if (/\.(local|cluster\.local|svc)$/.test(host)) return false;
  if (!host.includes('.')) return false; // bare service name (e.g. "opa")
  return true;
}

/** Is this endpoint permitted to egress? Subdomains of an allowlisted host pass. */
export function isEgressAllowed(endpoint: string): { external: boolean; host: string; allowed: boolean } {
  const host = egressHost(endpoint);
  const external = isExternal(endpoint);
  if (!external) return { external: false, host, allowed: true };
  const list = allowlist();
  // Allowed if on the static Admin allowlist OR an Admin-approved egress request.
  const allowed = list.some((d) => host === d || host.endsWith(`.${d}`)) || isHostApproved(host);
  return { external: true, host, allowed };
}

/** The egress proxy the connection tools route external calls through (audit). */
export const EGRESS_PROXY = config.opaUrl.replace(/opa:8181$/, 'egress-proxy:3128');
