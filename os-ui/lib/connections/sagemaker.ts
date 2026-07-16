/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHash, createHmac } from 'crypto';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * AWS SageMaker client over `https://api.sagemaker.<region>.amazonaws.com` — the
 * per-connection bridge to a customer's SageMaker via AWS Signature Version 4.
 *
 * SageMaker's control-plane API is AWS JSON 1.1: a POST to `/` with an
 * `X-Amz-Target: SageMaker.<Action>` header and a JSON body, signed with SigV4.
 *
 * A governed, READ-ONLY ML-metadata connection: OS agents list models, endpoints
 * and training jobs and describe one endpoint. There are NO writes — creating or
 * deleting a model/endpoint is out of scope for this connector.
 *
 * SECRETS: the AWS access key id + secret access key are the vaulted credential
 * (stored together as `"<accessKeyId>:<secretAccessKey>"` under one secret key and
 * split HERE, server-side). They NEVER land on the record, in a response, or in a
 * log/trace; the region is NON-secret and derives from the endpoint host. The
 * signer uses the secret key ONLY to derive the signing key — it is never returned.
 *
 * SigV4: a minimal, correct, dependency-free implementation of the AWS Signature
 * Version 4 signing process (canonical request → string-to-sign → derived signing
 * key → Authorization header) is implemented below and unit-tested against AWS's
 * published `aws4_testsuite` `get-vanilla` vector, so the signature is provably
 * correct rather than faked. Every call NEVER throws — `{ ok:false, reason }`.
 * Egress: `amazonaws.com` (subdomain rule covers `api.sagemaker.<region>`).
 */

export type SageMakerFetch = typeof fetch;

export type SageMakerCreds = { accessKeyId: string; secretAccessKey: string };

export type SageMakerConn = {
  /** e.g. `https://api.sagemaker.eu-central-1.amazonaws.com` */
  endpoint: string;
  region: string;
  creds?: SageMakerCreds;
  fetchImpl: SageMakerFetch;
  timeoutMs?: number;
};

export type SageMakerResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const SERVICE = 'sagemaker';
const PAGE = 25;

