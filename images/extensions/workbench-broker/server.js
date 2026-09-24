/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Sovereign Agentic OS — Workbench Broker.
 *
 * The domain-builder workbench is a PERSISTENT, DOMAIN-SCOPED `code-server`
 * (VS Code in the browser) per builder. This broker is the SINGLE trusted
 * component in the path — the same trust model as the terminal-broker, extended
 * from an ephemeral PTY to a long-lived, reverse-proxied editor:
 *
 *   1. Verifies a short-lived, single-use HMAC token minted by the OS UI (so only
 *      an authenticated `builder` whose role is allowed, scoped to ONE domain,
 *      can open a workbench).
 *   2. IDEMPOTENTLY reconciles that builder's workbench: a per-builder PVC (the
 *      persistence boundary), a per-builder code-server Deployment + Service, a
 *      per-builder NetworkPolicy, and a per-builder credentials Secret that
 *      carries ONLY that builder's DOMAIN-SCOPED Forgejo token (never the global
 *      admin token, never another domain's token).
 *   3. Scales the Deployment 0->1 on connect, waits for readiness, then acts as an
 *      AUTHENTICATING REVERSE PROXY: the browser talks only to the broker; the
 *      broker proxies HTTP + WebSocket to the builder's code-server Service. The
 *      browser never reaches the Kubernetes API or the code-server pod directly.
 *   4. Scales the Deployment back to 0 on idle (the PVC — and thus the builder's
 *      work, settings, extensions, git checkouts — PERSISTS across sessions); a
 *      janitor reaps idle workbenches so only ACTIVE builders consume memory.
 *
 * The code-server pod holds NO Kubernetes token, runs non-root with caps dropped,
 * and is reachable ONLY from the broker (NetworkPolicy). Its egress is restricted
 * to its own domain's Forgejo repos + the governed query-tool — it cannot reach
 * the API server, secrets, another domain's data, other tenants, or the host.
 *
 * Persistence decision (PVC, not ephemeral): a builder's editor state — unsaved
 * edits, extensions, settings, terminal history, non-repo scratch (agent defs,
 * notes) — must survive across sessions. Forgejo is the canonical store for the
 * software repos (git push), but it cannot hold uncommitted or non-repo state, so
 * a per-builder RWO PVC is the working copy and Forgejo is the source of truth.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import httpProxy from 'http-proxy';
import * as k8s from '@kubernetes/client-node';

