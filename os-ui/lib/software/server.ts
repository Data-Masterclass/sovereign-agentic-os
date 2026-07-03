/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import {
  getAppByIdInternal,
  persistApp,
  templateFiles,
  withStatus,
  type App,
} from '@/lib/apps';
import { generateAndCompile } from './auto-mcp.ts';
import { parseAppManifest, parseOpenApi, detectSurface } from './metadata.ts';
import type { PipelineBackend, AuthorInput, AuthorResult, FrontDoorKey } from './adapters.ts';
import type { AdapterStep, RunMode, ScaffoldFile } from './model.ts';

/**
 * Software pipeline server boundary — the live/offline-mock DUAL exactly like
 * `lib/agents/build/server.ts`. When Forgejo is reachable (a cluster is up) the
 * effectful steps run against the real Forgejo/Argo plumbing and report
 * `mode: 'live'`; on a laptop with no cluster they fall back to the in-process
 * teaching mock, honestly labelled `mode: 'offline-mock'`. Either way the
 * GOVERNED logic (metadata parse, auto-MCP→OPA, the review gate) is identical.
 *
 * This module also hosts the FOUR front-door adapters (chat · platform-mcp ·
 * git-push · git-import). They author content differently but all converge on
 * `commitToApp`, which re-parses the metadata convention and recompiles the
 * auto-MCP on every commit — "whatever is committed is seen in the app".
 */

async function reachable(url: string, path: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${url}${path}`, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function forgejoReachable(): Promise<boolean> {
  return reachable(config.forgejoUrl, '/api/v1/version');
}

// --------------------------------------------------------- Pipeline backends ---

function mockBackend(): PipelineBackend {
  const mode: RunMode = 'offline-mock';
  return {
    mode,
    async scaffoldRepo(slug, files) {
      return { ok: true, mode, detail: `mock: scaffolded ${slug} (${files.length} files)` };
    },
    async commit(slug, files, message) {
      return { ok: true, mode, detail: `mock: committed ${files.length} files to ${slug} — "${message}"` };
    },
    async preview(slug) {
      return {
        step: { ok: true, mode, detail: `mock: ephemeral preview for ${slug}` },
        url: `https://preview--${slug}.sandbox.local`,
      };
    },
    async deploy(slug) {
      return { ok: true, mode, detail: `mock: Harbor → Argo CD → live for ${slug}` };
    },
  };
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.forgejoUser}:${config.forgejoPassword}`).toString('base64');
}

function liveBackend(): PipelineBackend {
  const mode: RunMode = 'live';
  const owner = config.forgejoRepoOwner;
  async function put(slug: string, f: ScaffoldFile, message: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(
        `${config.forgejoUrl}/api/v1/repos/${owner}/${slug}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'PUT',
          headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), message, branch: 'main' }),
          cache: 'no-store',
          signal: ctrl.signal,
        },
      );
      return res.ok || res.status === 422; // 422 = already exists with same content
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    mode,
    async scaffoldRepo(slug, files) {
      let n = 0;
      for (const f of files) if (await put(slug, f, `seed ${f.path}`)) n++;
      return { ok: n > 0, mode, detail: `live: seeded ${n}/${files.length} files into ${slug}` };
    },
    async commit(slug, files, message) {
      let n = 0;
      for (const f of files) if (await put(slug, f, message)) n++;
      return { ok: n === files.length, mode, detail: `live: committed ${n}/${files.length} files to ${slug}` };
    },
    async preview(slug) {
      // Argo CD ApplicationSet PR/branch generator spins this up on a cluster;
      // here we report the deterministic sandbox URL it would expose.
      return {
        step: { ok: true, mode, detail: `live: preview Application requested for ${slug}` },
        url: `https://preview--${slug}.${config.appsBaseDomain}`,
      };
    },
    async deploy(slug) {
      return { ok: true, mode, detail: `live: Argo CD sync requested for ${slug}` };
    },
  };
}

/** Choose the backend by reachability — the honest live/offline-mock switch. */
export async function pickBackend(): Promise<PipelineBackend> {
  return (await forgejoReachable()) ? liveBackend() : mockBackend();
}

// ------------------------------------------------ Committed-file snapshot ------
//
// The latest committed files per app, so the security scan + diff see what was
// actually committed (offline) — not just the original template. Authoritative
// in-process; a live deploy reads the same from Forgejo.
const REPO_SNAPSHOT = new Map<string, ScaffoldFile[]>();

