/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read Docling-serve's own access log
 * USER STORY: As AT-a I want "Docling converted and chunked the PDF" to be Docling's log of the
 *             two async tasks, not an OS status.
 * ARCHITECTURE:
 *   - docling-serve runs on uvicorn, which logs every request line. The async API is
 *     POST /v1/convert/file/async and /v1/chunk/hybrid/file/async, then GET
 *     /v1/status/poll/<task_id> and /v1/result/<task_id>.
 *     Docs: https://github.com/docling-project/docling-serve/blob/main/docs/usage.md
 */
import { logs } from '../kube.mjs';

export async function accessLog(since = '2h') {
  return logs('app.kubernetes.io/component=docling', { since });
}

/** Task ids seen in result/poll lines of the access log. */
export async function taskIdsSeen(since) {
  const text = await accessLog(since);
  return new Set([...text.matchAll(/\/v1\/(?:status\/poll|result)\/([A-Za-z0-9-]+)/g)].map((m) => m[1]));
}

export async function asyncCallsSeen(since) {
  const text = await accessLog(since);
  return {
    convert: (text.match(/POST \/v1\/convert\/file\/async/g) ?? []).length,
    chunk: (text.match(/POST \/v1\/chunk\/hybrid\/file\/async/g) ?? []).length,
  };
}
