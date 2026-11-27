// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE:    App Builder (C2) - publish the env database cluster's CA CERTIFICATE (never its key) for verify-full TLS
// USER STORY: As an app I want to verify that I talk to my env's own Postgres cluster, without ever being able to read the
//             cluster CA's private key.
// ARCHITECTURE: CloudNativePG keeps its self-signed CA in the Secret `<cluster>-ca` (keys ca.crt AND ca.key). App pods must
//   never mount that Secret, and os-ui may never read a Secret in the env namespaces (docs/components/app-databases.md).
//   This chart-owned CronJob (software-app-releases.yaml) runs as its own ServiceAccount whose Role can get exactly that
//   one Secret and update exactly the ConfigMap `<cluster>-ca-cert`; it copies ONLY `ca.crt` (a public certificate, checked
//   to be one PEM certificate and no key) into the ConfigMap the app pods mount read-only. Node's built-in https only, no
//   dependency; the API server is reached at KUBERNETES_SERVICE_HOST with the pod's own token and CA.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const ns = readFileSync(`${SA}/namespace`, 'utf8').trim();
const token = readFileSync(`${SA}/token`, 'utf8').trim();
const ca = readFileSync(`${SA}/ca.crt`);
const cluster = process.env.PG_CLUSTER || 'apps-pg';
const host = process.env.KUBERNETES_SERVICE_HOST;
const port = Number(process.env.KUBERNETES_SERVICE_PORT || 443);

function api(method, path, body, type = 'application/json') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      { host, port, method, path, ca, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(data ? { 'content-type': type, 'content-length': data.length } : {}) }, timeout: 15000 },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const secret = await api('GET', `/api/v1/namespaces/${ns}/secrets/${cluster}-ca`);
if (secret.status === 404) {
  console.log(`publish-pg-ca: ${ns}/${cluster}-ca does not exist yet (the cluster is starting); nothing to publish`);
  process.exit(0);
}
if (secret.status !== 200) throw new Error(`publish-pg-ca: reading ${ns}/${cluster}-ca: HTTP ${secret.status}`);
const pem = Buffer.from(String(secret.body.data?.['ca.crt'] ?? ''), 'base64').toString('utf8');
const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (certs.length < 1 || /PRIVATE KEY/.test(pem)) throw new Error('publish-pg-ca: ca.crt is not a certificate (or carries a key); nothing was published');
const out = `${certs.join('\n')}\n`;
const cm = await api('PATCH', `/api/v1/namespaces/${ns}/configmaps/${cluster}-ca-cert`, { data: { 'ca.crt': out } }, 'application/merge-patch+json');
if (cm.status !== 200) throw new Error(`publish-pg-ca: updating ${ns}/${cluster}-ca-cert: HTTP ${cm.status}`);
console.log(`publish-pg-ca: ${ns}/${cluster}-ca-cert holds ${certs.length} certificate(s)`);
