/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Minimal in-cluster Kubernetes API client (server-only).
 *
 * The OS UI pod carries a scoped ServiceAccount (read Deployments/StatefulSets,
 * patch their /scale, read CNPG Clusters — see the chart's os-ui RBAC). This
 * module talks to the in-cluster API server with that ServiceAccount's token
 * and CA, using only the Node stdlib so it adds no dependencies and never ships
 * to the browser. It replaces the former cross-pod hop to the standalone
 * `admin-console` service (which is the fragile "fetch failed" path we removed).
 *
 * Token + CA are read fresh per call (they rotate). Outside a cluster the reads
 * fail and we resolve `{ status: 0 }` so callers degrade gracefully instead of
 * throwing.
 */
import https from 'node:https';
import { readFileSync } from 'node:fs';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = process.env.KUBERNETES_API ?? 'https://kubernetes.default.svc';

export type K8sResult = { status: number; body: Record<string, unknown> };

function readToken(): string {
  return readFileSync(`${SA}/token`, 'utf8').trim();
}

function readCa(): Buffer {
  return readFileSync(`${SA}/ca.crt`);
}

/**
 * Call the API server. `method` PATCH uses the merge-patch content type (so we
 * can scale a workload with `{spec:{replicas:N}}`). Never throws — network /
 * credential failures resolve to `{ status: 0, body: {} }`.
 */
export function k8s(
  method: string,
  path: string,
  body?: unknown,
): Promise<K8sResult> {
  return new Promise((resolve) => {
    let token: string;
    let ca: Buffer;
    try {
      token = readToken();
      ca = readCa();
    } catch {
      // Not running in a cluster (or token not mounted) — degrade gracefully.
      resolve({ status: 0, body: {} });
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    let data: string | undefined;
    if (method === 'PATCH') {
      headers['Content-Type'] = 'application/merge-patch+json';
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data).toString();
    }

    const url = new URL(API + path);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        ca,
        timeout: 10000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = buf ? JSON.parse(buf) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: {} });
    });
    if (data) req.write(data);
    req.end();
  });
}