// ---- Config (all env-driven; safe defaults for local kind) -----------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const SECRET = process.env.WORKBENCH_BROKER_SECRET || 'dev-only-insecure-workbench-secret-change-me';
const WB_NAMESPACE = process.env.WORKBENCH_NAMESPACE || 'agentic-os-workbench';
const RELEASE_NAMESPACE = process.env.RELEASE_NAMESPACE || 'agentic-os';
const WB_IMAGE = process.env.WORKBENCH_IMAGE || 'sovereign-os/code-server-workbench:0.1.0';
const WB_SA = process.env.WORKBENCH_SERVICEACCOUNT || 'workbench-nobody';
const CODE_SERVER_PORT = parseInt(process.env.CODE_SERVER_PORT || '8080', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '1800', 10) * 1000; // 30m
const POD_READY_TIMEOUT_MS = parseInt(process.env.POD_READY_TIMEOUT_SECONDS || '120', 10) * 1000;
const ALLOWED_ROLES = (process.env.ALLOWED_ROLES || 'builder,admin').split(',');
const MAX_ACTIVE = parseInt(process.env.MAX_ACTIVE_WORKBENCHES || '12', 10);
// Pull secrets for the code-server image (comma-separated Secret names that
// must exist in WB_NAMESPACE — the chart replicates the release pull secret
// there). Without this, a private registry (e.g. ghcr.io) 401s the kubelet's
// anonymous pull and every workbench pod sits in ImagePullBackOff forever.
const PULL_SECRETS = (process.env.IMAGE_PULL_SECRETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PVC_SIZE = process.env.WORKBENCH_PVC_SIZE || '2Gi';
const PVC_STORAGECLASS = process.env.WORKBENCH_STORAGE_CLASS || ''; // '' => cluster default
const PROXY_COOKIE = 'soa_wb_proxy';
// Per-builder code-server resources.
const R = {
  cpuReq: process.env.WB_CPU_REQUEST || '100m',
  cpuLim: process.env.WB_CPU_LIMIT || '1',
  memReq: process.env.WB_MEM_REQUEST || '512Mi',
  memLim: process.env.WB_MEM_LIMIT || '2Gi',
  ephLim: process.env.WB_EPHEMERAL_LIMIT || '1Gi',
  uid: parseInt(process.env.WB_RUN_AS_USER || '1000', 10),
};
// Egress targets the code-server pod is allowed to reach (forgejo + query-tool),
// expressed as the release-namespace component labels in the chart NetworkPolicy.

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}
const core = kc.makeApiClient(k8s.CoreV1Api);
const apps = kc.makeApiClient(k8s.AppsV1Api);
const net = kc.makeApiClient(k8s.NetworkingV1Api);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
// The editor is embedded in an iframe on the OS UI origin (os.<zone> framing
// workbench.<zone>). Strip any frame-blocking headers code-server may emit so
// the embed cannot be silently refused — access is already gated by the signed
// proxy cookie + this broker, not by frame policy.
proxy.on('proxyRes', (proxyRes) => {
  delete proxyRes.headers['x-frame-options'];
  const csp = proxyRes.headers['content-security-policy'];
  if (csp && /frame-ancestors/i.test(csp)) {
    proxyRes.headers['content-security-policy'] = csp
      .split(';')
      .filter((d) => !/^\s*frame-ancestors/i.test(d))
      .join(';');
  }
});
proxy.on('error', (err, _req, res) => {
  try {
    if (res && res.writeHead && !res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    if (res && res.end) res.end('workbench upstream error');
  } catch {
    /* ignore */
  }
});

// active workbench sessions: sub -> { domain, lastActive, deployName, svcHost }
const active = new Map();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Token + cookie crypto (HMAC, mirrors the terminal-broker) -------------
const usedSids = new Map();
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function hmac(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest();
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  const got = b64urlToBuf(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let claims;
  try {
    claims = JSON.parse(b64urlToBuf(body).toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || !claims.role || typeof claims.exp !== 'number') return null;
  if (claims.exp < now) return null;
  if (!ALLOWED_ROLES.includes(claims.role)) return null;
  // A workbench is scoped to exactly ONE domain. The token must name it AND the
  // membership set MUST be present and include it — this is the cross-domain cut
  // (a builder must never receive another domain's Forgejo credential). Do NOT
  // skip the check when `domains` is absent: a missing set means "deny".
  if (!claims.domain || typeof claims.domain !== 'string') return null;
  if (!Array.isArray(claims.domains) || !claims.domains.includes(claims.domain)) return null;
  // Single-use: the token MUST carry a sid, accepted exactly once.
  if (!claims.sid || usedSids.has(claims.sid)) return null; // missing or replayed
  usedSids.set(claims.sid, claims.exp);
  return claims;
}
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [sid, exp] of usedSids) if (exp < now) usedSids.delete(sid);
}, 30_000).unref();

// Proxy cookie binds an established session to {sub, domain} for ~12h so the
// browser's subsequent HTTP/WS requests to the broker stay scoped. HMAC-signed.
function mintProxyCookie(sub, domain) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(Buffer.from(JSON.stringify({ sub, domain, exp: now + 60 * 60 * 12 }), 'utf8'));
  return `${body}.${b64url(hmac(body))}`;
}
function verifyProxyCookie(raw) {
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  const expected = hmac(body);
  const got = b64urlToBuf(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const c = JSON.parse(b64urlToBuf(body).toString('utf8'));
    if (c.exp < Math.floor(Date.now() / 1000)) return null;
    return c;
  } catch {
    return null;
  }
}
function readCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ---- Naming (deterministic per builder; the persistence identity) ----------
function sanitize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'user';
}
const names = (sub, domain) => {
  // Deterministic per builder (so the workspace + PVC identity — and thus the
  // persistence — is stable), but disambiguated by a short hash of the RAW sub so
  // two distinct ids that sanitize to the same string can NEVER collide onto the
  // same PVC/Deployment (a cross-builder access risk). Same sub => same names.
  const suffix = crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 6);
  const id = `${sanitize(sub)}-${suffix}`;
  return {
    id,
    pvc: `wb-${id}-home`,
    deploy: `wb-${id}`,
    svc: `wb-${id}`,
    netpol: `wb-${id}`,
    creds: `wb-${id}-creds`,
    svcHost: `wb-${id}.${WB_NAMESPACE}.svc`,
    labels: {
      'app.kubernetes.io/part-of': 'sovereign-agentic-os',
      'app.kubernetes.io/component': 'workbench',
      'soa.dev/workbench-owner': id,
      'soa.dev/domain': sanitize(domain),
    },
  };
};

