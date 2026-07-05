/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Sovereign Agentic OS — Terminal Broker.
 *
 * The single trusted component for the in-UI Terminal tab. It owns the ONLY
 * Kubernetes credential in the path (a tightly-scoped ServiceAccount that may
 * create/get/delete Pods and open pods/exec, in the sandbox namespace ONLY).
 * The browser never talks to the Kubernetes API — it talks to this broker over
 * a WebSocket, and this broker talks to the API on its behalf.
 *
 * Per session it:
 *   1. Verifies a short-lived, single-use HMAC token minted by the OS UI
 *      (so only an authenticated, authorised OS user can open a shell).
 *   2. Spawns an ephemeral, locked-down sandbox Pod (no SA token, non-root,
 *      read-only rootfs, all caps dropped, seccomp RuntimeDefault, tight
 *      cpu/mem/pids/ephemeral-storage limits, deny-egress NetworkPolicy).
 *   3. Opens a PTY into it via the k8s exec API and bridges stdin/stdout/resize
 *      to the browser xterm.js.
 *   4. Destroys the Pod on disconnect, idle timeout, or max-session TTL — and a
 *      janitor sweep reaps any orphans.
 *
 * The sandbox Pod itself holds NO Kubernetes rights and no API token: from
 * inside the shell `kubectl` is not installed, the SA token is absent, and
 * egress is denied — so a student cannot reach the API server, read Secrets,
 * or pivot into the cluster.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as k8s from '@kubernetes/client-node';

// ---- Config (all env-driven; safe defaults for local kind) -----------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || '/terminal';
const SECRET = process.env.TERMINAL_BROKER_SECRET || 'dev-only-insecure-terminal-secret-change-me';
const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || 'agentic-os-sandbox';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'sovereign-os/sandbox-shell:0.1.0';
const SANDBOX_SA = process.env.SANDBOX_SERVICEACCOUNT || 'sandbox-nobody';
const SHELL = (process.env.SANDBOX_SHELL || '/bin/bash').split(' ');
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '600', 10) * 1000; // 10m
const MAX_SESSION_MS = parseInt(process.env.MAX_SESSION_SECONDS || '3600', 10) * 1000; // 60m
const POD_READY_TIMEOUT_MS = parseInt(process.env.POD_READY_TIMEOUT_SECONDS || '60', 10) * 1000;
const ALLOWED_ROLES = (process.env.ALLOWED_ROLES || 'participant,builder,admin').split(',');
const MAX_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '30', 10);
// Pull secrets for the sandbox image (comma-separated Secret names that must
// exist in SANDBOX_NAMESPACE — the chart replicates the release pull secret
// there). Without this, a private registry (e.g. ghcr.io) 401s the kubelet's
// anonymous pull and every sandbox Pod sits in ImagePullBackOff forever.
const PULL_SECRETS = (process.env.IMAGE_PULL_SECRETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Resource knobs for the sandbox Pod.
const R = {
  cpuReq: process.env.SANDBOX_CPU_REQUEST || '50m',
  cpuLim: process.env.SANDBOX_CPU_LIMIT || '500m',
  memReq: process.env.SANDBOX_MEM_REQUEST || '128Mi',
  memLim: process.env.SANDBOX_MEM_LIMIT || '512Mi',
  ephLim: process.env.SANDBOX_EPHEMERAL_LIMIT || '512Mi',
  uid: parseInt(process.env.SANDBOX_RUN_AS_USER || '1000', 10),
};

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster(); // in-cluster SA when deployed
} catch {
  kc.loadFromDefault(); // kubeconfig when running the broker locally against kind
}
const core = kc.makeApiClient(k8s.CoreV1Api);
const exec = new k8s.Exec(kc);

const sessions = new Set();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Token verification ----------------------------------------------------
// Token shape mirrors the OS UI session token: base64url(json).base64url(hmac).
// Claims: { sub, role, domains[], sid, iat, exp }. Single-use is enforced by the
// short exp (~60s) + sid de-dup below.
const usedSids = new Map(); // sid -> expiry (replay guard within the exp window)

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest();
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
  // Single-use: the token MUST carry a sid, accepted exactly once (it rides in the
  // ?t= query param, which can land in ingress/proxy access logs — reject replays).
  if (!claims.sid || usedSids.has(claims.sid)) return null; // missing or replayed
  usedSids.set(claims.sid, claims.exp);
  return claims;
}
// Reap expired sids periodically.
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [sid, exp] of usedSids) if (exp < now) usedSids.delete(sid);
}, 30_000).unref();

