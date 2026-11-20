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
  const { data } = await request('seaweedfs', `LIST ${bucket}/${prefix}`, `${await baseUrl('seaweedfsFiler')}/buckets/${bucket}/${enc(prefix)}?limit=1000`, { headers: { accept: 'application/json' } });
  return (data.Entries ?? []).map((e) => e.FullPath);
}
