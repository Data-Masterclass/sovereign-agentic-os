/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

type Repo = {
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
};

type Run = {
  id: number;
  name: string;
  status: string;
  branch: string;
  sha: string;
  event: string;
  title: string;
  runNumber: number;
  workflow: string;
  createdAt: string | null;
  url: string;
};

function authHeader(): string {
  const token = Buffer.from(
    `${config.forgejoUser}:${config.forgejoPassword}`,
  ).toString('base64');
  return `Basic ${token}`;
}

async function forgejo(path: string): Promise<unknown> {
  const res = await fetch(`${config.forgejoUrl}/api/v1${path}`, {
    headers: { authorization: authHeader(), accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Forgejo ${res.status} on ${path}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function forgejoWrite(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${config.forgejoUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    /* non-JSON body left in raw */
  }
  return { ok: res.ok, status: res.status, data, raw };
}

/**
 * Software / Delivery -> Forgejo.
 *
 *  GET  -> list repos + the demo-app's recent CI runs (push -> CI -> deploy).
 *  POST -> create a NEW repo (real action: Forgejo `POST /user/repos`) and seed
 *          a starter Dockerfile, a Forgejo Actions CI workflow, and a k8s
 *          manifest for Argo CD. Credentials stay server-side (HTTP basic auth).
 */
export async function GET() {
  const owner = config.forgejoRepoOwner;
  const demo = config.forgejoDemoRepo;
  try {
    const search = (await forgejo('/repos/search?limit=30')) as {
      data?: Record<string, unknown>[];
    };
    const repos: Repo[] = (search.data ?? []).map((r) => ({
      name: String(r.name ?? ''),
      fullName: String(r.full_name ?? ''),
      description: String(r.description ?? ''),
      private: Boolean(r.private),
      defaultBranch: String(r.default_branch ?? 'main'),
      updatedAt: (r.updated_at as string) ?? null,
    }));

    let runs: Run[] = [];
    let runsError = '';
    try {
      const tasks = (await forgejo(
        `/repos/${owner}/${demo}/actions/tasks`,
      )) as { workflow_runs?: Record<string, unknown>[] };
      runs = (tasks.workflow_runs ?? []).map((w) => ({
        id: Number(w.id ?? 0),
        name: String(w.name ?? ''),
        status: String(w.status ?? 'unknown'),
        branch: String(w.head_branch ?? ''),
        sha: String(w.head_sha ?? '').slice(0, 8),
        event: String(w.event ?? ''),
        title: String(w.display_title ?? ''),
        runNumber: Number(w.run_number ?? 0),
        workflow: String(w.workflow_id ?? ''),
        createdAt: (w.created_at as string) ?? null,
        url: String(w.url ?? ''),
      }));
    } catch (e) {
      runsError = (e as Error).message;
    }

    return NextResponse.json({
      repos,
      demo: { owner, repo: demo },
      runs,
      runsError,
      consoleUrl: config.forgejoConsoleUrl,
      argocdUrl: config.argocdUrl,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Forgejo: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function starterFiles(name: string, description: string) {
  // README.md is omitted here — auto_init already creates one; seeding it again
  // would 422 (already exists). We seed the files Forgejo's auto-init does not.
  void description;
  const dockerfile = `# Starter Dockerfile — Sovereign Agentic OS software scaffold\nFROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node", "server.js"]\n`;
  const ci = `name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Build container image\n        run: echo "build ${name} image here (kaniko/buildah)"\n`;
  const manifest = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  labels: { app: ${name} }\nspec:\n  replicas: 1\n  selector: { matchLabels: { app: ${name} } }\n  template:\n    metadata: { labels: { app: ${name} } }\n    spec:\n      containers:\n        - name: ${name}\n          image: forgejo-http:3000/${config.forgejoRepoOwner}/${name}:latest\n          ports: [{ containerPort: 8080 }]\n`;
  return [
    { path: 'Dockerfile', content: dockerfile },
    { path: '.forgejo/workflows/ci.yml', content: ci },
    { path: 'manifests/app.yaml', content: manifest },
  ];
}

export async function POST(req: Request) {
  let name = '';
  let description = '';
  let priv = false;
  try {
    const body = await req.json();
    name = slug((body?.name ?? '').toString());
    description = (body?.description ?? '').toString().trim().slice(0, 240);
    priv = Boolean(body?.private);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: 'A repository name is required' }, { status: 400 });
  }

  // Real action #1: create the repository (auto_init so a default branch + tree
  // exists, which the contents API needs to seed files).
  const create = await forgejoWrite('/user/repos', {
    name,
    description: description || 'Scaffolded by the Sovereign Agentic OS',
    private: priv,
    auto_init: true,
    default_branch: 'main',
  });
  if (!create.ok) {
    return NextResponse.json(
      { error: `Forgejo could not create repo: ${create.status} ${create.raw.slice(0, 200)}` },
      { status: create.status === 409 ? 409 : 502 },
    );
  }

  const owner = config.forgejoRepoOwner;
  // Real action #2: seed the starter files (Dockerfile / CI / manifest) so
  // Forgejo Actions can build and Argo CD has a manifest to sync.
  const seeded: string[] = [];
  const seedErrors: string[] = [];
  for (const f of starterFiles(name, description)) {
    const r = await forgejoWrite(`/repos/${owner}/${name}/contents/${f.path}`, {
      content: b64(f.content),
      message: `seed ${f.path}`,
      branch: 'main',
    });
    if (r.ok) seeded.push(f.path);
    else seedErrors.push(`${f.path}: ${r.status}`);
  }

  const fullName = String(create.data?.full_name ?? `${owner}/${name}`);
  return NextResponse.json({
    created: true,
    repo: {
      name,
      fullName,
      htmlUrl: String(create.data?.html_url ?? `${config.forgejoConsoleUrl}/${fullName}`),
    },
    seeded,
    seedErrors,
  });
}
