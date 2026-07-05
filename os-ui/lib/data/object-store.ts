/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { config } from '@/lib/config';
import { sanitizeIdent } from './store-fqn.ts';

/**
 * Minimal, dependency-free S3 PUT for MinIO / STACKIT Object Storage — the Data-tab
 * upload path. os-ui streams a file to `s3://<uploadsBucket>/uploads/<uid>/<file>`,
 * then the data-runner reads it back. We sign with AWS SigV4 using Node's built-in
 * crypto (no @aws-sdk, no `npm install`), single path-style PUT with an UNSIGNED
 * payload (integrity is still on the wire; avoids a second full-buffer hash pass).
 *
 * SECURITY: the object key is ALWAYS forced under the caller's own `uploads/<uid>/`
 * prefix ({@link uploadObjectKey}) from the SESSION principal — a request body can
 * never widen it, and the runner independently re-checks the same prefix.
 */

// Path segments are RFC-3986 encoded but the '/' separators are preserved.
function encodeKey(key: string): string {
  return key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** A safe upload filename: drop any path components + unusual chars (no traversal). */
export function safeFileName(name: string): string {
  const base = (name || 'upload').split(/[\\/]/).pop() || 'upload';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned || 'upload';
}

/**
 * The FORCED object key for a caller's upload — always `uploads/<uid>/<file>` where
 * `<uid>` is the sanitized SESSION principal. This is the single choke point that
 * prevents cross-user object writes: callers pass the session principal (never a
 * body value), and the runner rejects anything outside `uploads/<uid>/`.
 */
export function uploadObjectKey(principal: string, fileName: string): string {
  return `uploads/${sanitizeIdent(principal)}/${safeFileName(fileName)}`;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** PUT a buffered body to the uploads bucket at `key` (SigV4, path-style). Throws on
 *  a non-2xx so the caller reports the failure honestly (never a false success). */
export async function putObject(
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<void> {
  if (!config.awsAccessKeyId || !config.awsSecretAccessKey) {
    throw new Error('object-store credentials are not configured (AWS_ACCESS_KEY_ID/SECRET)');
  }
  const url = new URL(config.s3Endpoint);
  const host = url.host; // e.g. "minio:9000" — undici sends this host header automatically.
  const canonicalUri = `/${config.uploadsBucket}/${encodeKey(key)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = config.s3Region;
  const service = 's3';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.awsSecretAccessKey, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.awsAccessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${config.s3Endpoint}${canonicalUri}`, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization,
      },
      body,
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`object-store PUT ${res.status}: ${text.slice(0, 240)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