// ---- Sandbox Pod spec (the locked-down profile) ----------------------------
function podManifest(name, owner) {
  return {
    metadata: {
      name,
      namespace: SANDBOX_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'sovereign-agentic-os',
        'app.kubernetes.io/component': 'terminal-sandbox',
        'soa.dev/terminal-owner': owner,
      },
    },
    spec: {
      // No API token in the sandbox: a student cannot talk to the API server.
      automountServiceAccountToken: false,
      serviceAccountName: SANDBOX_SA,
      ...(PULL_SECRETS.length ? { imagePullSecrets: PULL_SECRETS.map((name) => ({ name })) } : {}),
      restartPolicy: 'Never',
      enableServiceLinks: false, // no *_SERVICE_HOST env leakage of cluster svcs
      terminationGracePeriodSeconds: 2,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: R.uid,
        runAsGroup: R.uid,
        fsGroup: R.uid,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'shell',
          image: SANDBOX_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          // Keep the container alive; the broker execs a PTY into it.
          command: ['/bin/sh', '-c', 'sleep 86400'],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: R.uid,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
          },
          resources: {
            requests: { cpu: R.cpuReq, memory: R.memReq, 'ephemeral-storage': '64Mi' },
            limits: {
              cpu: R.cpuLim,
              memory: R.memLim,
              'ephemeral-storage': R.ephLim,
            },
          },
          env: [
            { name: 'HOME', value: '/home/sandbox' },
            { name: 'TERM', value: 'xterm-256color' },
            { name: 'PS1', value: 'sandbox:\\w$ ' },
          ],
          volumeMounts: [
            { name: 'home', mountPath: '/home/sandbox' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      // Writable scratch only (rootfs stays read-only). sizeLimit caps abuse.
      volumes: [
        { name: 'home', emptyDir: { sizeLimit: '128Mi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '128Mi' } },
      ],
    },
  };
}

// Wait for the sandbox Pod to run — reporting WHAT it is waiting on via
// onStatus (scheduling / pulling image / …) so the browser shows honest
// progress, and failing FAST (with the real reason) on unrecoverable container
// states like ErrImagePull/ImagePullBackOff instead of a mute 60s timeout.
const FATAL_WAIT_REASONS = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);
function waitingReason(pod) {
  const cs = pod?.status?.containerStatuses?.[0];
  return cs?.state?.waiting?.reason || '';
}
async function waitForRunning(name, deadline, onStatus = () => {}) {
  let lastReported = '';
  for (;;) {
    let pod;
    try {
      pod = await core.readNamespacedPod({ name, namespace: SANDBOX_NAMESPACE });
    } catch {
      pod = null;
    }
    const phase = pod?.status?.phase;
    if (phase === 'Running') return;
    if (phase === 'Failed' || phase === 'Succeeded') throw new Error(`sandbox pod entered ${phase}`);
    const reason = waitingReason(pod);
    if (FATAL_WAIT_REASONS.has(reason)) {
      throw new Error(`sandbox pod cannot start: ${reason} (image ${SANDBOX_IMAGE})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`sandbox pod not Ready in time${reason ? ` (last state: ${reason})` : ''}`);
    }
    const msg = reason === 'ContainerCreating' || !reason
      ? (phase === 'Pending' && !pod?.status?.containerStatuses ? 'scheduling sandbox…' : 'starting sandbox container…')
      : `waiting on sandbox: ${reason}`;
    if (msg !== lastReported) {
      lastReported = msg;
      onStatus(msg);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function deletePod(name) {
  try {
    await core.deleteNamespacedPod({
      name,
      namespace: SANDBOX_NAMESPACE,
      gracePeriodSeconds: 0,
    });
    log('deleted pod', name);
  } catch (e) {
    log('delete pod failed (may already be gone)', name, e?.body?.message || e?.message);
  }
}

// k8s exec streaming-protocol channel for terminal resize.
const RESIZE_CHANNEL = 4;
function sendResize(k8sWs, cols, rows) {
  if (!k8sWs || k8sWs.readyState !== 1) return;
  const data = JSON.stringify({ Width: cols, Height: rows });
  const buf = Buffer.alloc(data.length + 1);
  buf.writeUInt8(RESIZE_CHANNEL, 0);
  buf.write(data, 1);
  try {
    k8sWs.send(buf);
  } catch {
    /* ignore */
  }
}

// ---- HTTP + WebSocket server ----------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  const claims = verifyToken(url.searchParams.get('t'));
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (sessions.size >= MAX_SESSIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleSession(ws, claims));
});

async function handleSession(ws, claims) {
  const podName = `term-${sanitize(claims.sub)}-${crypto.randomBytes(4).toString('hex')}`;
  const sess = { ws, podName, k8sWs: null, idleTimer: null, maxTimer: null, closed: false };
  sessions.add(sess);
  log('session open', podName, 'user', claims.sub, 'role', claims.role, 'active', sessions.size);

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const cleanup = async (reason) => {
    if (sess.closed) return;
    sess.closed = true;
    clearTimeout(sess.idleTimer);
    clearTimeout(sess.maxTimer);
    sessions.delete(sess);
    try {
      sess.k8sWs?.close();
    } catch {
      /* ignore */
    }
    try {
      if (ws.readyState === 1) {
        send({ type: 'closed', reason });
        ws.close();
      }
    } catch {
      /* ignore */
    }
    await deletePod(podName);
    log('session closed', podName, 'reason', reason, 'active', sessions.size);
  };

  const resetIdle = () => {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = setTimeout(() => cleanup('idle-timeout'), IDLE_TIMEOUT_MS);
  };
  sess.maxTimer = setTimeout(() => cleanup('max-session-ttl'), MAX_SESSION_MS);
  resetIdle();

  ws.on('error', () => cleanup('ws-error'));
  ws.on('close', () => cleanup('client-disconnect'));

  // Spawn the sandbox Pod, then bridge a PTY into it.
  try {
    send({ type: 'status', message: 'provisioning sandbox…' });
    await core.createNamespacedPod({ namespace: SANDBOX_NAMESPACE, body: podManifest(podName, sanitize(claims.sub)) });
    await waitForRunning(podName, Date.now() + POD_READY_TIMEOUT_MS, (m) => send({ type: 'status', message: m }));
    send({ type: 'status', message: 'sandbox ready — attaching shell…' });

    const stdout = new StreamSink((chunk) => {
      if (ws.readyState === 1) ws.send(chunk); // binary frame = terminal output
    });
    const stdin = new StreamSource();

    const k8sWs = await exec.exec(
      SANDBOX_NAMESPACE,
      podName,
      'shell',
      SHELL,
      stdout, // stdout
      stdout, // stderr -> same sink
      stdin, // stdin
      true, // tty
      (status) => {
        // process exited inside the pod
        cleanup(`shell-exit:${status?.status || 'unknown'}`);
      },
    );
    sess.k8sWs = k8sWs;
    // Explicit "shell is attached" control frame: the client flips from its
    // provisioning state to a live terminal (and focuses it) on this signal.
    send({ type: 'ready' });

    ws.on('message', (data, isBinary) => {
      resetIdle();
      // Control messages arrive as JSON text frames; keystrokes as binary/text.
      if (!isBinary) {
        const s = data.toString('utf8');
        if (s.startsWith('{')) {
          try {
            const msg = JSON.parse(s);
            if (msg.type === 'resize' && msg.cols && msg.rows) {
              sendResize(k8sWs, msg.cols, msg.rows);
              return;
            }
            if (msg.type === 'stdin' && typeof msg.data === 'string') {
              stdin.push(Buffer.from(msg.data, 'utf8'));
              return;
            }
          } catch {
            /* fall through: treat as raw input */
          }
        }
        stdin.push(Buffer.from(s, 'utf8'));
        return;
      }
      stdin.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
  } catch (e) {
    const detail = e?.body?.message || e?.message || 'unknown error';
    log('session provisioning failed', podName, detail);
    // Surface the REAL reason (e.g. ImagePullBackOff) — a generic message hides
    // operator-fixable problems from the person staring at the terminal.
    send({ type: 'error', message: `failed to start sandbox: ${detail}` });
    await cleanup('provision-error');
  }
}

function sanitize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'user';
}

// Minimal Writable sink + Readable source so we don't pull in extra deps.
import { Writable, Readable } from 'node:stream';
class StreamSink extends Writable {
  constructor(onChunk) {
    super();
    this.onChunk = onChunk;
  }
  _write(chunk, _enc, cb) {
    try {
      this.onChunk(chunk);
    } catch {
      /* ignore */
    }
    cb();
  }
}
class StreamSource extends Readable {
  _read() {}
  push(buf) {
    super.push(buf);
  }
}

// ---- Janitor: reap orphaned sandbox pods past max TTL ----------------------
setInterval(async () => {
  try {
    const list = await core.listNamespacedPod({
      namespace: SANDBOX_NAMESPACE,
      labelSelector: 'app.kubernetes.io/component=terminal-sandbox',
    });
    const now = Date.now();
    for (const pod of list.items || []) {
      const started = new Date(pod.metadata?.creationTimestamp || now).getTime();
      const live = [...sessions].some((s) => s.podName === pod.metadata?.name);
      if (!live && now - started > MAX_SESSION_MS) {
        log('janitor reaping orphan', pod.metadata?.name);
        await deletePod(pod.metadata.name);
      }
    }
  } catch {
    /* best-effort */
  }
}, 120_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  log(`terminal-broker listening on :${PORT}${WS_PATH}`);
  log(`sandbox ns=${SANDBOX_NAMESPACE} image=${SANDBOX_IMAGE} idle=${IDLE_TIMEOUT_MS}ms maxttl=${MAX_SESSION_MS}ms`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('shutting down, reaping', sessions.size, 'sessions');
    await Promise.all([...sessions].map((s) => deletePod(s.podName)));
    process.exit(0);
  });
}