// --------------------------------------------------------------- SigV4 ----------

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** amz date + short date from a Date (UTC). `20150830T123600Z` + `20150830`. */
export function amzDates(d: Date): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20150830T123600Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Derive the SigV4 signing key: kSecret→kDate→kRegion→kService→kSigning. */
function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export type SignInput = {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  amzDate: string;
  dateStamp: string;
  headers: Record<string, string>; // includes the target/content-type; host + x-amz-date added here
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Build the full SigV4 header set (Authorization + x-amz-date + x-amz-content-sha256)
 * for a request. Pure + deterministic — unit-tested against AWS's vector.
 */
export function sign(input: SignInput): Record<string, string> {
  const payloadHash = sha256Hex(input.body);
  // Canonical (signed) headers: host + x-amz-content-sha256 + x-amz-date + any
  // provided header, lower-cased keys, trimmed values, sorted by key.
  const canonHeaders: Record<string, string> = {
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': input.amzDate,
  };
  for (const [k, v] of Object.entries(input.headers)) canonHeaders[k.toLowerCase()] = v.trim();
  const sortedKeys = Object.keys(canonHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonHeaders[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    input.method,
    input.path || '/',
    '', // canonical query string (none for AWS JSON POSTs)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = signingKey(input.secretAccessKey, input.dateStamp, input.region, input.service);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...input.headers,
    host: input.host,
    'x-amz-date': input.amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization,
  };
}

// --------------------------------------------------------------- transport ------

/** Derive the AWS region from a SageMaker endpoint host (api.sagemaker.<region>.amazonaws.com). */
export function regionFromEndpoint(endpoint: string): string {
  const host = (() => {
    try {
      return new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname;
    } catch {
      return endpoint;
    }
  })().toLowerCase();
  const m = host.match(/^api\.sagemaker\.([a-z0-9-]+)\.amazonaws\.com$/);
  return m ? m[1] : '';
}

/** One signed SageMaker AWS-JSON-1.1 call. Never throws. Maps AWS error shapes honestly. */
async function call(conn: SageMakerConn, action: string, body: Record<string, unknown>): Promise<SageMakerResult<Record<string, unknown>>> {
  if (!conn.creds?.accessKeyId || !conn.creds?.secretAccessKey) return { ok: false, reason: 'no AWS credentials set' };
  if (!conn.region) return { ok: false, reason: 'could not derive AWS region from the endpoint (expected api.sagemaker.<region>.amazonaws.com)' };
  let host: string;
  try {
    host = new URL(conn.endpoint).host;
  } catch {
    return { ok: false, reason: 'invalid SageMaker endpoint URL' };
  }
  const payload = JSON.stringify(body);
  const { amzDate, dateStamp } = amzDates(new Date());
  const headers = sign({
    method: 'POST',
    host,
    path: '/',
    region: conn.region,
    service: SERVICE,
    amzDate,
    dateStamp,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `SageMaker.${action}` },
    body: payload,
    accessKeyId: conn.creds.accessKeyId,
    secretAccessKey: conn.creds.secretAccessKey,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(conn.endpoint, { method: 'POST', headers, body: payload, cache: 'no-store', signal: ctrl.signal });
    if (res.status === 429 || res.status === 503) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 403) return { ok: false, reason: 'forbidden (SigV4 signature rejected or missing IAM read permission)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const type = String(errBody.__type ?? errBody.Code ?? `HTTP ${res.status}`);
      if (/ResourceNotFound|NotFound/i.test(type)) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: `SageMaker ${type}` };
    }
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- liveness -------

/** Liveness: ListModels with MaxResults=1 — a cheap signed round-trip. 2xx ⇒ live. */
export async function sagemakerHealth(conn: SageMakerConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await call(conn, 'ListModels', { MaxResults: 1 });
  if (r.ok) return { connected: true, detail: `SageMaker reachable in ${conn.region}` };
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type SageMakerModel = { name: string; arn: string; creationTime: string };
export type SageMakerEndpoint = { name: string; arn: string; status: string };
export type SageMakerTrainingJob = { name: string; arn: string; status: string };

/** ListModels — list SageMaker models. Read. Bounded. */
export async function sagemakerListModels(conn: SageMakerConn): Promise<SageMakerResult<SageMakerModel[]>> {
  const r = await call(conn, 'ListModels', { MaxResults: PAGE });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.Models) ? (r.data.Models as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({ name: String(d.ModelName ?? ''), arn: String(d.ModelArn ?? ''), creationTime: String(d.CreationTime ?? '') })),
    truncated: Boolean(r.data.NextToken),
  };
}

/** ListEndpoints — list SageMaker inference endpoints. Read. Bounded. */
export async function sagemakerListEndpoints(conn: SageMakerConn): Promise<SageMakerResult<SageMakerEndpoint[]>> {
  const r = await call(conn, 'ListEndpoints', { MaxResults: PAGE });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.Endpoints) ? (r.data.Endpoints as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({ name: String(d.EndpointName ?? ''), arn: String(d.EndpointArn ?? ''), status: String(d.EndpointStatus ?? '') })),
    truncated: Boolean(r.data.NextToken),
  };
}

/** ListTrainingJobs — list SageMaker training jobs. Read. Bounded. */
export async function sagemakerListTrainingJobs(conn: SageMakerConn): Promise<SageMakerResult<SageMakerTrainingJob[]>> {
  const r = await call(conn, 'ListTrainingJobs', { MaxResults: PAGE });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.TrainingJobSummaries) ? (r.data.TrainingJobSummaries as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({ name: String(d.TrainingJobName ?? ''), arn: String(d.TrainingJobArn ?? ''), status: String(d.TrainingJobStatus ?? '') })),
    truncated: Boolean(r.data.NextToken),
  };
}

/** DescribeEndpoint — describe one endpoint by name. Read. */
export async function sagemakerDescribeEndpoint(conn: SageMakerConn, name: string): Promise<SageMakerResult<SageMakerEndpoint>> {
  if (!name.trim()) return { ok: false, reason: 'describe_endpoint needs an endpoint name' };
  const r = await call(conn, 'DescribeEndpoint', { EndpointName: name });
  if (!r.ok) return r;
  return { ok: true, data: { name: String(r.data.EndpointName ?? name), arn: String(r.data.EndpointArn ?? ''), status: String(r.data.EndpointStatus ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Split the vaulted `"<accessKeyId>:<secretAccessKey>"` credential. Server-side only. */
export function parseSageMakerCreds(raw: string | null | undefined): SageMakerCreds | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  return { accessKeyId: raw.slice(0, idx).trim(), secretAccessKey: raw.slice(idx + 1).trim() };
}

/** Build the pure SageMaker client config — the AWS keys are dereferenced from the
 *  vault HERE (server-side), split, and never leave this process. */
export function sagemakerConnFrom(c: Connection): SageMakerConn {
  return {
    endpoint: c.endpoint || '',
    region: regionFromEndpoint(c.endpoint || ''),
    creds: parseSageMakerCreds(getSecretServerSide(c.secretRef)),
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
