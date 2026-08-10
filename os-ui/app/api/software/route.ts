/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listRepos, createRepo } from '@/lib/software/repos';

export const dynamic = 'force-dynamic';

/**
 * Software / Delivery -> Forgejo.
 *
 *  GET  -> list repos + the demo-app's recent CI runs (push -> CI -> deploy).
 *  POST -> create a NEW repo (real action: Forgejo `POST /user/repos`) and seed
 *          a starter Dockerfile, a Forgejo Actions CI workflow, and a k8s
 *          manifest for Argo CD. Credentials stay server-side (HTTP basic auth).
 *
 * The Forgejo client + scaffold logic lives in lib/software/repos.ts; this route
 * keeps only the auth gate, request parse, and response shaping.
 */
export async function GET() {
  // Requires a session: this listing carries private repo names/descriptions.
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }

  const { status, body } = await listRepos(user);
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // Requires a session: this creates a real Forgejo repo and writes files as the
  // platform service account — never allow an anonymous caller to do that.
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }

  let name: unknown;
  let description: unknown;
  let priv: unknown;
  try {
    const body = await req.json();
    name = body?.name;
    description = body?.description;
    priv = body?.private;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, body } = await createRepo(name, description, priv);
  return NextResponse.json(body, { status });
}
