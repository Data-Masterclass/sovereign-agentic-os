/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import type { AppManifest, AppSurface, ConsumedResource, OpenApiSpec, ScaffoldFile, SurfaceDeclaration } from './model.ts';

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
  /** Explicit surface declaration; emitted only when set (intent wins over detect). */
  surface?: SurfaceDeclaration;
}): string {
  return yaml.dump(
    {
      apiVersion: 'software.sovereign-os/v1',
      kind: 'App',
      name: m.name,
      owner: m.owner,
      description: m.description,
      // Only write `surface` when the creator DECLARED one — an absent key keeps
      // the app on the heuristic (and the seed file byte-stable when undeclared).
      ...(m.surface ? { surface: m.surface } : {}),
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
  // Prefer an EXACT root match (e.g. the metadata `app.yaml`) over a suffix match
  // (e.g. a k8s `manifests/app.yaml`), so the convention file is never shadowed by
  // an unrelated repo file that merely shares a basename.
  return files.find((f) => f.path === path) ?? files.find((f) => f.path.endsWith(`/${path}`));
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
  let declaredSurface: SurfaceDeclaration | undefined;

  if (appYaml) {
    try {
      const doc = (yaml.load(appYaml.content) as Record<string, unknown>) ?? {};
      if (typeof doc.name === 'string' && doc.name.trim()) name = doc.name.trim();
      if (typeof doc.owner === 'string' && doc.owner.trim()) owner = doc.owner.trim();
      if (typeof doc.description === 'string') description = doc.description.trim();
      declaredSurface = asSurfaceDeclaration(doc.surface);
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

  return { name, owner, description, connections, data, knowledge, hasOpenApi, declaredSurface, missing };
}

/** Coerce an arbitrary `surface` value into a valid declaration, or undefined. */
function asSurfaceDeclaration(v: unknown): SurfaceDeclaration | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'ui' || s === 'api' || s === 'both' ? s : undefined;
}

/**
 * Read the app's EXPLICIT surface declaration from its `app.yaml` (`surface: ui|
 * api|both`), if present + valid. Returns undefined when no valid declaration is
 * committed, so the caller falls back to the `detectSurface` heuristic. Pure.
 */
export function parseSurfaceDeclaration(files: ScaffoldFile[]): SurfaceDeclaration | undefined {
  const appYaml = findFile(files, 'app.yaml') || findFile(files, 'app.yml');
  if (!appYaml) return undefined;
  try {
    const doc = (yaml.load(appYaml.content) as Record<string, unknown>) ?? {};
    return asSurfaceDeclaration(doc.surface);
  } catch {
    return undefined;
  }
}

/** A declaration → the concrete {ui,api} surface it commits the app to. */
export function surfaceFromDeclaration(decl: SurfaceDeclaration): AppSurface {
  if (decl === 'ui') return { ui: true, api: false };
  if (decl === 'api') return { ui: false, api: true };
  return { ui: true, api: true }; // 'both'
}

/**
 * Resolve the app's surface: INTENT WINS. When an explicit declaration is present
 * (from the manifest or an override — e.g. the `create_software` `surface` arg),
 * it is authoritative; otherwise the surface is inferred from the committed code
 * via `detectSurface`. This is the single source of truth for "what is this app".
 */
export function resolveSurface(files: ScaffoldFile[], override?: SurfaceDeclaration): AppSurface {
  const decl = override ?? parseSurfaceDeclaration(files);
  return decl ? surfaceFromDeclaration(decl) : detectSurface(files);
}

/**
 * Reconcile the app's KNOWLEDGE consumes edges to EXACTLY match `declares.knowledge`
 * (the app.yaml the owner committed). The declares block is AUTHORITATIVE for the
 * knowledge the app consumes: a re-commit that DROPS a knowledge ref must drop the
 * corresponding consumes/lineage edge, not just leave it dangling. Prior behaviour
 * only ever UNIONED (added) refs, so a removed knowledge ref left a stale `consumes`
 * edge that blocked deleting the now-unreferenced knowledge (the delete is lineage-
 * aware) and left inaccurate dependency metadata.
 *
 * SCOPE: knowledge edges ONLY. Data/connection/app-mcp consumes are recorded through
 * other governed paths (e.g. `consumeResource`, which also broadens deploy scope) and
 * are NOT reconciled away here — only the knowledge contract is declares-driven today.
 * Retained refs keep their existing label/scope; new refs get a default read grant.
 * Pure so it runs identically in the commit hook and in-process.
 */
export function reconcileKnowledgeConsumes(
  consumes: ConsumedResource[],
  declaredKnowledge: string[],
): ConsumedResource[] {
  const existingKnowledge = new Map(
    consumes.filter((c) => c.kind === 'knowledge').map((c) => [c.ref, c]),
  );
  // Everything that is NOT a knowledge edge is preserved untouched.
  const preserved = consumes.filter((c) => c.kind !== 'knowledge');
  // Rebuild the knowledge edges to exactly match declares: keep declared refs (with
  // their prior label/scope if we had them), add newly-declared refs, drop the rest.
  // De-dupe declared refs so a repeated ref in app.yaml yields one edge.
  const reconciled: ConsumedResource[] = [...new Set(declaredKnowledge)].map(
    (ref) => existingKnowledge.get(ref) ?? { kind: 'knowledge', ref, label: ref, scope: 'read' },
  );
  return [...preserved, ...reconciled];
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
  /** Match `content` of files whose path matches `where` (for code/config sniffing). */
  const contentMatches = (where: RegExp, re: RegExp) =>
    files.some((f) => where.test(f.path) && re.test(f.content));

  // 1. JS/TS web frameworks declared in package.json.
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

  // 2. Python (and other) UI frameworks declared in requirements.txt or any *.py.
  //    Streamlit / Gradio / Dash render a UI; Flask/FastAPI with server-side HTML
  //    templating (jinja2, `templates/`, `render_template`, mounted StaticFiles)
  //    also serve a frontend, so they read as UI too.
  const pyUiFramework =
    contentMatches(/(^|\/)requirements\.txt$/i, /\b(streamlit|gradio|dash|jinja2|flask)\b/i) ||
    contentMatches(/\.py$/i, /\b(streamlit|gradio|import\s+dash|from\s+dash|render_template|Jinja2Templates|StaticFiles)\b/);
  // 3. Server-rendered HTML / static asset trees (any language).
  const templatesOrStatic = hasPath(/(^|\/)(templates|static)\//i);
  // 4. A frontend file: an .html anywhere, a `public/` tree, or a page component.
  const frontendFile =
    hasPath(/\.html?$/i) ||
    hasPath(/(^|\/)public\//) ||
    hasPath(/(^|\/)(app|pages|src)\/.*(page|index|app)\.(t|j)sx?$/i);
  // 5. A container / compose that EXPOSEs a web port AND runs a UI serve command
  //    (streamlit run / gradio / uvicorn --host / next|vite|serve …). The `[\s",]+`
  //    between tokens matches BOTH shell form (`streamlit run`) and Docker exec
  //    form (`["streamlit", "run", …]`).
  const serveCmd = /\b(streamlit[\s",]+run|gradio|uvicorn\b[^\n]*--host|next[\s",]+start|vite[\s",]+preview|serve\b|http-server)\b/i;
  const dockerServesWeb =
    contentMatches(/(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i, /\bEXPOSE\b\s*\d|ports?:/i) &&
    contentMatches(/(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i, serveCmd);
  // 6. A UI start command in a Procfile / package scripts / shell entrypoint.
  const startCmd = contentMatches(/(^|\/)(Procfile|start\.sh|run\.sh|Makefile)$/i, serveCmd);

  const ui =
    webDep || pyUiFramework || templatesOrStatic || frontendFile || dockerServesWeb || startCmd;

  const api =
    parseOpenApi(files) !== null ||
    hasPath(/(^|\/)api\//) ||
    hasPath(/(^|\/)routes?\//) ||
    hasPath(/(^|\/)(main|server|app)\.py$/) ||
    contentMatches(/\.py$/i, /\b(FastAPI|APIRouter|@app\.(get|post|put|delete)|flask\.Flask|Flask\()/);

  // Nothing detected → headless API (the auto-MCP tool surface always exists).
  if (!ui && !api) return { ui: false, api: true };
  return { ui, api };
}

/** Default OpenAPI spec seeded for a fresh app so the auto-MCP has tools day one.
 *  GENERIC on purpose (a neutral `records` resource named after the app) — a new
 *  app has no domain model yet, so it must not claim one (the old seed put
 *  renewals endpoints into EVERY app). The build chat / commits replace it. */
export function defaultOpenApi(slug: string): string {
  const spec = {
    openapi: '3.0.0',
    info: { title: slug, version: '1.0.0' },
    paths: {
      '/records': {
        get: { operationId: 'list_records', summary: `List ${slug} records (read).` },
        post: { operationId: 'add_record', summary: `Add a ${slug} record (write).` },
      },
      '/records/{id}': {
        get: { operationId: 'get_record', summary: 'Get one record by id (read).' },
      },
      '/export': {
        post: { operationId: 'export_records', summary: 'Export records to a file (write).' },
      },
    },
  };
  return yaml.dump(spec, { lineWidth: 100 });
}
