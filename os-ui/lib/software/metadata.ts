/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import type { AppManifest, AppSurface, OpenApiSpec, ScaffoldFile } from './model.ts';

/**
 * Metadata fidelity (Software golden path — "commits always show up in the app").
 * Every app repo carries an `app.yaml` (name · owner · description · declared
 * connections/data/knowledge), `/.app/` docs, and an OpenAPI spec. A commit hook
 * / CI step parses these on EVERY push so the app page, the catalog and the
 * auto-MCP stay in sync no matter which front door authored the commit.
 *
 * This is the UNIVERSAL BACKSTOP: a raw `git push` or an imported/legacy repo
 * still flows through `parseAppManifest` here. What the parser can derive it
 * derives; what it cannot it lists in `missing` so the app page (or the build
 * chat) can prompt for the rest. Pure (no server imports) so it is unit-testable
 * and runnable both in the commit hook and in-process.
 */

/** The canonical app.yaml the in-app chat / Platform MCP write on every app. */
export function renderAppYaml(m: {
  name: string;
  owner: string;
  description: string;
  connections?: string[];
  data?: string[];
  knowledge?: string[];
}): string {
  return yaml.dump(
    {
      apiVersion: 'software.sovereign-os/v1',
      kind: 'App',
      name: m.name,
      owner: m.owner,
      description: m.description,
      declares: {
        connections: m.connections ?? [],
        data: m.data ?? [],
        knowledge: m.knowledge ?? [],
      },
    },
    { lineWidth: 100 },
  );
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function findFile(files: ScaffoldFile[], path: string): ScaffoldFile | undefined {
  return files.find((f) => f.path === path || f.path.endsWith(`/${path}`));
}

/** Parse an OpenAPI spec out of the repo files (openapi.yaml/json), if present. */
export function parseOpenApi(files: ScaffoldFile[]): OpenApiSpec | null {
  const f =
    findFile(files, 'openapi.yaml') ||
    findFile(files, 'openapi.yml') ||
    findFile(files, 'openapi.json') ||
    files.find((x) => /(^|\/)openapi\.(ya?ml|json)$/.test(x.path));
  if (!f) return null;
  try {
    const doc = f.path.endsWith('.json') ? JSON.parse(f.content) : (yaml.load(f.content) as unknown);
    const paths = (doc as { paths?: OpenApiSpec['paths'] })?.paths;
    if (paths && typeof paths === 'object') return { paths };
  } catch {
    /* malformed spec — treated as absent, flagged in `missing` */
  }
  return null;
}

/**
 * Parse the metadata convention from a repo's files. Returns a manifest plus a
 * `missing` list of fields that could not be derived (so an imported/legacy repo
 * is wrapped as a governed app and prompts for the rest, rather than failing).
 *
 * `fallback` supplies the name/owner the platform already knows (e.g. from
 * `create_software`) so a repo with no app.yaml still yields a usable manifest.
 */
export function parseAppManifest(
  files: ScaffoldFile[],
  fallback: { name: string; owner: string; description?: string },
): AppManifest {
  const missing: string[] = [];
  const appYaml = findFile(files, 'app.yaml') || findFile(files, 'app.yml');

  let name = fallback.name;
  let owner = fallback.owner;
  let description = fallback.description ?? '';
  let connections: string[] = [];
  let data: string[] = [];
  let knowledge: string[] = [];

  if (appYaml) {
    try {
      const doc = (yaml.load(appYaml.content) as Record<string, unknown>) ?? {};
      if (typeof doc.name === 'string' && doc.name.trim()) name = doc.name.trim();
      if (typeof doc.owner === 'string' && doc.owner.trim()) owner = doc.owner.trim();
      if (typeof doc.description === 'string') description = doc.description.trim();
      const declares = (doc.declares as Record<string, unknown>) ?? {};
      connections = asStringArray(declares.connections);
      data = asStringArray(declares.data);
      knowledge = asStringArray(declares.knowledge);
    } catch {
      missing.push('app.yaml (malformed — could not parse)');
    }
  } else {
    // No convention file — derive what we can, flag the rest (imported/legacy).
    missing.push('app.yaml');
    const readme = findFile(files, 'README.md');
    if (readme && !description) {
      const firstLine = readme.content.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      if (firstLine) description = firstLine.trim().slice(0, 280);
    }
    if (!description) missing.push('description');
  }

  const hasOpenApi = parseOpenApi(files) !== null;
  if (!hasOpenApi) missing.push('openapi spec (auto-MCP will expose no tools until added)');
  if (!findFile(files, '.app/decisions.md')) missing.push('.app/decisions.md');

  return { name, owner, description, connections, data, knowledge, hasOpenApi, missing };
}

/**
 * Detect the app's SURFACE from what was actually built (Software golden path —
 * surface inference). Pure over the repo files + deploy manifest, so it runs in
 * the commit hook and in-process at deploy. The create flow no longer asks "what
 * kind of app"; the agent writes the code and this reads it back:
 *
 *   • `ui`  — the app serves a frontend / HTML (a web framework in package.json,
 *             an .html file, a page/route component, or a static `public/` tree).
 *   • `api` — the app exposes API endpoints / an MCP tool surface (an OpenAPI
 *             spec, an `api/` or `routes/` tree, or a Python service entrypoint).
 *
 * A repo can have both (e.g. Next.js + OpenAPI). When nothing is detected the app
 * is treated as a headless API — every app at minimum exposes its governed MCP
 * tools — so the monitor always has one honest affordance to show.
 */
export function detectSurface(files: ScaffoldFile[]): AppSurface {
  const hasPath = (re: RegExp) => files.some((f) => re.test(f.path));

  let webDep = false;
  const pkg = findFile(files, 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
      webDep = ['next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', 'astro', 'vite', '@remix-run/react']
        .some((d) => d in deps);
    } catch {
      /* unparseable package.json — fall back to path signals below */
    }
  }
  const frontendFile =
    hasPath(/\.html?$/i) ||
    hasPath(/(^|\/)public\//) ||
    hasPath(/(^|\/)(app|pages|src)\/.*(page|index|app)\.(t|j)sx?$/i);
  const ui = webDep || frontendFile;

  const api =
    parseOpenApi(files) !== null ||
    hasPath(/(^|\/)api\//) ||
    hasPath(/(^|\/)routes?\//) ||
    hasPath(/(^|\/)(main|server|app)\.py$/);

  // Nothing detected → headless API (the auto-MCP tool surface always exists).
  if (!ui && !api) return { ui: false, api: true };
  return { ui, api };
}

/** Default OpenAPI spec seeded for a fresh app so the auto-MCP has tools day one. */
export function defaultOpenApi(slug: string): string {
  const spec = {
    openapi: '3.0.0',
    info: { title: slug, version: '1.0.0' },
    paths: {
      '/renewals': {
        get: { operationId: 'list_renewals', summary: 'List contract renewals (read).' },
        post: { operationId: 'add_renewal', summary: 'Add a contract renewal (write).' },
      },
      '/renewals/{id}': {
        get: { operationId: 'get_renewal', summary: 'Get one renewal by id (read).' },
      },
      '/export': {
        post: { operationId: 'export_renewals', summary: 'Export renewals to a file (write).' },
      },
    },
  };
  return yaml.dump(spec, { lineWidth: 100 });
}