// ---- Domain-scoped credentials --------------------------------------------
// The chart seeds ONE Secret per domain in the workbench namespace:
//   workbench-domain-creds-<domain>  { forgejoToken, forgejoUser, gitUserName, gitUserEmail }
// The broker copies ONLY the requesting builder's domain creds into the
// per-builder Secret the pod mounts. A builder thus only ever receives their OWN
// domain's token — cross-domain creds are never assembled into their pod.
async function readDomainCreds(domain) {
  const name = `workbench-domain-creds-${sanitize(domain)}`;
  try {
    const sec = await core.readNamespacedSecret({ name, namespace: WB_NAMESPACE });
    const out = {};
    for (const [k, v] of Object.entries(sec.data || {})) out[k] = Buffer.from(v, 'base64').toString('utf8');
    return out;
  } catch {
    // Local-kind / prototype fallback: no per-domain secret seeded. Return a
    // marker so the pod can still demonstrate git/data flows against the local
    // Forgejo without a real scoped token (NEVER use in a deploy).
    return { forgejoUser: `${sanitize(domain)}-builder`, forgejoToken: '', gitUserName: 'Domain Builder', gitUserEmail: `builder@${sanitize(domain)}.local`, _unseeded: 'true' };
  }
}

async function ensureCredsSecret(n, domain) {
  const creds = await readDomainCreds(domain);
  const body = {
    metadata: { name: n.creds, namespace: WB_NAMESPACE, labels: n.labels },
    type: 'Opaque',
    stringData: {
      FORGEJO_USER: creds.forgejoUser || '',
      FORGEJO_TOKEN: creds.forgejoToken || '',
      GIT_USER_NAME: creds.gitUserName || n.id,
      GIT_USER_EMAIL: creds.gitUserEmail || `${n.id}@${sanitize(domain)}.local`,
      WORKBENCH_DOMAIN: sanitize(domain),
    },
  };
  try {
    await core.readNamespacedSecret({ name: n.creds, namespace: WB_NAMESPACE });
    await core.replaceNamespacedSecret({ name: n.creds, namespace: WB_NAMESPACE, body });
  } catch {
    await core.createNamespacedSecret({ namespace: WB_NAMESPACE, body });
  }
}

async function ensurePvc(n) {
  try {
    await core.readNamespacedPersistentVolumeClaim({ name: n.pvc, namespace: WB_NAMESPACE });
    return; // already provisioned — this is the persistence
  } catch {
    /* create below */
  }
  const body = {
    metadata: { name: n.pvc, namespace: WB_NAMESPACE, labels: n.labels },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: PVC_SIZE } },
      ...(PVC_STORAGECLASS ? { storageClassName: PVC_STORAGECLASS } : {}),
    },
  };
  await core.createNamespacedPersistentVolumeClaim({ namespace: WB_NAMESPACE, body });
  log('created PVC', n.pvc);
}

async function ensureNetpol(n) {
  // Per-builder NetworkPolicy: ingress ONLY from the broker; egress to DNS +
  // this builder's domain Forgejo + the governed query-tool. (kindnet does not
  // enforce; Cilium on STACKIT does — same belt-and-braces note as terminal.)
  const body = {
    metadata: { name: n.netpol, namespace: WB_NAMESPACE, labels: n.labels },
    spec: {
      podSelector: { matchLabels: { 'soa.dev/workbench-owner': n.id } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': RELEASE_NAMESPACE } },
              podSelector: { matchLabels: { 'app.kubernetes.io/component': 'workbench-broker' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: CODE_SERVER_PORT }],
        },
      ],
      egress: [
        {
          to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
            { protocol: 'UDP', port: 8053 },
            { protocol: 'TCP', port: 8053 },
          ],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': RELEASE_NAMESPACE } },
              podSelector: { matchExpressions: [{ key: 'app.kubernetes.io/component', operator: 'In', values: ['forgejo', 'query-tool'] }] },
            },
          ],
        },
      ],
    },
  };
  try {
    await net.readNamespacedNetworkPolicy({ name: n.netpol, namespace: WB_NAMESPACE });
  } catch {
    await net.createNamespacedNetworkPolicy({ namespace: WB_NAMESPACE, body });
    log('created NetworkPolicy', n.netpol);
  }
}

