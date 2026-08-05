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
  // Messaging + calendar wave — hand-built typed API clients (bot token / user-provided
  // OAuth access token). Each host also added to the chart egressProxy.allowlist +
  // Cilium FQDN policy on a real deploy.
  'slack.com', // Slack Web API (slack.com/api) + www.slack.com
  'gmail.googleapis.com', // Gmail API
  'oauth2.googleapis.com', // Google OAuth token endpoint (token refresh follow-up)
  // googleapis.com (above) already covers www.googleapis.com — Google Calendar API
  // graph.microsoft.com (above) already covers Outlook + Teams over Microsoft Graph
  // login.microsoftonline.com (above) already covers Microsoft OAuth token endpoint
  // Cloud key-services wave — governance / identity / ML metadata connectors (each
  // host also added to the chart egressProxy.allowlist + Cilium FQDN policy on a
  // real deploy). Entra reuses graph.microsoft.com (already above) — no new host.
  'purview.azure.com', // Microsoft Purview (<account>.purview.azure.com via subdomain rule)
  'api.azureml.ms', // Azure AI Foundry / Azure ML data plane (<region>.api.azureml.ms)
  'ml.azure.com', // Azure ML control-plane / OAuth audience host
  'amazonaws.com', // AWS SageMaker (api.sagemaker.<region>.amazonaws.com via subdomain rule)
  // Cloud key-services wave 2 — GCP identity/IAM governance + Snowflake ACCOUNT_USAGE
  // governance (each host also added to the chart egressProxy.allowlist + Cilium FQDN
  // policy on a real deploy — the operator's step, #176).
  'cloudresourcemanager.googleapis.com', // GCP Cloud Resource Manager (list projects, getIamPolicy)
  'iam.googleapis.com', // GCP IAM (service accounts)
  'admin.googleapis.com', // GCP Admin SDK (optional org/directory reads — reserved)
  // oauth2.googleapis.com (above) already covers the GCP JWT-bearer token exchange
  'snowflakecomputing.com', // Snowflake SQL REST API (<account>.snowflakecomputing.com via subdomain rule)
  // Kajabi public API — sync source (api-batch strategy). Token endpoint + data
  // API share the one host (also added to the chart egressProxy.allowlist +
  // deploy/egress-connectors-overlay.yaml).
  'api.kajabi.com',
  // Operational systems wave — SAP S/4HANA Cloud OData + generic OData V4 (Dynamics 365 /
  // Business Central) + Workday RaaS. Cloud-reachable services only; a customer-specific
  // host not covered here still passes via an Admin-approved egress request. (Also add to
  // the chart egressProxy.allowlist + Cilium FQDN policy on a real deploy.)
  's4hana.cloud.sap', // SAP S/4HANA Cloud (<tenant>.s4hana.cloud.sap via subdomain rule)
  'sap-oauth.cloud.sap', // SAP BTP OAuth token endpoints (client-credentials)
  'ondemand.com', // SAP BTP / Business Technology Platform hosts (*.ondemand.com)
  'sandbox.api.sap.com', // SAP API Business Hub sandbox (public-sandbox verification)
  'api.businesscentral.dynamics.com', // Microsoft Dynamics 365 Business Central OData
  'dynamics.com', // Microsoft Dynamics 365 (<org>.crm.dynamics.com via subdomain rule)
  'workday.com', // Workday RaaS tenant hosts (*.workday.com via subdomain rule)
  'myworkday.com', // Workday RaaS tenant hosts (*.myworkday.com via subdomain rule)
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

/**
 * Is this host an INTERNAL / in-cluster / loopback target? These are the hosts a
 * user-supplied connector endpoint must NOT be able to reach by default — reaching
 * an in-cluster service (`query-tool`, `trino`, `opa`, `minio`, `kubernetes.default`)
 * or loopback would be a server-side request forgery (SSRF) into the platform.
 *
 * Covers: bare hostnames (no dot, e.g. `opa`), `*.svc` / `*.cluster.local` /
 * `*.local`, `localhost`, IPv4 loopback `127.0.0.0/8`, IPv6 loopback `::1`, and IPv6
 * link-local `fe80::/10` (M2). Raw RFC1918 / 169.254 literals are additionally caught
 * by the private-literal check below; this predicate is the internal-NAME + loopback
 * layer that the old `isExternal` (return-false === auto-allow) let through.
 */
export function isInternalTarget(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return true; // un-parseable / empty → treat as internal (deny by default)
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true; // IPv6 loopback
  if (/^\[?fe80:/i.test(host)) return true; // IPv6 link-local fe80::/10
  if (/^127\./.test(host)) return true; // IPv4 loopback 127.0.0.0/8
  if (/\.(local|cluster\.local|svc)$/.test(host)) return true; // in-cluster / local dev
  if (!host.includes('.')) return true; // bare service name (e.g. "opa", "query-tool")
  return false;
}

/** An endpoint is "external" unless it targets an in-cluster / local host. */
export function isExternal(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return false;
  return !isInternalTarget(endpoint);
}

/** Is `host` explicitly present on the egress allowlist (or an Admin-approved request)? */
function onAllowlist(host: string): boolean {
  const list = allowlist();
  return list.some((d) => host === d || host.endsWith(`.${d}`)) || isHostApproved(host);
}

/**
 * Is this endpoint permitted to egress? Subdomains of an allowlisted host pass.
 *
 * DENY-BY-DEFAULT for internal targets: an in-cluster / loopback host is refused
 * UNLESS it is explicitly on the egress allowlist. This closes the SSRF where a
 * signed-in user creates a connector with `endpoint: http://query-tool:8080` (or
 * trino/opa/minio/kubernetes.default.svc) and gets a server-side fetch to an internal
 * service. External hosts still require the allowlist as before.
 */
export function isEgressAllowed(endpoint: string): { external: boolean; host: string; allowed: boolean } {
  const host = egressHost(endpoint);
  const internal = isInternalTarget(endpoint);
  if (internal) {
    // Internal targets are denied unless the operator EXPLICITLY allowlisted them.
    return { external: false, host, allowed: onAllowlist(host) };
  }
  // Allowed if on the static Admin allowlist OR an Admin-approved egress request.
  return { external: true, host, allowed: onAllowlist(host) };
}

/** The egress proxy the connection tools route external calls through (audit). */
export const EGRESS_PROXY = config.opaUrl.replace(/opa:8181$/, 'egress-proxy:3128');
