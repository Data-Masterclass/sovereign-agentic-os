/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read objects from SeaweedFS, the harness's S3 store
 * USER STORY: As AT-a I want "<key>.docling.json exists beside the blob" to be the object store's
 *             own answer.
 * ARCHITECTURE:
 *   - SeaweedFS keeps every S3 bucket under the filer path /buckets/<bucket>/, so a HEAD/GET on the
 *     filer HTTP API reads the same object the S3 gateway serves, without re-implementing SigV4.
 *     Docs: https://github.com/seaweedfs/seaweedfs/wiki/Filer-Server-API
 */
import { baseUrl } from '../endpoints.mjs';
import { request } from '../http.mjs';

const enc = (key) => key.split('/').map(encodeURIComponent).join('/');

export async function head(bucket, key) {
  const { status, headers } = await request('seaweedfs', `HEAD ${bucket}/${key}`, `${await baseUrl('seaweedfsFiler')}/buckets/${bucket}/${enc(key)}`, { method: 'HEAD', okStatus: [404] });
  return status === 404 ? null : { size: Number(headers.get('content-length') ?? 0), etag: headers.get('etag') };
}

export async function getJson(bucket, key) {
  const { data, text } = await request('seaweedfs', `GET ${bucket}/${key}`, `${await baseUrl('seaweedfsFiler')}/buckets/${bucket}/${enc(key)}`);
  return typeof data === 'string' ? JSON.parse(text) : data;
}

export async function list(bucket, prefix = '') {
  const path = bucket ? `/buckets/${bucket}/${enc(prefix)}` : '/buckets/';
  const { data } = await request('seaweedfs', `LIST ${bucket}/${prefix}`, `${await baseUrl('seaweedfsFiler')}${path}?limit=1000`, { headers: { accept: 'application/json' } });
  return (data.Entries ?? []).map((e) => e.FullPath);
}

// ---- S3 API (through the S3 gateway, AWS Signature V4) — used by the harness self-test to prove
// the S3 protocol works end to end, then read back through the filer above.
// Docs: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
import { createHash, createHmac } from 'node:crypto';

const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

export async function putObject(bucket, key, body, { accessKey = 'agentic-os-local', secretKey = 'agentic-os-local-secret', region = 'us-east-1' } = {}) {
  const base = new URL(await baseUrl('seaweedfsS3'));
  const path = `/${bucket}/${enc(key)}`;
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const payloadHash = sha256(body);
  const host = base.host;
  const canonical = ['PUT', path, '', `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${now}`, '', 'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  const { status } = await request('seaweedfs', `S3 PUT ${bucket}/${key}`, `${base.origin}${path}`, {
    method: 'PUT', body, timeoutMs: 60000, // the first write to a bucket makes SeaweedFS grow volumes
    headers: {
      'x-amz-date': now, 'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  return status;
}