function deploymentManifest(n, domain) {
  return {
    metadata: { name: n.deploy, namespace: WB_NAMESPACE, labels: n.labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'soa.dev/workbench-owner': n.id } },
      strategy: { type: 'Recreate' }, // RWO PVC => one pod at a time
      template: {
        metadata: { labels: n.labels },
        spec: {
          automountServiceAccountToken: false, // no k8s token in the workbench
          serviceAccountName: WB_SA,
          ...(PULL_SECRETS.length ? { imagePullSecrets: PULL_SECRETS.map((name) => ({ name })) } : {}),
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 5,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: R.uid,
            runAsGroup: R.uid,
            fsGroup: R.uid,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'code-server',
              image: WB_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              args: [
                '--bind-addr', `0.0.0.0:${CODE_SERVER_PORT}`,
                '--auth', 'none', // auth is enforced UPSTREAM by the broker + NetworkPolicy
                '--disable-telemetry',
                '--disable-update-check',
                '/home/coder/project',
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                // code-server writes extensions/settings under $HOME (the PVC),
                // so the rootfs is RO but $HOME + /tmp are writable mounts.
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: R.uid,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              env: [
                { name: 'WORKBENCH_DOMAIN', value: sanitize(domain) },
                { name: 'FORGEJO_BASE', value: process.env.FORGEJO_BASE || `http://forgejo-http.${RELEASE_NAMESPACE}.svc:3000` },
                { name: 'QUERY_TOOL_BASE', value: process.env.QUERY_TOOL_BASE || `http://query-tool.${RELEASE_NAMESPACE}.svc:8000` },
                { name: 'XDG_DATA_HOME', value: '/home/coder/.local/share' },
              ],
              envFrom: [{ secretRef: { name: n.creds } }],
              ports: [{ name: 'http', containerPort: CODE_SERVER_PORT }],
              resources: {
                requests: { cpu: R.cpuReq, memory: R.memReq, 'ephemeral-storage': '256Mi' },
                limits: { cpu: R.cpuLim, memory: R.memLim, 'ephemeral-storage': R.ephLim },
              },
              volumeMounts: [
                { name: 'home', mountPath: '/home/coder' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
              readinessProbe: { httpGet: { path: '/healthz', port: 'http' }, initialDelaySeconds: 3, periodSeconds: 5 },
            },
          ],
          volumes: [
            { name: 'home', persistentVolumeClaim: { claimName: n.pvc } },
            { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };
}

async function ensureDeploymentAndService(n, domain) {
  // Service (stable name the broker proxies to)
  const svcBody = {
    metadata: { name: n.svc, namespace: WB_NAMESPACE, labels: n.labels },
    spec: {
      selector: { 'soa.dev/workbench-owner': n.id },
      ports: [{ name: 'http', port: CODE_SERVER_PORT, targetPort: 'http' }],
    },
  };
  try {
    await core.readNamespacedService({ name: n.svc, namespace: WB_NAMESPACE });
  } catch {
    await core.createNamespacedService({ namespace: WB_NAMESPACE, body: svcBody });
  }
  // Deployment — create if absent, else ensure scaled to 1.
  try {
    await apps.readNamespacedDeployment({ name: n.deploy, namespace: WB_NAMESPACE });
    await apps.patchNamespacedDeploymentScale(
      { name: n.deploy, namespace: WB_NAMESPACE, body: { spec: { replicas: 1 } } },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
  } catch {
    await apps.createNamespacedDeployment({ namespace: WB_NAMESPACE, body: deploymentManifest(n, domain) });
    log('created Deployment', n.deploy);
  }
}

// Container states that will NEVER self-heal within the wait window — fail
// fast with the real reason instead of a mute 120s timeout (an ImagePullBackOff
// otherwise looks like "loads forever" to the person staring at the tab).
const FATAL_WAIT_REASONS = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'CrashLoopBackOff',
]);
async function podWaitingReason(n) {
  try {
    const pods = await core.listNamespacedPod({
      namespace: WB_NAMESPACE,
      labelSelector: `soa.dev/workbench-owner=${n.id}`,
    });
    const cs = pods.items?.[0]?.status?.containerStatuses?.[0];
    return cs?.state?.waiting?.reason || '';
  } catch {
    return '';
  }
}
async function waitForEndpoints(n, deadline) {
  for (;;) {
    try {
      const ep = await core.readNamespacedEndpoints({ name: n.svc, namespace: WB_NAMESPACE });
      const ready = (ep.subsets || []).some((s) => (s.addresses || []).length > 0);
      if (ready) return;
    } catch {
      /* not yet */
    }
    const reason = await podWaitingReason(n);
    if (FATAL_WAIT_REASONS.has(reason)) {
      throw new Error(`workbench pod cannot start: ${reason} (image ${WB_IMAGE})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`workbench not Ready in time${reason ? ` (last state: ${reason})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function scaleDown(n) {
  try {
    await apps.patchNamespacedDeploymentScale(
      { name: n.deploy, namespace: WB_NAMESPACE, body: { spec: { replicas: 0 } } },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
    log('scaled workbench to 0 (PVC persists)', n.deploy);
  } catch (e) {
    log('scale-down failed', n.deploy, e?.body?.message || e?.message);
  }
}

// ---- Reconcile a builder's workbench (idempotent) --------------------------
async function ensureWorkbench(claims) {
  const domain = claims.domain;
  const n = names(claims.sub, domain);
  await ensureCredsSecret(n, domain);
  await ensurePvc(n);
  await ensureNetpol(n);
  await ensureDeploymentAndService(n, domain);
  await waitForEndpoints(n, Date.now() + POD_READY_TIMEOUT_MS);
  active.set(n.id, { domain, lastActive: Date.now(), deploy: n.deploy, svcHost: n.svcHost, sub: claims.sub });
  return n;
}

// ---- HTTP server: control endpoint + authenticating reverse proxy ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz' || url.pathname === '/readyz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Control: establish/resume the workbench. The OS UI hands the browser a token;
  // the browser POSTs it here once; we reconcile + scale up + set the proxy cookie.
  if (url.pathname === '/session' && req.method === 'POST') {
    const claims = verifyToken(url.searchParams.get('t'));
    if (!claims) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    const n = names(claims.sub, claims.domain);
    if (!active.has(n.id) && active.size >= MAX_ACTIVE) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'workbench capacity reached' }));
      return;
    }
    try {
      await ensureWorkbench(claims);
      const cookie = mintProxyCookie(claims.sub, claims.domain);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${PROXY_COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({ ok: true, domain: claims.domain }));
    } catch (e) {
      const detail = e?.body?.message || e?.message || 'unknown error';
      log('reconcile failed', claims.sub, detail);
      // Surface the REAL reason (e.g. ImagePullBackOff) — a generic message
      // hides operator-fixable problems from the person staring at the tab.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `failed to start workbench: ${detail}` }));
    }
    return;
  }

  // Everything else => reverse proxy to the cookie-bound builder's code-server.
  const sess = gateProxy(req, res);
  if (!sess) return;
  sess.lastActive = Date.now();
  proxy.web(req, res, { target: `http://${sess.svcHost}:${CODE_SERVER_PORT}` });
});

// Gate every proxied request on the signed cookie; resolve the target pod from
// the COOKIE (server-side), never from anything the browser can set directly.
function gateProxy(req, res) {
  const c = verifyProxyCookie(readCookie(req, PROXY_COOKIE));
  if (!c) {
    if (res) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('no workbench session');
    }
    return null;
  }
  const n = names(c.sub, c.domain);
  const sess = active.get(n.id);
  if (!sess) {
    if (res) {
      res.writeHead(409, { 'content-type': 'text/plain' });
      res.end('workbench not running — reopen the tab');
    }
    return null;
  }
  return sess;
}

// WebSocket upgrades (code-server's editor channel) — same cookie gate.
server.on('upgrade', (req, socket, head) => {
  const sess = gateProxy(req, null);
  if (!sess) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  sess.lastActive = Date.now();
  proxy.ws(req, socket, head, { target: `http://${sess.svcHost}:${CODE_SERVER_PORT}` });
});

// ---- Idle reaper: scale idle workbenches to 0 (PVC persists) ----------------
setInterval(async () => {
  const now = Date.now();
  for (const [id, sess] of active) {
    if (now - sess.lastActive > IDLE_TIMEOUT_MS) {
      const n = names(sess.sub, sess.domain);
      await scaleDown(n);
      active.delete(id);
    }
  }
}, 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  log(`workbench-broker listening on :${PORT}`);
  log(`workbench ns=${WB_NAMESPACE} image=${WB_IMAGE} idle=${IDLE_TIMEOUT_MS}ms maxActive=${MAX_ACTIVE}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('shutting down; scaling down', active.size, 'workbenches');
    await Promise.all([...active.values()].map((s) => scaleDown(names(s.sub, s.domain))));
    process.exit(0);
  });
}