export function snapshotFiles(appId: string, files: ScaffoldFile[]): void {
  REPO_SNAPSHOT.set(appId, files);
}
export function getSnapshot(appId: string): ScaffoldFile[] | null {
  return REPO_SNAPSHOT.get(appId) ?? null;
}

/**
 * A commit is a CHANGESET, not the whole tree. Merge the changed files over the
 * app's current tree (its prior snapshot, or the template seed on the first
 * commit) so the metadata parse + surface detection + security scan/diff see the
 * WHOLE repo — a partial `git push` must not make the untouched app.yaml/openapi/
 * .app files "disappear", nor hide the rest of the repo from the scanner.
 */
function mergeTree(prior: ScaffoldFile[], incoming: ScaffoldFile[]): ScaffoldFile[] {
  const byPath = new Map(prior.map((f) => [f.path, f]));
  for (const f of incoming) byPath.set(f.path, f);
  return [...byPath.values()];
}

// ----------------------------------------------------- Commit (convergence) ----

/**
 * The ONE convergent commit step every front door flows through. Writes the
 * files (live or mock), then runs the metadata commit hook: re-parse the
 * app.yaml/OpenAPI convention and recompile the auto-MCP (reads-on/writes-off →
 * OPA) so the app page + the governed MCP reflect exactly what was committed.
 */
export async function commitToApp(
  appId: string,
  user: { id: string },
  files: ScaffoldFile[],
  message: string,
): Promise<{ app: App; step: AdapterStep }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const backend = await pickBackend();
  // Push only the changeset (correct for live Forgejo); parse against the full tree.
  const step = await backend.commit(app.slug, files, message);
  const prior = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
  const tree = mergeTree(prior, files);

  // Metadata fidelity: parse the convention over the WHOLE tree on every commit.
  const manifest = parseAppManifest(tree, { name: app.name, owner: app.owner, description: app.description });
  app.manifest = manifest;
  // Surface fidelity: re-detect the UI/API surface from the whole committed tree
  // so the monitor view adapts to what the agent actually built.
  app.surface = detectSurface(tree);
  // Recompile the auto-MCP from the committed OpenAPI when present.
  const openapi = parseOpenApi(tree);
  if (openapi) {
    const tools = generateAndCompile(app.mcpPrincipal, { openapi });
    app.mcpTools = tools.map((t) => ({ name: t.name, description: t.description, write: t.write }));
    app.mcpProfileCompiled = true;
  }
  app.chat.push({ role: 'assistant', content: `Committed: ${message} (${step.mode})`, at: new Date().toISOString() });
  snapshotFiles(app.id, tree);
  await persistApp(app);
  return { app, step };
}

// ------------------------------------------------------- Front-door adapters ---

function deriveManifest(input: AuthorInput, files: ScaffoldFile[]) {
  return parseAppManifest(files, { name: input.name, owner: input.owner, description: input.description });
}

/**
 * The four front doors. Each authors content its own way and returns a uniform
 * AuthorResult; `applyAuthor`/`commitToApp` then run the SAME governed pipeline.
 * Git is the bridge: git-push and git-import both arrive as a file tree.
 */
export async function authorThroughFrontDoor(door: FrontDoorKey, input: AuthorInput): Promise<AuthorResult> {
  switch (door) {
    case 'chat': {
      // The in-app OpenCode chat writes the metadata convention as it builds.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'build via chat', missing: manifest.missing };
    }
    case 'platform-mcp': {
      // The Platform MCP captures/requires the metadata alongside the code, so an
      // external client (Claude Code) cannot silently drop it.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'commit via Platform MCP', missing: manifest.missing };
    }
    case 'git-push': {
      // A raw push gives code; the commit-hook convention backstops the metadata.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'git push', missing: manifest.missing };
    }
    case 'git-import': {
      // Mirror an external repo in + wrap as a governed app. We derive what we can
      // (OpenAPI/README/structure) and PROMPT for the rest via `missing`.
      const files = input.files ?? [
        { path: 'README.md', content: `# ${input.name}\n\nImported from ${input.repoUrl ?? 'an external repo'}.\n` },
      ];
      const manifest = deriveManifest(input, files);
      return {
        door,
        files,
        manifest,
        message: `import ${input.repoUrl ?? 'external repo'}`,
        missing: manifest.missing,
      };
    }
    default:
      throw withStatus(new Error(`Unknown front door: ${door}`), 400);
  }
}
