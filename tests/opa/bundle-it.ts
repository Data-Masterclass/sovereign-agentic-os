/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Shared support for the bundle integration tests (WP-11): start a chart-rendered OPA container,
 * and serve os-ui's REAL bundle and status route handlers on a host port, so OPA downloads the
 * bundles from the shipped code exactly as it does from the os-ui Service in the cluster.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const TOKEN = process.env.OPA_IT_TOKEN ?? 'wp11-it-token';

export function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export const docker = (...args: string[]) => sh('docker', args);

/** The chart's os-ui env value (tests/opa/chart-env.py). */
export function chartEnv(name: string, sets: string[] = []): string {
  return sh('python3', [`${HERE}chart-env.py`, name, ...sets.flatMap((s) => ['--set', s])]);
}

/** Start the chart's OPA in a container (tests/opa/run-chart-opa.py) with helm `--set`s. */
export function startChartOpa(name: string, port: number, sets: string[]): void {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  sh('python3', [`${HERE}run-chart-opa.py`, name, String(port), ...sets.flatMap((s) => ['--set', s])], {
    OPA_IT_TOKEN: TOKEN,
    OPA_IT_DOCKER_ARGS: '--add-host=host.docker.internal:host-gateway',
  });
}

export async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, stepMs = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined as T);
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export class Opa {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  async status(path = '/health?bundles'): Promise<number> {
    try {
      return (await fetch(`${this.url}${path}`)).status;
    } catch {
      return 0;
    }
  }
  async data(path: string): Promise<unknown> {
    const body = (await (await fetch(`${this.url}/v1/data/${path}`)).json()) as { result?: unknown };
    return body.result;
  }
  async eval(path: string, input: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}/v1/data/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
    if (!res.ok) throw new Error(`OPA ${path} ${res.status}`);
    return ((await res.json()) as { result?: unknown }).result;
  }
  async put(path: string, value: unknown): Promise<{ status: number; body: string }> {
    const res = await fetch(`${this.url}/v1/data/${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    return { status: res.status, body: await res.text() };
  }
}

type Handler = (req: Request) => Promise<Response>;
export type BundleServer = {
  port: number;
  requests: { path: string; status: number; at: number }[];
  /** While set, every request answers this status (a bundle-server outage). */
  outage: number | null;
  close(): Promise<void>;
};

/** Serve os-ui's bundle + status routes on `port` (0.0.0.0, reachable from the containers). */
export async function startBundleServer(port: number): Promise<BundleServer> {
  const dataRoute = await import('../../os-ui/app/api/opa/bundles/os-data.tar.gz/route.ts');
  const grantsRoute = await import('../../os-ui/app/api/opa/bundles/os-grants.tar.gz/route.ts');
  const statusRoute = await import('../../os-ui/app/api/opa/status/route.ts');
  const routes: Record<string, Partial<Record<string, Handler>>> = {
    '/api/opa/bundles/os-data.tar.gz': { GET: dataRoute.GET },
    '/api/opa/bundles/os-grants.tar.gz': { GET: grantsRoute.GET },
    '/api/opa/status': { POST: statusRoute.POST, GET: statusRoute.GET },
  };
  const state: BundleServer = { port, requests: [], outage: null, close: async () => {} };
  const srv: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let out: Response;
    if (state.outage !== null) out = new Response('outage', { status: state.outage });
    else {
      const h = routes[path]?.[req.method ?? 'GET'];
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      out = h
        ? await h(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        : new Response('not found', { status: 404 });
    }
    state.requests.push({ path, status: out.status, at: Date.now() });
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => srv.listen(port, '0.0.0.0', () => r()));
  state.close = () => new Promise<void>((r) => {
    srv.closeAllConnections();
    srv.close(() => r());
  });
  return state;
}

/** An empty but complete OpenSearch mirror (every store hydrates from it, with zero records). */
export async function fakeEmptyMirror(): Promise<void> {
  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (b: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    req.resume();
    req.on('end', () => {
      if (url.includes('/_count')) return send({ count: 0 });
      if (url.includes('/_search')) return send({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } });
      return send({ result: 'ok', acknowledged: true });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  srv.unref();
  process.env.OPENSEARCH_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}
