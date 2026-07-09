import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { requireUser } from '@/lib/core/auth';
import { errorResponse } from '@/lib/data/server';

export const dynamic = 'force-dynamic';

const ASSETS_QUERY = `query {
  assetsOrError {
    __typename
    ... on AssetConnection { nodes { key { path } } }
    ... on PythonError { message }
  }
}`;

const RUNS_QUERY = `query {
  runsOrError(limit: 10) {
    __typename
    ... on Runs {
      results { runId status creationTime startTime endTime pipelineName }
    }
    ... on PythonError { message }
  }
}`;

async function gql(query: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.dagsterUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.errors) throw new Error(JSON.stringify(data.errors).slice(0, 200));
  return data?.data ?? {};
}

/**
 * Orchestration -> Dagster GraphQL (no auth locally). Lists the dbt-backed
 * assets and recent runs. If the GraphQL shape is unavailable we still return
 * the console link so the surface degrades gracefully.
 */
export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  let assets: string[] = [];
  let runs: {
    runId: string;
    status: string;
    pipeline: string;
    startTime: number | null;
  }[] = [];
  let assetsError = '';
  let runsError = '';

  try {
    const d = await gql(ASSETS_QUERY);
    const node = d.assetsOrError as Record<string, unknown>;
    const nodes = Array.isArray(node?.nodes) ? (node.nodes as Record<string, unknown>[]) : [];
    assets = nodes.map((n) => {
      const key = (n.key ?? {}) as Record<string, unknown>;
      const path = Array.isArray(key.path) ? (key.path as string[]) : [];
      return path.join('.');
    });
  } catch (e) {
    assetsError = (e as Error).message;
  }

  try {
    const d = await gql(RUNS_QUERY);
    const node = d.runsOrError as Record<string, unknown>;
    const results = Array.isArray(node?.results) ? (node.results as Record<string, unknown>[]) : [];
    runs = results.map((r) => ({
      runId: String(r.runId ?? ''),
      status: String(r.status ?? ''),
      pipeline: String(r.pipelineName ?? ''),
      startTime: typeof r.startTime === 'number' ? r.startTime : null,
    }));
  } catch (e) {
    runsError = (e as Error).message;
  }

  if (assetsError && runsError) {
    return NextResponse.json(
      { error: `Could not reach Dagster: ${assetsError}`, consoleUrl: config.dagsterConsoleUrl },
      { status: 502 },
    );
  }

  return NextResponse.json({
    assets,
    runs,
    assetsError,
    runsError,
    consoleUrl: config.dagsterConsoleUrl,
  });
}
